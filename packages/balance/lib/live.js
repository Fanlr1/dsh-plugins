// lib/live.js -- 实时账本（纯逻辑、零依赖）
//
// 【为什么单独一个文件】index.js 依赖 zod（投影 schema），离线 node 跑不起来；
// 把记账逻辑放这里，test-balance.mjs 就能直接自测。
//
// 【模型】显示值 = 基线 + 增量
//   · 基线 base：启动时从 session_projcache 扫到的历史累计（固定）
//   · 增量 delta：本进程启动后，每次 assistant/message 的 usage 累加
//   · 校准：projcache 比「基线+增量」还大 ⇒ 差额来自本进程之外 ⇒ 并进基线
//     （★ 只往上调，绝不把数算小 —— 宁可偏大，也不让用户以为花得少）

export function newMeter() {
    return { base: 0, baseSessions: 0, delta: 0, seen: new Set() };
}

/** 从 usage 里取总数（优先 totalTokens，退化到各项之和）。 */
export function usageTokens(usage) {
    if (!usage || typeof usage !== 'object') return 0;
    if (typeof usage.totalTokens === 'number') return usage.totalTokens;
    return (usage.inputTokens || 0) + (usage.cacheReadTokens || 0)
        + (usage.cacheWriteTokens || 0) + (usage.outputTokens || 0);
}

/** 记一条 usage；返回是否真的记账了。 */
export function addUsage(meter, usage, session) {
    const n = usageTokens(usage);
    if (!(n > 0)) return false;
    meter.delta += n;
    if (session !== undefined && session !== null) meter.seen.add(session);
    return true;
}

export function totalOf(meter) { return meter.base + meter.delta; }
export function sessionsOf(meter) { return meter.baseSessions + meter.seen.size; }

/**
 * 用一次 projcache 扫描结果校准。
 * 只有当扫描值【大于】我们的实时值时才动基线 —— 那说明有本进程之外的写入。
 * 相等或更小（落盘滞后）一律不动。
 */
export function calibrate(meter, scannedTotal, scannedSessions) {
    if (typeof scannedTotal !== 'number' || !(scannedTotal > totalOf(meter))) return false;
    meter.base = scannedTotal - meter.delta;
    meter.baseSessions = Math.max(0, (scannedSessions || 0) - meter.seen.size);
    return true;
}
