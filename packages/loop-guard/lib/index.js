// dsh-plugin-loop-guard -- 思维链/正文循环守卫（host 侧）
//
// ★ 2026-10-15 重写：判据与收尾语义【吸收】自 @mrweicodes/dsh-loop-guard v1.0.9（MIT）。
//   换掉了原来的「zstd 压缩比」判据 —— 参考项目用它自己的实测数据证明：低熵比率
//   随【长度】上升（rho(长度,比率)=0.606），是「长度检测器」而非循环检测器，
//   在 152 个有产出的调用上误报 60%。新判据全部是【逐字周期】与【短语池】。
//
// 六条判据：
//   ① reasoning-cycle  推理尾部是精确周期（周期<=512，跨度>=512）        ┐ 流内
//   ② reasoning-lines  推理的重复行（质量>=2048 / 覆盖率>=0.6 / 集中度>=4）├ 流内
//   ③ repeating-cycle  可见输出尾部精确周期（512 / 256）                 │ 流内
//   ④ text-lines       可见输出的短语池（2048 / 0.6 / 4）                ┘ 流内
//   ⑤ identical-chunks 连续相同的 text-delta（60 次）
//   ⑥ 跨调用           reasoning-only / repeated-material（containment>=0.8，累计 3 次）
//
// ★ 收尾语义（这次别再犯）：
//   检出后【关闭所有打开的块】→ 再 yield {type:'finish', reason:{kind:'stop'}} → return。
//   · 不能「只 return」：块还开着，流"简单地结束"
//   · 不能发 error finish：agent-loop 会 settle 成 assistant/attempt（无 message），
//     客户端渲染不出来，且 turn() 提前 throw，排队的 steer 永远送不到 —— 参考项目为此崩过 UI
//   · 只能「关块 + stop」：走正常路径，消息能落盘、客户端能渲染、turn 能继续
//
// 保留自研骨架：单例守卫 / WeakSet 防重入 / 跳 purpose 内部请求 / 独立日志。

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';

export const name = 'loop-guard';
// ★ Cordis 的 context proxy 对【未声明】的服务读取会抛错
//   （cannot get property "agents" without inject）—— 参考项目 v0.1.1 正是因此
//   让 apply() 在激活时抛错、整个部署的会话都跑不起来。所以 agents 必须声明。
export const inject = ['llm', 'agents'];

// 默认写 ~/.dsh/logs；测试可用 LOOP_GUARD_LOG 覆盖（见下方 logFile）
const LOG = process.env.LOOP_GUARD_LOG || joinPath(os.homedir(), '.dsh', 'logs', 'loop-guard.log');
// 可被环境变量覆盖：测试用它写独立文件，避免污染生产日志。
let logFile = process.env.LOOP_GUARD_LOG || LOG;

/** 固定长度 gram 的窗口大小（跨调用比较用；参考项目标定值）。 */
export const GRAM_SIZE = 4;
/** 周期扫描的步长：每新积累这么多字符扫一次。 */
const CYCLE_CHECK_STRIDE = 32;
/** 短于此长度的行不计入短语池（分子分母都不计）。 */
const LINE_MIN_CHARS = 2;

export const DEFAULTS = {
    // 'break' = 检出后关块+stop 收尾（默认）；'watch' = 只记录；'inject' = 只往流里塞提示（对照，实测无效）
    mode: 'break',
    // ⑥ 跨调用
    maxThinkingSteps: 3,
    minReasoningChars: 2048,
    similarityThreshold: 0.8,
    escalate: 'steer',
    maxFires: 4,
    // ⑤ 连续相同 delta
    maxRepeatedText: 60,
    // ③ 可见输出周期
    maxRepeatedCycleChars: 512,
    minRepeatedCycleChars: 256,
    // ④ 可见输出短语池
    maxRepeatedTextLineChars: 2048,
    minRepeatedTextLineCoverage: 0.6,
    minRepeatedTextLineConcentration: 4,
    // ★① 坍缩检测（2026-10-15 新增，真值集标定）——
    //   捕获「停止产生新内容」这一形态：短句/协议碎片池轮换，字符级看熵不低（尾部压缩比 23%），
    //   但唯一 4-gram 率断崖（真循环 0.08~0.12 vs 正常 0.70）。固定窗口 ⇒ 不随长度漂移。
    // 窗口 300：真值集上比 700 早 300 字触发（684/524/524 vs 988/796/764），误伤同为 0。
    // 不能再小 —— 压到 150 时池子周期（约 75~100 字）装不下 2~3 个，B 组真循环命中从 14 崩到 1。
    reasoningGramWindow: 300,      // 尾部窗口（字符）
    minReasoningGramUniq: 0.30,    // 唯一 4-gram 率上限（低于它判坍缩）；<=0 关闭
    // ★② 短行空转（2026-10-16 新增）—— 坍缩检测抓不到「短链」：
    //   稀释型样本（短循环与正常内容交替）尾部唯一率只到 0.45，但它【85% 的行都 ≤4 字符】
    //   而正常推理最大只有 25%。窗口小、几乎零成本，与坍缩判据互补。
    stubRows: 20,                  // 看最近这么多行
    stubLineMaxLen: 4,             // 多短算「碎片行」
    minStubRatio: 0.30,            // 碎片行占比下限；<=0 关闭
    // ② 推理周期
    maxRepeatedReasoningCycleChars: 512,
    // ★ 2026-10-15 由 512 收紧到 384 —— 用本机真机样本标定（95 条纯推理步 + 98 条有产出步）：
    //   触发 61→81 条（多抓 20 条），平均触发位置 3332→2530 字（提前约 800 字）；
    //   未触发者的【尾部 600 字压缩比】中位由 16.5% 升到 52.4% ⇒ 剩下的确实是不重复的正常推理；
    //   有产出步 7→11，但那 11 条尾部压缩比 10~14%（与真循环同区间）⇒ 属「循环后又走出来」，不是误伤。
    //   再降到 256 只多抓 1 条 ⇒ 不划算。
    minRepeatedReasoningCycleChars: 384,
    // ② 推理短语池
    maxRepeatedReasoningLineChars: 2048,
    minRepeatedReasoningLineCoverage: 0.6,
    minRepeatedReasoningLineConcentration: 4,
    // 收尾时是否 steer 一句纠正提示
    breakCorrection: true,
    // 收尾兜底：同一回合最多 steer 几次（吸收 empty-turn-guard 时由 8 提高到 20 ——
    //   合并后 loop-guard 会在源头 steer，空回合本就大幅减少，配额不该被截断白耗）
    maxEmptyTurnSteers: 20,
};

/** 记日志：任何失败都不影响流。 */
export function log(line) {
    try {
        if (!existsSync(dirname(logFile))) mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + line + '\n', 'utf8');
    } catch (e) { /* 忽略 */ }
}

/** 合并配置：只认 DEFAULTS 里的键；兼容旧的 mode:'cut'。 */
export function mergeConfig(given) {
    const out = Object.assign({}, DEFAULTS);
    if (given && typeof given === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
            if (given[k] !== undefined) out[k] = given[k];
        }
        if (given.mode === 'cut') out.mode = 'break';   // 旧默认名，语义即「关块+stop」
    }
    return out;
}

/** 压缩比：★ 已【不再作为判据】，只留作日志里的对照诊断。 */
export function compressRatio(text) {
    try {
        const bytes = Buffer.byteLength(text, 'utf8');
        if (!bytes) return 1;
        return zstdCompressSync(Buffer.from(text, 'utf8')).length / bytes;
    } catch (e) { return 1; }
}

/* ------------------------------------------------------------------ */
/* 一、逐字周期（精确，不是比率）                                       */
/* ------------------------------------------------------------------ */

/** text 末尾连续相同字符的长度（用于「周期必须含至少两个不同字符」的护栏）。 */
function trailingRunLength(text) {
    const len = text.length;
    if (len === 0) return 0;
    const last = text[len - 1];
    let run = 1;
    while (run < len && text[len - 1 - run] === last) run++;
    return run;
}

/**
 * 尾部是否是一个精确周期的重复：返回达标跨度（>= minSpan），否则 0。
 * 精确性天然避开了「表格/日志/CSS/JSON 也重复」的误伤：那些样本的周期判据恒为 0，
 * 而覆盖率类度量只能把它们和真循环拉开 ~0.06。
 */
export function trailingCycle(text, maxPeriod, minSpan) {
    if (maxPeriod < 1) return 0;
    const len = text.length;
    const tailRun = trailingRunLength(text);
    for (let period = 1; period <= maxPeriod; period++) {
        if (tailRun >= period) continue;   // 单字符周期不算循环（那是分隔线）
        const need = Math.max(minSpan, 2 * period) - period;
        const limit = Math.min(len - period, need);
        let matched = 0;
        while (matched < limit && text[len - period - 1 - matched] === text[len - 1 - matched]) matched++;
        if (matched >= need) return matched + period;
    }
    return 0;
}

/** 同一条周期，但把尾巴走到底：用于报告「究竟重复了多少字」。 */
export function periodicTailSpan(text, maxPeriod, minSpan) {
    if (maxPeriod < 1) return 0;
    const len = text.length;
    const tailRun = trailingRunLength(text);
    for (let period = 1; period <= maxPeriod; period++) {
        if (tailRun >= period) continue;
        const need = Math.max(minSpan, 2 * period) - period;
        const limit = len - period;
        let matched = 0;
        while (matched < limit && text[len - period - 1 - matched] === text[len - 1 - matched]) matched++;
        if (matched >= need) return matched + period;
    }
    return 0;
}

/** 末尾连续「相同（trim 后）」delta 的个数。 */
export function countRepeatedText(texts) {
    const last = texts[texts.length - 1];
    if (last === undefined) return 0;
    const normalized = last.trim();
    let run = 0;
    for (let i = texts.length - 1; i >= 0; i--) {
        if (texts[i].trim() !== normalized) break;
        run++;
    }
    return run;
}

/* ------------------------------------------------------------------ */
/* 二、短语池（换个顺序重复同一批句子）                                 */
/* ------------------------------------------------------------------ */

/**
 * 计数「重复行」的质量 / 覆盖率 / 集中度。
 * 集中度是关键护栏：引用一段代码两次（改前/改后）会让覆盖率逼近 1，
 * 但那种调用的「每行平均出现次数」只有 1.4~2.5，而真短语池是 6.4~84。
 */
export class PhrasePool {
    constructor() {
        this.counts = new Map();
        this.total = 0;
        this.repeat = 0;
        this.instances = 0;
        this.partial = '';
    }
    get repeatedChars() { return this.repeat; }
    push(text) {
        this.partial += text;
        let idx;
        while ((idx = this.partial.indexOf('\n')) >= 0) {
            this.addLine(this.partial.slice(0, idx).trim());
            this.partial = this.partial.slice(idx + 1);
        }
    }
    addLine(line) {
        if (line.length < LINE_MIN_CHARS) return;
        const prev = this.counts.get(line) || 0;
        this.counts.set(line, prev + 1);
        this.total += line.length;
        this.instances += 1;
        if (prev === 1) this.repeat += line.length * 2;
        else if (prev > 1) this.repeat += line.length;
    }
    tripped(minRepeat, minCoverage, minConcentration) {
        if (this.repeat < minRepeat) return false;
        if (this.total === 0) return false;
        if (this.repeat / this.total < minCoverage) return false;
        if (this.counts.size === 0) return false;
        return this.instances / this.counts.size >= minConcentration;
    }
}

/* ------------------------------------------------------------------ */
/* 三、gram 与含容度（跨调用比较）                                      */
/* ------------------------------------------------------------------ */

/** 固定长度窗口下的【唯一率】：不同 4-gram / 总 4-gram。
 *  与「重复占比」不同 —— 它测的是「还有没有新东西出现」，固定窗口下不随长度漂移。
 *  真值集：正常推理中位 0.70，真循环 0.08~0.12。 */
export function gramUniqText(text) {
    const seen = new Set();
    let total = 0;
    for (let i = 0; i + GRAM_SIZE <= text.length; i++) { total++; seen.add(text.slice(i, i + GRAM_SIZE)); }
    return total === 0 ? 1 : seen.size / total;
}


/** 一段文本里所有【不同】的定长窗口。CJK 无空格，所以用定长而不是分词。 */
export function grams(text, size) {
    const k = size === undefined ? GRAM_SIZE : size;
    const out = new Set();
    for (let i = 0; i + k <= text.length; i++) out.add(text.slice(i, i + k));
    return out;
}

/** 较小的 gram 集有多大比例出现在较大的里。 */
export function containment(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    const small = a.size <= b.size ? a : b;
    const large = a.size <= b.size ? b : a;
    let shared = 0;
    for (const gram of small) if (large.has(gram)) shared++;
    return shared / small.size;
}

/* ------------------------------------------------------------------ */
/* 四、跨调用：卡住的调用连续出现几次                                   */
/* ------------------------------------------------------------------ */

/**
 * 逐次调用地累积「卡住」次数，达标后交一次「开火」。
 * 两个结构性判据：本次调用没有任何产出（reasoning-only），
 * 或者它把上一步的推理材料又复述了一遍（repeated-material）。
 */
export class LoopDetector {
    constructor(config) {
        this.config = config;
        this.stalled = 0;
        this.fires = 0;
        this.previous = undefined;
        this.lastReason = undefined;
    }
    get threshold() { return this.config.maxThinkingSteps; }
    get fired() { return this.fires; }
    observe(step) {
        if (step.reasoning.length < this.config.minReasoningChars) return undefined;
        const current = grams(step.reasoning);
        const repeated = this.previous !== undefined
            && this.config.similarityThreshold > 0
            && containment(this.previous, current) >= this.config.similarityThreshold;
        this.previous = current;
        let reason;
        if (!step.hasOutput) reason = 'reasoning-only';
        else if (repeated) reason = 'repeated-material';
        else reason = undefined;
        if (reason === undefined) { this.stalled = 0; this.lastReason = undefined; return undefined; }
        this.stalled += 1;
        this.lastReason = reason;
        return reason;
    }
    takeFire() {
        if (this.stalled < this.config.maxThinkingSteps) return undefined;
        if (this.fires >= this.config.maxFires) return undefined;
        this.fires += 1;
        this.stalled = 0;
        const reason = this.lastReason || 'reasoning-only';
        this.lastReason = undefined;
        return reason;
    }
    reset() { this.stalled = 0; this.previous = undefined; this.lastReason = undefined; }
}

/* ------------------------------------------------------------------ */
/* 五、流内：推理循环                                                   */
/* ------------------------------------------------------------------ */

export class ReasoningLoopBreaker {
    constructor(config) {
        this.config = config;
        this.broken = false;
        this.chars = 0;
        this.reasoning = '';
        this.lastCycleCheck = 0;
        this.lastFlatCheck = 0;
        this.trippedRule = undefined;
        this.pool = new PhrasePool();
        this.repeated = 0;
    }
    get tripped() { return this.broken; }
    get trippedBy() { return this.trippedRule; }
    get repeatedChars() { return this.repeated; }
    get emittedChars() { return this.chars; }
    push(text) {
        if (this.broken) return false;
        this.chars += text.length;
        this.reasoning += text;
        // ★① 坍缩检测（放在最前：真值集上它比周期/短语池都早 800~1000 字）
        if (this.checkFlat()) {
            this.broken = true;
            this.trippedRule = 'reasoning-flat';
            return true;
        }
        if (this.checkStub()) {
            this.broken = true;
            this.trippedRule = 'reasoning-stub';
            return true;
        }
        if (this.pushLines(text)) {
            this.broken = true;
            this.trippedRule = 'reasoning-lines';
            this.repeated = this.pool.repeatedChars;
            return true;
        }
        if (this.config.maxRepeatedReasoningCycleChars <= 0) return false;
        if (this.reasoning.length - this.lastCycleCheck < CYCLE_CHECK_STRIDE) return false;
        this.lastCycleCheck = this.reasoning.length;
        const span = trailingCycle(this.reasoning, this.config.maxRepeatedReasoningCycleChars, this.config.minRepeatedReasoningCycleChars);
        if (span === 0) return false;
        this.broken = true;
        this.trippedRule = 'reasoning-cycle';
        this.repeated = periodicTailSpan(this.reasoning, this.config.maxRepeatedReasoningCycleChars, this.config.minRepeatedReasoningCycleChars) || span;
        return true;
    }
    /**
     * 短链检测：最近 N 行里「碎片行（很短的行）」的占比是否过高。
     * 坍缩判据看的是字符级唯一率，抓不到「做。/好。/写。」这类小池子；
     * 但它们每行都极短，占比会断崖 —— 真值集实测：稀释型 0.85，正常最大 0.25。
     */
    checkStub() {
        const cfg = this.config;
        if (!(cfg.minStubRatio > 0) || !(cfg.stubRows > 0)) return false;
        const tail = this.reasoning.slice(-2000);          // 够装下 stubRows 行
        const lines = tail.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(-cfg.stubRows);
        if (lines.length < 8) return false;
        // ★ 护栏：只认【含语言字符】的短行。
        //   否则源码里的 `}` / `);` / `},` 会把它顶上去 —— 实测误伤了「正常源码 4000 字」
        //   和「引用代码两次」两个回归样本（参考项目也踩过：它为此设了 LINE_MIN_CHARS）。
        let short = 0;
        for (const l of lines) {
            if (l.length <= cfg.stubLineMaxLen && /[\u4e00-\u9fff a-zA-Z0-9]/.test(l)) short++;
        }
        const ratio = short / lines.length;
        if (ratio < cfg.minStubRatio) return false;
        this.repeated = short;
        return true;
    }

    /** 尾部窗口的唯一 4-gram 率是否塌到阈值以下（停止产生新信息）。 */
    checkFlat() {
        const cfg = this.config;
        if (!(cfg.minReasoningGramUniq > 0) || !(cfg.reasoningGramWindow > 0)) return false;
        if (this.reasoning.length < cfg.reasoningGramWindow) return false;   // 窗口没填满不判
        if (this.reasoning.length - this.lastFlatCheck < CYCLE_CHECK_STRIDE) return false;
        this.lastFlatCheck = this.reasoning.length;
        const raw = this.reasoning.slice(-cfg.reasoningGramWindow);
        // ★ 护栏（真值集标定）：窗口里只要出现代码围栏，就不判坍缩。
        //   真循环的三个窗口围栏数都是 0；而被误伤的那条是「edit 的 old/new 代码对比」
        //   （围栏 8 个、唯一率 0.267）—— 同样塌陷，但那是合法内容。
        //   不做半吊子剔除：围栏配对在窗口边界会错位，宁可整窗跳过。
        if (raw.indexOf('```') >= 0) return false;
        const u = gramUniqText(raw);
        if (u >= cfg.minReasoningGramUniq) return false;
        this.repeated = Math.round((1 - u) * cfg.reasoningGramWindow);
        return true;
    }

    pushLines(text) {
        if (this.config.maxRepeatedReasoningLineChars <= 0) return false;
        this.pool.push(text);
        return this.pool.tripped(
            this.config.maxRepeatedReasoningLineChars,
            this.config.minRepeatedReasoningLineCoverage,
            this.config.minRepeatedReasoningLineConcentration,
        );
    }
}

/* ------------------------------------------------------------------ */
/* 六、流内：可见输出循环                                               */
/* ------------------------------------------------------------------ */

export class TextRepetitionDetector {
    constructor(config) {
        this.config = config;
        this.texts = [];
        this.broken = false;
        this.visible = '';
        this.lastCycleCheck = 0;
        this.reason = undefined;
        this.repeated = 0;
        this.chars = 0;
        this.pool = new PhrasePool();
    }
    get tripped() { return this.broken; }
    get trippedBy() { return this.reason; }
    get repeatedChars() { return this.repeated; }
    get emittedChars() { return this.chars; }
    push(text) {
        if (this.broken) return false;
        this.chars += text.length;
        if (this.config.maxRepeatedText <= 0 && this.config.maxRepeatedCycleChars <= 0
            && this.config.maxRepeatedTextLineChars <= 0) return false;
        this.texts.push(text);
        if (this.config.maxRepeatedText > 0
            && this.texts.length >= this.config.maxRepeatedText
            && countRepeatedText(this.texts) >= this.config.maxRepeatedText) {
            this.broken = true;
            this.reason = 'identical-chunks';
            this.repeated = countRepeatedText(this.texts) * text.length;
            return true;
        }
        if (this.config.maxRepeatedTextLineChars > 0) {
            this.pool.push(text);
            if (this.pool.tripped(
                this.config.maxRepeatedTextLineChars,
                this.config.minRepeatedTextLineCoverage,
                this.config.minRepeatedTextLineConcentration,
            )) {
                this.broken = true;
                this.reason = 'text-lines';
                this.repeated = this.pool.repeatedChars;
                return true;
            }
        }
        if (this.config.maxRepeatedCycleChars <= 0) return false;
        this.visible += text;
        if (this.visible.length - this.lastCycleCheck < CYCLE_CHECK_STRIDE) return false;
        this.lastCycleCheck = this.visible.length;
        const span = trailingCycle(this.visible, this.config.maxRepeatedCycleChars, this.config.minRepeatedCycleChars);
        if (span === 0) return false;
        this.broken = true;
        this.reason = 'repeating-cycle';
        this.repeated = periodicTailSpan(this.visible, this.config.maxRepeatedCycleChars, this.config.minRepeatedCycleChars) || span;
        return true;
    }
}

/* ------------------------------------------------------------------ */
/* 七、收尾与反应                                                       */
/* ------------------------------------------------------------------ */

// ★ 这里的值必须是【能被「你正在 X」接住】的动词短语 ——
//   2026-10-15 首次真机触发时写成了整句（'推理在重复同一段内容'），
//   拼出来是「你正在推理在重复同一段内容」，语法不通。
const RULE_ZH = {
    'reasoning-flat': '原地打转、不再产生新内容',
    'reasoning-stub': '用一串极短的碎片句在原地打转（如「做。好。写。」）',
    'reasoning-cycle': '重复同一段推理内容',
    'reasoning-lines': '反复使用同一批推理句子',
    'repeating-cycle': '重复同一段正文内容',
    'text-lines': '反复使用同一批正文句子',
    'identical-chunks': '重复输出相同片段',
    'reasoning-only': '空转推理、不产出结果',
    'repeated-material': '复述上一步的推理材料',
};

/** 给模型的纠正提示：只说「停止重复、继续原任务」，不说「给结论收尾」（那会让它偏离）。 */
export function noticeFor(rule, repeated) {
    const what = RULE_ZH[rule] || '重复输出';
    const amount = (typeof repeated === 'number' && repeated > 0) ? ('（约 ' + repeated + ' 字）') : '';
    return '你正在' + what + amount + '。停止重复，继续推进当前任务：直接执行下一步，不要再复述。';
}

/**
 * 组装一条模型可见的 notice 用户消息。
 * ★ 形状必须齐：dsh-llm 的 MessageBase 要求 id 与 source 都【必填】
 *   （官方 createUserMessage 就是补 id=randomUUID()）。缺了会写入一条残缺的会话消息。
 * source.kind 用插件自己的 id —— MessageSourceMap 是 merge-extensible，
 * 消费方对未知 kind 走 fallthrough（官方注释原话）。
 */
export function userMessage(text, summary) {
    const s0 = (typeof summary === 'string' && summary.length > 0) ? summary : '循环守卫';
    const s = s0.length > 120 ? s0.slice(0, 119) + '…' : s0;
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: text }],
        source: { kind: 'loop-guard', form: 'notice', summary: s },
    };
}

/**
 * 从流内部结束一次调用：关掉打开的块，再发一个 stop finish。
 * 返回要补发的 chunk 数组；无法安全截断时返回 null（宁可多跑几字，也不提交半个工具调用）。
 */
export function breakStream(agent, repeated, rule, openBlocks, config) {
    if (openBlocks.some(function (b) { return b.blockType !== 'text' && b.blockType !== 'reasoning'; })) {
        log('⚠️ 检出 ' + rule + ' 但存在非 text/reasoning 的打开块 ⇒ 放弃截断（避免提交半个工具调用）');
        return null;
    }
    // steer 先入队，再发终止块 —— 顺序不能反（参考项目实测：反了 steer 送不到）
    if (config.breakCorrection && agent && typeof agent.steer === 'function') {
        try {
            agent.steer(userMessage(noticeFor(rule, repeated), '循环守卫 · ' + rule));
        } catch (e) {
            log('⚠️ steer 失败（不影响截断）: ' + ((e && e.message) || e));
        }
    }
    const out = [];
    for (const b of openBlocks) {
        out.push({ type: 'block-end', index: b.index, block: { type: b.blockType, text: b.text } });
    }
    out.push({ type: 'finish', reason: { kind: 'stop' } });
    return out;
}

/** 跨调用判定的反应：warn=inject / steer / cancel。 */
export function react(agent, reason, config) {
    if (!agent) { log('★ 跨调用判定命中（' + reason + '）但拿不到 agent ⇒ 只记录'); return; }
    const msg = userMessage(noticeFor(reason, 0), '循环守卫 · ' + reason);
    try {
        if (config.escalate === 'cancel' && typeof agent.cancel === 'function') {
            // AgentCancelCause 是【封闭 union】(user|parent|hook|disposed) —— 只能借 hook 带原因
            agent.cancel({ kind: 'hook', reason: 'loop-guard:' + reason });
            log('★ 跨调用判定命中（' + reason + '）⇒ cancel');
        } else if (config.escalate === 'warn' && typeof agent.inject === 'function') {
            agent.inject(msg);
            log('★ 跨调用判定命中（' + reason + '）⇒ inject 提示');
        } else if (typeof agent.steer === 'function') {
            agent.steer(msg);
            log('★ 跨调用判定命中（' + reason + '）⇒ steer 提示');
        }
    } catch (e) {
        log('⚠️ 反应失败（' + config.escalate + '）: ' + ((e && e.message) || e));
    }
}

/* ------------------------------------------------------------------ */
/* 七·补、收尾兜底（吸收自 dsh-plugin-empty-turn-guard）                */
/* ------------------------------------------------------------------ */

/**
 * 回合以「只有思考、没有正文也没有工具调用」收尾时，把回合拽回来再走一步。
 *
 * 【为什么并进 loop-guard】实测「纯推理空转」的回合里，绝大多数空收尾就是循环步
 * 被截断产生的（截断步没有 tool-call ⇒ agent-loop 判定完成 ⇒ 回合结束）。
 * 两条防线本就是一个链条，拆成两个插件只会各记各的账、各发各的 steer。
 *
 * 【平台语义】agent/turn-stopping 是 serial 事件：监听器没有 next、不能改结果，
 * 唯一手段是在里面调 agent.steer —— 平台收尾前会重读收件箱，有引导就再走一步。
 */
const EMPTY_TURN_TEXT = '你上一次只输出了思考，没有给用户任何可见的回复就结束了回合。'
    + '如果你的推理在重复，请立即停止重复；然后把当前的进展、结论或下一步用正文讲清楚再收尾。';

/** 消息里有没有某类块。 */
export function hasBlock(message, blockType) {
    const content = (message && message.content) || [];
    return Array.isArray(content) && content.some(function (b) { return b && b.type === blockType; });
}

/** 拼接消息里某类块的文本（块间用换行）。 */
export function joinBlocks(message, blockType) {
    const content = (message && message.content) || [];
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const b of content) {
        if (b && b.type === blockType && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.join('\n');
}

/** 取某回合【最后一步】的 assistant 消息；session 读不到时返回 null（绝不阻断回合）。 */
export function readLastStepAssistantMessage(session, turn) {
    let events = [];
    try {
        if (session && typeof session.snapshotEvents === 'function') {
            const got = session.snapshotEvents();
            if (Array.isArray(got)) events = got;
        }
    } catch (e) { return null; }
    let lastStep = -1, lastMessage = null;
    for (const e of events) {
        if (!e || e.type !== 'assistant/message') continue;
        if (!e.data || e.data.turn !== turn) continue;
        const step = e.data.step;
        const message = e.data.message;
        if (step === undefined || !message) continue;
        if (step < lastStep) continue;
        lastStep = step; lastMessage = message;
    }
    return lastMessage === null ? null : { step: lastStep, message: lastMessage };
}

/** 结构判定：命中返回一句说明，否则 null（不做文本匹配）。 */
export function detectEmptyTurnEnd(session, turn) {
    const last = readLastStepAssistantMessage(session, turn);
    if (last === null) return null;
    if (hasBlock(last.message, 'tool-call')) return null;
    if (joinBlocks(last.message, 'text').trim() !== '') return null;
    if (joinBlocks(last.message, 'reasoning').trim() === '') return null;
    return '回合在第 ' + last.step + ' 步只有思考、没有正文就收尾';
}

/** 收尾兜底：判定 + steer（同一 agent 同一回合有配额）。 */
function considerEmptyTurn(payload, budgets, config) {
    if (payload === null || typeof payload !== 'object') return;
    const agent = payload.agent;
    if (agent === null || typeof agent !== 'object') return;
    const turn = payload.turn === undefined ? 0 : payload.turn;
    const hit = detectEmptyTurnEnd(agent.session, turn);
    if (hit === null) return;
    if (typeof agent.steer !== 'function') { log('  收尾命中但 agent.steer 不可用，放行'); return; }
    const prev = budgets.get(agent);
    const count = (prev !== undefined && prev.turn === turn) ? prev.count + 1 : 1;
    budgets.set(agent, { turn: turn, count: count });
    if (count > config.maxEmptyTurnSteers) {
        log('  ★ 收尾兜底已达上限（' + config.maxEmptyTurnSteers + ' 次/回合），放行：turn=' + turn + ' ' + hit);
        return;
    }
    try {
        agent.steer(userMessage(EMPTY_TURN_TEXT, '循环守卫 · 空回合兜底'));
        log('  ★ 收尾兜底命中：turn=' + turn + ' ' + hit + '，已 steer（第 ' + count + ' 次）');
    } catch (e) {
        log('  ⚠️ 收尾兜底 steer 失败: ' + ((e && e.message) || e));
    }
}

/* ------------------------------------------------------------------ */
/* 八、挂载                                                             */
/* ------------------------------------------------------------------ */

/**
 * 挂载守卫。
 * @param ctx - Cordis 上下文（需要 llm 服务；agents 服务做能力探测，拿不到就只截断不 steer）。
 * @param given - 局部配置。
 */
export function apply(ctx, given) {
    const cfg = mergeConfig(given);
    const G = globalThis.__dshLoopGuard || (globalThis.__dshLoopGuard = { installed: false });
    if (G.installed) {
        log('已有实例在运行，跳过重复挂载（防止多层包装 / 重复注入）');
        return;
    }
    G.installed = true;
    const seen = new WeakSet();
    const detectors = new Map();

    function detectorFor(agent, options) {
        const key = agent || ('session:' + (options && options.sessionId));
        let d = detectors.get(key);
        if (d === undefined) { d = new LoopDetector(cfg); detectors.set(key, d); }
        return d;
    }

    let agentProbeWarned = false;
    function agentFor(options) {
        try {
            if (ctx && ctx.agents && typeof ctx.agents.get === 'function' && options.sessionId !== undefined) {
                return ctx.agents.get(options.sessionId);
            }
        } catch (e) {
            // 只提示一次，别每个流刷一行
            if (!agentProbeWarned) {
                agentProbeWarned = true;
                log('⚠️ 读不到 ctx.agents（inject 未声明该服务？）: ' + ((e && e.message) || e) + ' —— 截断照常，但不通知模型');
            }
        }
        return undefined;
    }

    try {
        ctx.on('llm/stream', async function* (options, next) {
            // 跳内部请求（摘要/压缩）与已处理过的同一个 options
            if (!options || typeof options !== 'object' || seen.has(options) || options.purpose !== undefined) {
                yield* next();
                return;
            }
            seen.add(options);
            const t0 = Date.now();
            const agent = agentFor(options);
            const detector = detectorFor(agent, options);
            const textBreaker = new TextRepetitionDetector(cfg);
            const reasonBreaker = new ReasoningLoopBreaker(cfg);
            const open = new Map();
            let reasoning = '';
            let hasOutput = false;
            let chunks = 0, reasonChars = 0, textChars = 0, firstAt = null, lastReasonAt = null;
            const types = {};
            let diagBuf = '', lowRatio = null;      // 诊断：保留压缩比作对照
            let broke = false, brokeRule = null, brokeAt = 0;

            try {
                for await (const chunk of next()) {
                    yield chunk;
                    if (!chunk || typeof chunk.type !== 'string') continue;
                    chunks++;
                    if (firstAt === null) firstAt = Date.now();
                    types[chunk.type] = (types[chunk.type] || 0) + 1;

                    if (chunk.type === 'block-start') {
                        open.set(chunk.index, { blockType: chunk.blockType, text: '' });
                        continue;
                    }
                    if (chunk.type === 'block-end') { open.delete(chunk.index); continue; }
                    if (chunk.type === 'tool-call-delta') { hasOutput = true; continue; }
                    if (typeof chunk.text !== 'string') continue;

                    if (chunk.type === 'text-delta') {
                        textChars += chunk.text.length;
                        hasOutput = true;
                        const b = open.get(chunk.index);
                        if (b !== undefined) b.text += chunk.text;
                    } else if (chunk.type === 'reasoning-delta') {
                        reasonChars += chunk.text.length;
                        lastReasonAt = Date.now();
                        reasoning += chunk.text;
                        const b2 = open.get(chunk.index);
                        if (b2 !== undefined) b2.text += chunk.text;
                        diagBuf += chunk.text;
                        if (diagBuf.length > 4800) diagBuf = diagBuf.slice(-2400);
                        if (diagBuf.length >= 1600) {
                            const r = compressRatio(diagBuf.slice(-2400));
                            if (lowRatio === null || r < lowRatio) lowRatio = r;
                        }
                    } else {
                        continue;
                    }

                    if (cfg.mode === 'watch') continue;
                    let hit = null;
                    if (chunk.type === 'text-delta') { if (textBreaker.push(chunk.text)) hit = textBreaker; }
                    else { if (reasonBreaker.push(chunk.text)) hit = reasonBreaker; }
                    if (hit === null) continue;

                    brokeRule = hit.trippedBy;
                    brokeAt = hit.repeatedChars;
                    if (cfg.mode === 'inject') {
                        broke = true;
                        log('★ 检出循环 [' + brokeRule + '] 重复 ' + brokeAt + ' 字 / 本次 ' + hit.emittedChars + ' 字 ⇒ 注入提示（对照）');
                        yield { type: 'reasoning-delta', index: chunk.index, text: '\n[循环守卫] ' + noticeFor(brokeRule, brokeAt) + '\n' };
                        continue;
                    }
                    const blocks = [];
                    for (const entry of open) blocks.push({ index: entry[0], blockType: entry[1].blockType, text: entry[1].text });
                    const tail = breakStream(agent, brokeAt, brokeRule, blocks, cfg);
                    if (tail === null) continue;
                    broke = true;
                    log('★ 检出循环 [' + brokeRule + '] 重复 ' + brokeAt + ' 字 / 本次 ' + hit.emittedChars + ' 字'
                        + '（已转发 ' + chunks + ' 个 chunk）⇒ 关块+stop 收尾'
                        + (agent ? '' : '（无 agent，未 steer）'));
                    for (const c of tail) yield c;
                    return;
                }
            } catch (e) {
                log('⚠️ 上游流抛错（原样上抛）: ' + ((e && e.message) || e));
                throw e;
            } finally {
                const total = Date.now() - t0;
                const ttfb = firstAt ? (firstAt - t0) : -1;
                const span = (lastReasonAt && firstAt) ? (lastReasonAt - firstAt) : 0;
                const top = Object.keys(types).sort(function (a, b) { return types[b] - types[a]; })
                    .slice(0, 6).map(function (k) { return k + '=' + types[k]; }).join(' ');
                log('stream' + (broke ? '【已截断 ' + brokeRule + '】' : '') + ' chunks=' + chunks + ' 耗时=' + total + 'ms 首块=' + ttfb + 'ms'
                    + ' reasoning=' + reasonChars + '字 text=' + textChars + '字 思维链跨度=' + span + 'ms'
                    + ' | 模式 ' + cfg.mode
                    + (lowRatio !== null ? (' 最低压缩比 ' + (lowRatio * 100).toFixed(1) + '%（仅供对照）') : ''));
                log('    类型: ' + (top || '(无)'));
            }

            // 流自然结束：跨调用判定
            if (!broke) {
                const stalled = detector.observe({ hasOutput: hasOutput, reasoning: reasoning });
                if (stalled !== undefined) log('  卡住的调用（' + stalled + '）累计 ' + detector.stalled + '/' + detector.threshold);
                const fire = detector.takeFire();
                if (fire !== undefined) react(agent, fire, cfg);
            }
        });

        // 收尾兜底（吸收 empty-turn-guard）：把「只有思考、没有正文」的回合拽回来。
        const budgets = new WeakMap();
        try {
            ctx.on('agent/turn-stopping', async function (payload) {
                try { considerEmptyTurn(payload, budgets, cfg); }
                catch (e) { log('  ⚠️ 收尾兜底异常（已放行）: ' + ((e && e.message) || e)); }
            });
        } catch (e) {
            log('  ⚠️ 注册 agent/turn-stopping 失败（收尾兜底不可用）: ' + ((e && e.message) || e));
        }
        log('已挂载 loop-guard · 模式=' + cfg.mode + ' 跨调用阈值=' + cfg.maxThinkingSteps + ' 次'
            + ' 推理周期=' + cfg.maxRepeatedReasoningCycleChars + '/' + cfg.minRepeatedReasoningCycleChars
            + ' 推理短语池=' + cfg.maxRepeatedReasoningLineChars + '/' + cfg.minRepeatedReasoningLineCoverage + '/' + cfg.minRepeatedReasoningLineConcentration
            + ' 正文周期=' + cfg.maxRepeatedCycleChars + '/' + cfg.minRepeatedCycleChars
            + ' 正文短语池=' + cfg.maxRepeatedTextLineChars + '/' + cfg.minRepeatedTextLineCoverage + '/' + cfg.minRepeatedTextLineConcentration
            + ' agent通知=' + cfg.escalate);
        try { if (ctx.logger && ctx.logger.info) ctx.logger.info('[loop-guard] 已挂载（模式 ' + cfg.mode + '）'); } catch (e) { /* 忽略 */ }
        if (ctx && typeof ctx.effect === 'function') {
            ctx.effect(function () { return function () { G.installed = false; log('已卸载，单例标记已交还'); }; });
        }
    } catch (e) {
        G.installed = false;
        log('挂载失败: ' + ((e && e.message) || e));
    }
}
