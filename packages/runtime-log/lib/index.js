// dsh-plugin-runtime-log -- 把 DSH 全系统日志落盘
//
// 【为什么需要】
//   DSH 不产生任何日志文件（实测：~\.dsh\logs / %APPDATA%\DeepSeek Harness\logs /
//   %LOCALAPPDATA%\... / ~\.dsh\dsh.log 全部不存在）。后果是：
//     · 插件加载失败【完全静默】—— 不报错、不提示，插件就是"不在"
//     · 出错后没有任何可查的证据，只能靠猜
//
// 【根因（读 cordis/src/logger.ts 源码确认）】
//   DSH 里所有子系统【都在调 logger】—— 插件加载、agent 循环、工具、LLM 调用……
//   全部经过 cordis 的 LoggerService。而 LoggerService 里【只注册了一个 exporter】：
//
//       self.exporter({
//           colors: 3,
//           export: (message) => {
//               self.buffer.push(message)              // ← 只进内存
//               if (self.buffer.length > self.bufferSize) {
//                   self.buffer = self.buffer.slice(-self.bufferSize)   // 1000 条环形
//               }
//           },
//       })
//
//   ⇒ 日志【全都在】，只是【没接到磁盘】。重启即失忆，被挤掉的更早记录也永久消失。
//
// 【本插件的做法】
//   注册【第二个】exporter，把同一条流水线上的记录写到文件。
//   这比"每个插件各自 fs.appendFile"强得多：
//     · 覆盖 DSH 全系统，不只是主动写了日志的那几个插件
//     · 【插件加载失败也看得见】—— 那条 error 是 DSH 自己发的，不依赖那个插件活着
//     · 结构化字段（sn / ts / name / type / level）可以按子系统调阈值
//     · 启动时能把内存 buffer 里已有的记录一起 dump 出来，补上"本插件加载之前"的历史
//
// 【Message 的形状（源码 logger.ts）】
//   interface Message {
//     sn: number; ts: number
//     name: string        // = hyphenate(fiber.name) ⇒ 就是插件/子系统名
//     type: 'error' | 'info' | 'warn' | 'debug'
//     level: number       // ERROR=0 < INFO=1 < WARN=2 < DEBUG=3
//     args: any[]
//     fiber?: WeakRef<Fiber>
//   }
//   注意过滤方向：`if (targetLevel < level) continue` —— 所以 levels.default 要给 3 才全收。
//
// 【为什么每条都同步落盘（appendFileSync）而不开 fd 缓冲】
//   这个插件存在的意义就是【崩溃后还能查到最后的记录】。开缓冲或节流都会丢掉最后几条，
//   而那恰恰是最有价值的部分。日志量不大，同步写的代价可以接受。
//
// 【错误隔离】
//   跑在 DSH 宿主进程内 —— 任何未捕获异常都可能影响宿主。
//   所以：目录建不了 / 写失败 / 轮转失败，一律只吞掉，绝不外抛。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'runtime-log';
export const inject = [];

// ---------------------------------------------------------------- 配置
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const LOG_DIR = path.join(DSH_HOME, 'logs');
const MAIN_LOG = path.join(LOG_DIR, 'dsh-runtime.log');
const ERR_LOG = path.join(LOG_DIR, 'dsh-runtime-errors.log');

const MAX_BYTES = Number(process.env.DSH_RUNTIME_LOG_MAX_BYTES) > 0
  ? Number(process.env.DSH_RUNTIME_LOG_MAX_BYTES)
  : 10 * 1024 * 1024;               // 单文件上限 10 MB（可用环境变量覆盖，便于测试轮转）
const KEEP = Number(process.env.DSH_RUNTIME_LOG_KEEP) > 0
  ? Number(process.env.DSH_RUNTIME_LOG_KEEP)
  : 5;                              // 保留几份轮转
const LEVEL_NAME = ['ERROR', 'INFO', 'WARN', 'DEBUG'];
const DEFAULT_LEVEL = 3;            // 3 = DEBUG，全收（见文件头：过滤方向是 targetLevel < level 才跳过）

let ready = false;
let wroteAny = false;

// ---------------------------------------------------------------- 工具

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function stamp(ts) {
  const d = ts ? new Date(ts) : new Date();
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) +
    ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) +
    '.' + pad(d.getMilliseconds(), 3)
  );
}

function stringify(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return '[unserializable ' + typeof v + ']';
  }
}

// 复刻 cordis Logger.format 的核心语义：Error 直接给 stack，printf 占位符按序消费
function formatArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return '';
  if (args[0] instanceof Error) {
    const rest = args.slice(1).map(stringify).filter(Boolean);
    return (args[0].stack || (args[0].name + ': ' + args[0].message)) +
      (rest.length ? ' ' + rest.join(' ') : '');
  }
  if (typeof args[0] === 'string') {
    // ★ 单参数时也要还原 %% —— 早期版本只在多参数分支里处理它，
    //   于是 logger.info('100%% sure') 会原样打出两个百分号（mock 测试抓到的）。
    if (args.length === 1) return args[0].replace(/%%/g, '%');
    let i = 1;
    const out = args[0].replace(/%([sdifjoO%])/g, (m, ch) => {
      if (m === '%%') return '%';
      if (i >= args.length) return m;
      const v = args[i++];
      switch (ch) {
        case 's': return stringify(v);
        case 'd': case 'i': return String(Math.trunc(Number(v)));
        case 'f': return String(Number(v));
        case 'j': case 'o': case 'O': return stringify(v);
        default: return m;
      }
    });
    const rest = args.slice(i).map(stringify).filter((s) => s !== '');
    return rest.length ? out + ' ' + rest.join(' ') : out;
  }
  return args.map(stringify).join(' ');
}

function ensureDir() {
  if (ready) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    ready = true;
    return true;
  } catch {
    return false;
  }
}

// 轮转：file -> file.1 -> file.2 ... 超出 KEEP 的删掉
function rotateIfNeeded(file) {
  try {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (st.size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = file + '.' + i;
      const to = file + '.' + (i + 1);
      try {
        if (!fs.existsSync(from)) continue;
        if (i + 1 > KEEP) fs.unlinkSync(from);
        else fs.renameSync(from, to);
      } catch { /* 单步失败不影响其余 */ }
    }
    fs.renameSync(file, file + '.1');
  } catch { /* 轮转失败不能影响写日志 */ }
}

function writeLine(file, line) {
  if (!ensureDir()) return;
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, line + '\n');
    wroteAny = true;
  } catch { /* 写失败不能外抛 */ }
}

function render(message) {
  const lvl = LEVEL_NAME[message.level] || String(message.level);
  const who = message.name || '(unnamed)';
  return '[' + stamp(message.ts) + '] [' + lvl.padEnd(5) + '] [' + who + '] ' + formatArgs(message.args);
}

// ---------------------------------------------------------------- 主流程
export function apply(ctx) {
  ctx.effect(() => {
    try {
      if (!ensureDir()) {
        // 连日志目录都建不了 —— 无路可报，只能静默（写 stdout 也无处可看）
        return () => {};
      }

      // 开场标记：这样一眼能看出 DSH 这次是什么时候起的
      writeLine(MAIN_LOG, '');
      writeLine(MAIN_LOG, '===== runtime-log attached at ' + stamp() + ' (pid ' + process.pid + ') =====');

      // ---- 1) 先把内存 buffer 里已有的记录 dump 出来 ----
      // 这一步很关键：本插件加载【之前】发生的事（包括其他插件加载失败）都在 buffer 里。
      try {
        const buf = ctx.logger && ctx.logger.buffer;
        if (Array.isArray(buf) && buf.length > 0) {
          writeLine(MAIN_LOG, '----- backfill ' + buf.length + ' buffered record(s) -----');
          for (const m of buf) {
            if (m && typeof m === 'object') writeLine(MAIN_LOG, render(m));
          }
          writeLine(MAIN_LOG, '----- backfill end -----');
        }
      } catch { /* buffer 不是必须的 */ }

      // ---- 2) 注册 exporter ----
      let registered = false;
      try {
        if (ctx.logger && typeof ctx.logger.exporter === 'function') {
          ctx.logger.exporter({
            colors: false,                 // 落盘不要 ANSI 转义
            maxLength: 10240,
            levels: { default: DEFAULT_LEVEL },
            export(message) {
              try {
                if (!message || typeof message !== 'object') return;
                const line = render(message);
                writeLine(MAIN_LOG, line);
                // error / warn 另存一份，方便单独翻
                if (message.level === 0 || message.level === 2) {
                  writeLine(ERR_LOG, line);
                }
              } catch { /* 单条渲染失败不能影响其余 */ }
            },
          });
          registered = true;
        }
      } catch { /* 注册失败后面会记 */ }

      writeLine(MAIN_LOG, '[runtime-log] exporter registered=' + registered +
        '  main=' + MAIN_LOG + '  errors=' + ERR_LOG);
      if (!registered) {
        writeLine(MAIN_LOG, '[runtime-log] !! ctx.logger.exporter 不可用 —— 日志无法采集');
      }

      // ---- 3) 卸载时留个收尾标记 ----
      return () => {
        try {
          writeLine(MAIN_LOG, '===== runtime-log detached at ' + stamp() + ' =====');
        } catch { /* ignore */ }
      };
    } catch {
      // 绝不外抛
      return () => {};
    }
  });
}
