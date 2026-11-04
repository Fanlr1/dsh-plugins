// dsh-plugin-multi-edit -- host 侧
//
// 一个工具：multi_edit —— 一次调用完成【多处 / 多文件】编辑。
//
// ★ 为什么需要（2026-10-14 实证）：内置 edit 一次只能改一个文件的一处。
//   当晚把库里 7 处「14 个插件」改成 16，我调用了 10 次 edit；每改一份文档又要单独一次。
//   每次往返都得重新读文件、重述 old_string、等结果 —— 纯浪费。
//
// ★ 它比 dsh-ops 的 ops_replace 强在哪（同一件事的不同做法）：
//   ① 两阶段提交：先把【所有】编辑在内存里预检 + 试应用，全部通过才写盘
//      ⇒ 不会出现「前面文件改了、后面失败」的半成品；ops_replace 是逐文件改。
//   ② 同一文件的多条编辑按顺序在内存副本上生效（后一条能看到前一条的结果）
//      ⇒ 一个文件里改多处，也只写盘一次。
//   ③ 逐项结果 + 汇总：哪条失败、为什么失败，一眼看清。
//
// ★ 与内置 edit 保持一致的字段名（file_path / old_string / new_string / replace_all），
//   模型不用学新词。
//
// ★ 踩坑点（写的时候注意，改的时候别丢）：
//   · 裸 ctx.tools.register() 注册的工具【不做参数校验】（官方原话）⇒ 这里必须自校验
//   · 保留原文件的 BOM（我们的 .ps1 / .cmd 有 BOM 需求，写回时不能丢）
//   · 读进来什么样写回去什么样（不做换行/编码转换）
//   · isConcurrencySafe 必须 false（写文件）

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';

export const name = 'multi-edit';
export const inject = ['tools'];

const BOM_CHAR = String.fromCharCode(0xFEFF);
const KNOWN_ARGS = ['edits', 'dryRun', 'onError'];
const ITEM_ARGS = ['file_path', 'old_string', 'new_string', 'replace_all'];

/** 数一个子串出现几次（不做正则，字面匹配，与内置 edit 一致）。 */
export function countOccurrences(hay, needle) {
    if (!needle) return 0;
    let n = 0;
    let i = hay.indexOf(needle);
    while (i >= 0) { n++; i = hay.indexOf(needle, i + needle.length); }
    return n;
}

/** 严格自校验（裸 register 不校验 ⇒ 未知键必须拒绝，不能静默丢）。 */
export function validateArgs(args) {
    if (!args || typeof args !== 'object') throw new Error('invalid args: expected an object');
    for (const k of Object.keys(args)) {
        if (KNOWN_ARGS.indexOf(k) < 0) throw new Error('invalid arg "' + k + '": known args are ' + KNOWN_ARGS.join(', '));
    }
    if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error('invalid edits: expected a non-empty array');
    if (args.edits.length > 200) throw new Error('invalid edits: at most 200 entries per call');
    const edits = args.edits.map((raw, i) => {
        if (!raw || typeof raw !== 'object') throw new Error('invalid edits[' + i + ']: expected an object');
        for (const k of Object.keys(raw)) {
            if (ITEM_ARGS.indexOf(k) < 0) throw new Error('invalid edits[' + i + '].' + k + ': known keys are ' + ITEM_ARGS.join(', '));
        }
        for (const k of ['file_path', 'old_string', 'new_string']) {
            if (typeof raw[k] !== 'string') throw new Error('invalid edits[' + i + '].' + k + ': expected a string');
        }
        if (raw.file_path.trim() === '') throw new Error('invalid edits[' + i + '].file_path: empty');
        if (raw.old_string === '') throw new Error('invalid edits[' + i + '].old_string: empty（空串会到处命中）');
        return {
            file_path: raw.file_path,
            old_string: raw.old_string,
            new_string: raw.new_string,
            replace_all: raw.replace_all === true,
        };
    });
    let onError = 'stop';
    if (args.onError !== undefined) {
        if (args.onError !== 'stop' && args.onError !== 'continue') throw new Error("invalid onError: expected 'stop' or 'continue'");
        onError = args.onError;
    }
    return { edits: edits, dryRun: args.dryRun === true, onError: onError };
}

/**
 * 两阶段执行。
 * @returns {{ dryRun: boolean, onError: string, results: Array, written: string[], aborted: boolean }}
 */
export function planAndApply(edits, opts) {
    const o = opts || {};
    const files = new Map();   // path -> { original, text, hasBom }
    const results = [];
    let aborted = false;

    // 阶段 1：预检 + 在内存副本上顺序试应用
    for (let i = 0; i < edits.length; i++) {
        const it = edits[i];
        const rec = { index: i, file_path: it.file_path, ok: false, replaced: 0 };
        results.push(rec);
        try {
            let f = files.get(it.file_path);
            if (!f) {
                if (!existsSync(it.file_path)) throw new Error('文件不存在');
                if (!statSync(it.file_path).isFile()) throw new Error('不是普通文件');
                const buf = readFileSync(it.file_path);
                const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
                const text = buf.toString('utf8');
                f = { original: text, text: hasBom ? text.slice(1) : text, hasBom: hasBom };
                files.set(it.file_path, f);
            }
            const occ = countOccurrences(f.text, it.old_string);
            if (occ === 0) throw new Error('old_string 未命中（文件内容与预期不一致？）');
            if (occ > 1 && !it.replace_all) throw new Error('old_string 命中 ' + occ + ' 处，需显式 replace_all: true');
            f.text = it.replace_all
                ? f.text.split(it.old_string).join(it.new_string)
                : f.text.replace(it.old_string, it.new_string);
            rec.ok = true;
            rec.replaced = it.replace_all ? occ : 1;
        } catch (e) {
            rec.error = String((e && e.message) || e);
            if (o.onError === 'stop') { aborted = true; break; }   // 停止后续预检
        }
    }

    // 阶段 2：写盘（stop 模式下有任何失败 ⇒ 一份都不写）
    const written = [];
    const anyFail = results.some((r) => !r.ok);
    const mayWrite = !(o.onError === 'stop' && anyFail);
    if (mayWrite && !o.dryRun) {
        for (const [path, f] of files) {
            if (f.text === f.original) continue;                    // 内容没变就别动 mtime
            try {
                writeFileSync(path, f.hasBom ? (BOM_CHAR + f.text) : f.text, 'utf8');
                written.push(path);
            } catch (e) {
                // 写盘失败要如实反映到结果里（把该文件的成功项改成失败）
                for (const r of results) {
                    if (r.ok && r.file_path === path) { r.ok = false; r.error = '写入失败: ' + ((e && e.message) || e); }
                }
            }
        }
    }
    return { dryRun: o.dryRun === true, onError: o.onError || 'stop', results: results, written: written, aborted: aborted };
}

/** 渲染给模型看的汇总。 */
export function renderSummary(plan) {
    const okCount = plan.results.filter((r) => r.ok).length;
    const failCount = plan.results.length - okCount;
    const totalReplaced = plan.results.reduce((s, r) => s + (r.ok ? r.replaced : 0), 0);
    const head = (plan.dryRun ? '[dryRun] ' : '') + plan.results.length + ' 条编辑 · 成功 ' + okCount + ' · 失败 ' + failCount
        + ' · 共替换 ' + totalReplaced + ' 处' + (plan.dryRun ? '（未落盘）' : (' · 写入 ' + plan.written.length + ' 个文件'));
    const lines = [head];
    if (plan.aborted) lines.push('（onError=stop：有一条失败 ⇒ 已中止，且【一份都没写】）');
    for (const r of plan.results) {
        lines.push((r.ok ? '  OK   ' : '  FAIL ') + r.file_path + (r.ok ? ('  ' + r.replaced + ' 处') : ('  ' + r.error)));
    }
    if (!plan.dryRun && plan.written.length) lines.push('写入：' + plan.written.join(' , '));
    return lines.join('\n');
}

export const MULTI_EDIT_DESCRIPTION = [
    '一次调用完成【多处 / 多文件】编辑（内置 edit 一次只能改一个文件的一处）。',
    'edits 是数组，每项 { file_path, old_string, new_string, replace_all? }，按顺序应用 —— 同一文件的多条会依次生效（后一条看到前一条的结果），该文件只写盘一次。',
    '★ 两阶段：先把所有编辑在内存里预检并试应用，再统一写盘 ⇒ 不会出现「改了一半」的半成品。',
    "onError='stop'（默认）：任何一条预检失败 ⇒ 一份都不写；onError='continue'：写成功的那部分，失败的逐条报出来。",
    'dryRun=true：只报告每条会替换几处，不落盘（改重要文件前先用它看一眼）。',
    '★ 适用：批量改值/批量重命名（同一说法散落在 N 个文件）、一个文件里改多处。',
    '★ 不适用：需要先看内容再决定怎么改的 —— 那要先 read / grep，别盲改。',
    'old_string 必须字面精确匹配；命中多处时必须显式 replace_all: true（防止误伤）。',
].join(' ');

export const MULTI_EDIT_PARAMETERS = {
    type: 'object',
    properties: {
        edits: {
            type: 'array',
            minItems: 1,
            description: '编辑列表，按顺序应用。',
            items: {
                type: 'object',
                properties: {
                    file_path: { type: 'string', description: '要改的文件路径。' },
                    old_string: { type: 'string', description: '要被替换的字面文本（必须精确匹配、非空）。' },
                    new_string: { type: 'string', description: '替换成什么（可为空串 = 删除）。' },
                    replace_all: { type: 'boolean', description: 'old_string 命中多处时是否全部替换（默认 false，多处会报错）。' },
                },
                required: ['file_path', 'old_string', 'new_string'],
                additionalProperties: false,
            },
        },
        dryRun: { type: 'boolean', description: '只预演不落盘（默认 false）。' },
        onError: { type: 'string', enum: ['stop', 'continue'], description: "失败策略：'stop' 全部不写（默认），'continue' 写成功部分。" },
    },
    required: ['edits'],
    additionalProperties: false,
};

export function multiEditDefinition() {
    return {
        name: 'multi_edit',
        description: MULTI_EDIT_DESCRIPTION,
        parameters: MULTI_EDIT_PARAMETERS,
        isConcurrencySafe: () => false,     // 写文件 ⇒ 不能并发
        execute: async (args) => {
            const v = validateArgs(args);
            const plan = planAndApply(v.edits, { dryRun: v.dryRun, onError: v.onError });
            const text = renderSummary(plan);
            const okCount = plan.results.filter((r) => r.ok).length;
            return {
                text: text,
                content: [{ type: 'text', text: text }],   // 兼容：render 用 text，老路径用 content
                ok: okCount,
                failed: plan.results.length - okCount,
                written: plan.written.length,
                dryRun: plan.dryRun,
            };
        },
        // ★ 必须声明（裸 register 要求 output；漏了会直接抛错）
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    text: { type: 'string' },
                    ok: { type: 'number' },
                    failed: { type: 'number' },
                    written: { type: 'number' },
                    dryRun: { type: 'boolean' },
                },
                required: ['text'],
            },
            render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
        },
    };
}

export function apply(ctx) {
    try {
        const dispose = ctx.tools.register(multiEditDefinition());
        ctx.effect(() => () => { try { dispose?.(); } catch (e) { /* 忽略 */ } });
        try { ctx.logger?.info?.('[multi-edit] 已注册 multi_edit 工具'); } catch (e) { /* 静默 */ }
    } catch (e) {
        try { ctx.logger?.error?.('[multi-edit] 注册失败: ' + ((e && e.message) || e)); } catch (e2) { /* 静默 */ }
    }
}
