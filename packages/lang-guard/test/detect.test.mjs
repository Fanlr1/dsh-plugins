// lang-guard 的离线单测 —— 不需要 DSH、不需要模型、不需要 GPU。
//   node test/detect.test.mjs
//
// 重点覆盖两处容易错的地方：
//   ① measureLanguage 的指标定义（汉字占比的分母只算汉字+拉丁字母，不算标点代码符号）
//   ② collectTurnReasoning 【必须聚合整个回合的所有 step】——
//      这是与 empty-turn-guard 的关键区别，它只读最后一步。
//
// ⚠️ observeTurn 会真的写 lang-status.json 与日志（有副作用）。
//    测试末尾会用一条 testing 记录覆盖状态文件，不留误导性数据。

import { rmSync } from 'node:fs';
import {
  measureLanguage,
  classify,
  joinBlocks,
  collectTurnReasoning,
  readEventsSafely,
  observeTurn,
  STATUS_FILE,
  THRESHOLD_BAD,
  THRESHOLD_WARN,
} from '../lib/index.js';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + '\n       期望 ' + JSON.stringify(expected) + '\n       实际 ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ─────────────────────── ① measureLanguage ───────────────────────
console.log('\n[1] measureLanguage —— 指标定义');

const zh = measureLanguage('这是一段纯中文的思考过程，用来验证指标是否合理。');
checkTrue('纯中文 ratio > 0.9', zh.ratio > 0.9);
check('纯中文 classify = ok', classify(zh.ratio), 'ok');

const en = measureLanguage('Now let me check the llama-server log file to see what happened.');
checkTrue('纯英文 ratio = 0', en.ratio === 0);
check('纯英文 classify = bad', classify(en.ratio), 'bad');

check('空串 ratio = 0', measureLanguage('').ratio, 0);
check('非字符串 ratio = 0', measureLanguage(null).ratio, 0);

// ★ 真实的漂移样本：中文骨架 + 大量英文标识符 —— 这是我最常见的漂移形态
const mixedDrift = measureLanguage(
  'The `-c` is capped to `n_ctx_train`. 所以我们要用 `-c 128000`。' +
  'But the `zstdDecompressSync` only decompresses the first frame, ' +
  'so I need to scan for the magic bytes `28 B5 2F FD` from the end of the buffer.'
);
checkTrue('中英混排落在 bad/warn 之间', mixedDrift.ratio < 0.5);
console.log('       （该样本汉字占比 ' + (mixedDrift.ratio * 100).toFixed(1) + '%，分级 ' + classify(mixedDrift.ratio) + '）');

// 标点/代码符号不该稀释指标
const zhWithPunct = measureLanguage('先算权重（特异性），再改选择器；不要用 !important。—— 完毕。');
checkTrue('中文带标点 ratio > 0.6（9 个拉丁字母来自 !important，会拉低比例）', zhWithPunct.ratio > 0.6);
check('中文带标点仍是 ok（>0.5）', classify(zhWithPunct.ratio), 'ok');

// ★★ 防假阳性：这是【真实思维链的典型形态】——中文讲解 + 英文标识符。
//    它绝不能被判成 bad，否则插件会天天误报。
const typicalZh = measureLanguage(
  '先看 `-c` 参数是否超过 `n_ctx_train`，如果超过就改成 128000，' +
  '然后检查 `llama-server` 的启动日志里 `n_ctx_slot` 的实际值，' +
  '再决定要不要保留这个配置。'
);
checkTrue('★ 中文讲解+英文标识符 不该判 bad（ratio=' + (typicalZh.ratio * 100).toFixed(1) + '%）', classify(typicalZh.ratio) !== 'bad');
checkTrue('★ 且 ratio 明显高于漂移样本', typicalZh.ratio > 0.3);

// ─────────────────────── ② classify 阈值 ───────────────────────
console.log('\n[2] classify —— 阈值边界');
check('0.0   → bad', classify(0.0), 'bad');
check('0.19  → bad', classify(THRESHOLD_BAD - 0.01), 'bad');
check('0.20  → warn（边界含）', classify(THRESHOLD_BAD), 'warn');
check('0.49  → warn', classify(THRESHOLD_WARN - 0.01), 'warn');
check('0.50  → ok（边界含）', classify(THRESHOLD_WARN), 'ok');
check('1.0   → ok', classify(1.0), 'ok');
check('NaN   → ok（保守放行）', classify(NaN), 'ok');

// ─────────────────────── ③ joinBlocks ───────────────────────
console.log('\n[3] joinBlocks —— 按类型取块');

const msg = {
  role: 'assistant',
  content: [
    { type: 'reasoning', text: '先想一下。' },
    { type: 'text', text: '这是给用户的正文。' },
    { type: 'tool-call', name: 'pwsh' },
    { type: 'reasoning', text: '继续想。' },
  ],
};
check('只取 reasoning 块并拼接', joinBlocks(msg, 'reasoning'), '先想一下。\n继续想。');
check('只取 text 块', joinBlocks(msg, 'text'), '这是给用户的正文。');
check('不存在的类型 → 空串', joinBlocks(msg, 'image'), '');
check('null 消息 → 空串', joinBlocks(null, 'reasoning'), '');
check('content 不是数组 → 空串', joinBlocks({ content: 'x' }, 'reasoning'), '');

// ─────────────────────── ④ collectTurnReasoning（★ 核心） ───────────────────────
console.log('\n[4] collectTurnReasoning —— ★ 必须聚合整个回合的所有 step');

// 造一个「一个回合里有 3 个 step」的会话：这正是工具调用让样本被切碎的形态
const sessionMultiStep = {
  snapshotEvents: () => [
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'reasoning', text: '第一步的思考。' }] } } },
    { type: 'tool/result', data: { turn: 1, step: 0 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '第二步的思考。' }] } } },
    { type: 'tool/result', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: '第三步的思考。' }] } } },
  ],
};
const agg = collectTurnReasoning(sessionMultiStep, 1);
check('聚合 3 个 step（不是只取最后一步）', agg, '第一步的思考。\n第二步的思考。\n第三步的思考。');

// 只取指定回合
const sessionTwoTurns = {
  snapshotEvents: () => [
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'reasoning', text: '回合一的思考。' }] } } },
    { type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [{ type: 'reasoning', text: '回合二的思考。' }] } } },
  ],
};
check('只取 turn=2', collectTurnReasoning(sessionTwoTurns, 2), '回合二的思考。');
check('不存在的 turn → 空串', collectTurnReasoning(sessionTwoTurns, 99), '');

// 没有 reasoning 的回合（例如纯工具调用回合）→ 空串，且不该抛
const sessionNoReasoning = {
  snapshotEvents: () => [
    { type: 'assistant/message', data: { turn: 5, step: 0, message: { content: [{ type: 'tool-call', name: 'x' }] } } },
  ],
};
check('无 reasoning → 空串', collectTurnReasoning(sessionNoReasoning, 5), '');

// ─────────────────────── ⑤ 防御性 ───────────────────────
console.log('\n[5] 防御性 —— 看护层不能把宿主搞挂');

check('session = null', readEventsSafely(null), []);
check('session 无 snapshotEvents', readEventsSafely({}), []);
check('snapshotEvents 抛异常 → 空数组', readEventsSafely({ snapshotEvents: () => { throw new Error('boom'); } }), []);
check('snapshotEvents 返回非数组 → 空数组', readEventsSafely({ snapshotEvents: () => 'nope' }), []);
check('session = null 时聚合 → 空串', collectTurnReasoning(null, 1), '');

const dirtySession = {
  snapshotEvents: () => [
    null,
    'garbage',
    { type: 'assistant/message' },                                   // 无 data
    { type: 'assistant/message', data: null },                       // data 为 null
    { type: 'assistant/message', data: { turn: 7, step: 0 } },       // 无 message
    { type: 'assistant/message', data: { turn: 7, step: 0, message: null } },
    { type: 'assistant/message', data: { turn: 7, step: 0, message: { content: 'not-array' } } },
    { type: 'assistant/message', data: { turn: 7, step: 0, message: { content: [null, { type: 'reasoning' }, { type: 'reasoning', text: 123 }] } } },
    { type: 'assistant/message', data: { turn: 7, step: 0, message: { content: [{ type: 'reasoning', text: '唯一有效的一段。' }] } } },
  ],
};
check('脏数据里只取出有效文本', collectTurnReasoning(dirtySession, 7), '唯一有效的一段。');

// ─────────────────────── ⑥ observeTurn 端到端 ───────────────────────
console.log('\n[6] observeTurn —— 端到端（有写文件副作用）');

const seen = new WeakMap();
const fakeAgent = { session: sessionMultiStep };

const st1 = observeTurn({ agent: fakeAgent, turn: 1 }, seen);
checkTrue('返回状态对象', st1 && st1.turn === 1);
check('分级为 ok（三步都是中文）', st1.level, 'ok');
checkTrue('汉字数 > 0', st1.cjk > 0);
checkTrue('推理长度 = 三步之和', st1.reasoningChars === agg.length);

const st2 = observeTurn({ agent: fakeAgent, turn: 1 }, seen);
check('同一回合重复触发 → 跳过（返回 null）', st2, null);

check('payload 为 null → 返回 null', observeTurn(null, seen), null);
check('payload 无 agent → 返回 null', observeTurn({ turn: 1 }, seen), null);
check('agent 是字符串 → 返回 null', observeTurn({ agent: 'x', turn: 1 }, seen), null);

const enAgent = {
  session: {
    snapshotEvents: () => [
      { type: 'assistant/message', data: { turn: 3, step: 0, message: { content: [{ type: 'reasoning', text: 'Now I need to check the server log and the cache directory to see what happened there.' }] } } },
    ],
  },
};
const st3 = observeTurn({ agent: enAgent, turn: 3 }, new WeakMap());
check('英文思维链 → bad', st3.level, 'bad');

// ─────────────────────── 汇总 ───────────────────────
// 清理：observeTurn 会写 lang-status.json，测试数据留在那里会误导观察者。
try {
  rmSync(STATUS_FILE, { force: true });
  console.log('\n  （已清理测试产生的 lang-status.json）');
} catch (e) { /* 静默 */ }

console.log('\n' + '─'.repeat(56));
console.log('  PASS ' + pass + '   FAIL ' + fail);
console.log('─'.repeat(56));
process.exit(fail === 0 ? 0 : 1);
