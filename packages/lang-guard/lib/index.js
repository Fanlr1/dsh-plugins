// dsh-plugin-lang-guard -- 思维链语言自检（内嵌到 DSH 运行时）
//
// ── 为什么需要它 ──
// 主 agent 的思维链会漂成英文，而「凭感觉自查」在机理上就无效：
//   自检与被检同源 —— 如果已经在用英文思考，那「扫一眼自己」这个动作
//   本身也是在英文语境里完成的，检测不到异常。
// 2026-10-04 实测本会话：有 5 轮的思维链汉字占比是 0~8%，而我当时以为自己在用中文。
// ⇒ 必须【外部观测】。本插件把观测内嵌进运行时，不再依赖 agent 记得手动跑脚本。
//
// ── 做什么（V1：只读 + 记录，绝不干预生成）──
//   挂 `agent/turn-stopping` → 聚合【本回合全部 step】的 reasoning 块
//   → 算汉字占比 → 落盘日志 + 状态文件
//
// ── 与 empty-turn-guard 的关键区别 ──
//   它只读 `readLastStepAssistantMessage`（最后一步）。
//   但一个回合里 agent 可能调 10 次工具 ⇒ 10 个 step ⇒ 只读最后一步样本会被切碎。
//   本插件聚合【整个 turn】的所有 assistant/message 事件。
//
// ── V2（预留，默认关闭）──
//   严重漂移时用 agent.steer 注入中文提醒。
//   ⚠️ 未启用：steer 会【触发额外一轮生成】，必须先验证收益大于成本。
//   开启前需要：① 确认 V1 的检测准确 ② 设计好限流（阈值/冷却/每会话上限）
//
// ── API 依据（都是从 empty-turn-guard 的可用实现里抄的，非猜测）──
//   · ctx.on('agent/turn-stopping', handler)   payload = { agent, turn }
//   · agent.session.snapshotEvents()           平台已标 deprecated 但可用
//   · event = { type:'assistant/message', data:{ turn, step, message } }
//   · message.content = [ {type:'reasoning',text}, {type:'text',text}, {type:'tool-call'} ]
//
// ── 防御纪律 ──
//   看护层自己的异常绝不能影响宿主 —— 所有读取都 try/catch，失败即静默放行。
//   不 steer、不改消息、不改配置，V1 对生成过程【零副作用】。

import { appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'lang-guard';

/** 无依赖注入：只用 ctx.on / ctx.logger。 */
export const inject = [];

/** 日志文件：默认 ~/.dsh/lang-guard.log，可用 DSH_LANG_GUARD_LOG 覆盖。 */
const LOG_FILE = process.env.DSH_LANG_GUARD_LOG || join(homedir(), '.dsh', 'lang-guard.log');

/** 状态文件路径（导出：外部工具如 now.cmd 会读它来附带显示语言状态）。 */
/** 状态文件：默认 ~/.dsh/lang-status.json，可用 DSH_LANG_GUARD_STATUS 覆盖。 */
export const STATUS_FILE = process.env.DSH_LANG_GUARD_STATUS || join(homedir(), '.dsh', 'lang-status.json');

/** 阈值（汉字占「汉字+拉丁字母」的比例） */
export const THRESHOLD_BAD = 0.2;   // < 20% 严重漂移
export const THRESHOLD_WARN = 0.5;  // < 50% 中英混杂

/**
 * 统一日志：apply() 里绑定 ctx.logger，之后每条记录【同时】进统一日志与自己的文件。
 *
 * 为什么双写（2026-10-06）：
 *   dsh-plugin-runtime-log 把 DSH 全系统日志汇到一个文件，本不该再各写各的。
 *   但它属新装、尚未重启验证；若先删掉文件写入而统一日志又没生效，就一条都留不下。
 *   确认统一日志收得到本插件的记录后，设 DSH_PLUGIN_LOGFILE=off 即可关掉文件。
 * 原先 apply() 里是「logger.xxx?.() + fileLog()」手写两遍，容易漏；现在收进这里一处。
 */
let ctxLogger = null;

function fileLog(msg, level) {
  // ① 统一日志
  try {
    if (ctxLogger) {
      const lg = typeof ctxLogger === 'function' ? ctxLogger('lang-guard') : ctxLogger;
      const fn = (level && lg && lg[level]) || (lg && lg.info);
      if (typeof fn === 'function') fn.call(lg, '[lang-guard] ' + msg);
    }
  } catch (e) { /* 绝不外抛 */ }

  // ② 自己的文件 —— 安全网
  if (process.env.DSH_PLUGIN_LOGFILE === 'off') return;
  try {
    appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf8');
  } catch (e) { /* 静默 */ }
}

// ────────────────────────── 纯函数（可离线单测） ──────────────────────────

/**
 * 读会话事件；任何读取失败都当作空数组 —— 看护层不能因为读不到历史就把会话搞挂。
 * @param session - agent 的会话
 * @returns 事件数组；读不到时为空数组
 */
export function readEventsSafely(session) {
  try {
    if (session === null || typeof session !== 'object') return [];
    if (typeof session.snapshotEvents !== 'function') return [];
    const events = session.snapshotEvents();
    return Array.isArray(events) ? events : [];
  } catch (e) {
    return [];
  }
}

/**
 * 把消息里某一类内容块拼成一段文本；块之间用换行分隔。
 * @param message - assistant 消息
 * @param blockType - 'reasoning' | 'text' | 'tool-call'
 */
export function joinBlocks(message, blockType) {
  if (message === null || typeof message !== 'object') return '';
  const content = message.content ?? [];
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || block.type !== blockType) continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * ★ 聚合【整个回合】所有 step 的 reasoning 文本。
 * 这是与 empty-turn-guard 的关键区别：它只取最后一步，样本会被工具调用切碎。
 *
 * @param session - agent 的会话
 * @param turn - 回合号
 * @returns 该回合全部 reasoning 文本（换行拼接）；没有则返回空串
 */
export function collectTurnReasoning(session, turn) {
  const parts = [];
  for (const event of readEventsSafely(session)) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type !== 'assistant/message') continue;
    if (event.data === null || typeof event.data !== 'object') continue;
    if (event.data.turn !== turn) continue;
    const text = joinBlocks(event.data.message, 'reasoning');
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

/**
 * 统计汉字与拉丁字母，算汉字占比。
 * 用「汉字 / (汉字+拉丁字母)」而不是「汉字 / 总字符」——
 * 因为标点、空格、代码符号不该稀释指标：一段纯中文带标点仍是中文。
 *
 * @param text - 待测文本
 * @returns {{cjk:number, latin:number, ratio:number, chars:number}}
 */
export function measureLanguage(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { cjk: 0, latin: 0, ratio: 0, chars: 0 };
  }
  const cjkMatches = text.match(/[\u4e00-\u9fff]/g);
  const latinMatches = text.match(/[A-Za-z]/g);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  const latin = latinMatches ? latinMatches.length : 0;
  const total = cjk + latin;
  return { cjk, latin, ratio: total > 0 ? cjk / total : 0, chars: text.length };
}

/**
 * 按阈值分级。
 * @param ratio - 汉字占比
 * @returns 'bad' | 'warn' | 'ok'
 */
export function classify(ratio) {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) return 'ok';
  if (ratio < THRESHOLD_BAD) return 'bad';
  if (ratio < THRESHOLD_WARN) return 'warn';
  return 'ok';
}

// ────────────────────────── 钩子 ──────────────────────────

/**
 * 回合收尾时的观测（只读，零副作用）。
 * @param payload - agent/turn-stopping 的载荷 { agent, turn }
 * @param seen - WeakMap<agent, turn>，用于跳过同一回合的重复触发
 */
export function observeTurn(payload, seen) {
  if (payload === null || typeof payload !== 'object') return null;

  const agent = payload.agent;
  if (agent === null || typeof agent !== 'object') return null;

  const turn = payload.turn ?? 0;

  // 同一回合可能触发多次收尾判定（如 steer 之后再次收尾）——只记第一次，
  // 否则 steer 产生的短回合会把统计搅乱。
  if (seen.get(agent) === turn) return null;
  seen.set(agent, turn);

  const text = collectTurnReasoning(agent.session, turn);
  const m = measureLanguage(text);
  const level = classify(m.ratio);
  const pct = (m.ratio * 100).toFixed(1);

  fileLog(
    'turn=' + turn + ' [' + level + '] 汉字=' + m.cjk +
    ' 拉丁=' + m.latin + ' 占比=' + pct + '% 推理长度=' + text.length
  );

  const status = {
    turn,
    level,
    pct: Number(pct),
    ratio: Number(m.ratio.toFixed(4)),
    cjk: m.cjk,
    latin: m.latin,
    reasoningChars: text.length,
    at: new Date().toISOString(),
  };

  // 状态文件：供外部工具（如 now.cmd）读取并附带显示。
  // 只保留最后一次，覆盖写 —— 它表达的是「当前状态」而非历史。
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), 'utf8');
  } catch (e) { /* 静默 */ }

  return status;
}

/**
 * 插件入口。
 * @param ctx - cordis 上下文
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console;

  // 绑定统一日志（见文件上方 fileLog 的说明）。必须在第一条 fileLog 之前。
  try {
    if (ctx && ctx.logger) ctxLogger = ctx.logger;
  } catch (e) { /* 拿不到就只写自己的文件 */ }

  fileLog('=== apply() 被调用，开始挂载 (V1: 只读观测) ===');
  fileLog('统一日志: ' + (ctxLogger ? '已绑定 ctx.logger' : '★ 未绑定，只写本地文件'));

  if (typeof ctx.on !== 'function') {
    try { logger.warn?.('[lang-guard] ctx.on 不可用，未挂载'); } catch (e) { /* 静默 */ }
    fileLog('ctx.on 不可用，未挂载');
    return;
  }

  /** 每个 agent 的已记录回合（WeakMap：agent 回收时自动消失，不用手工清理）。 */
  const seen = new WeakMap();

  try {
    ctx.on('agent/turn-stopping', async (payload) => {
      try {
        observeTurn(payload, seen);
      } catch (error) {
        // 看护层自己的异常绝不能挡住回合收尾 —— 出错就什么都不做。
        try { logger.error?.('[lang-guard] 观测异常，已忽略', error); } catch (e) { /* 静默 */ }
      }
    });
    fileLog('已挂载 agent/turn-stopping（V1 只记录，不 steer）');
  } catch (e) {
    try { logger.warn?.('[lang-guard] 注册钩子失败: ' + (e && e.message)); } catch (e2) { /* 静默 */ }
    fileLog('注册钩子失败: ' + (e && e.message));
  }
}
