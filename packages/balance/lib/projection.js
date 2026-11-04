// lib/projection.js -- 余额 + 消费/用量投影（A 方案核心）
//
// 依据官方实现：@deepseek-ai/dsh-session-stats/lib/types/projection.js
//   { key, stateVersion, stateSchema, init, apply, wire:{viewSchema, view} }
//
// 与官方投影的唯一区别：官方状态完全由会话事件推导，而余额、累计消费、
// token 汇总都是【外部事实】—— 所以 apply 在每次会话事件时把主机侧缓存的
// 最新值带出去。刷新有延迟（等下一个会话事件），但这些数不需要秒级同步。
//
// ⚠️ 改了 apply/init 能产生的状态形状，就必须递增 stateVersion，
//    否则客户端会继续用持久化缓存里的旧结构。

import { z } from 'zod';

// 主机侧缓存（由 index.js 的两个定时器写入）
let cache = {
    // ── 余额（api.deepseek.com/user/balance）──
    currency: 'CNY',
    total: '--',
    granted: '0.00',
    toppedUp: '0.00',
    updatedAt: null,
    error: null,

    // ── 累计消费（platform /api/v0/users/get_user_summary）──
    totalCost: null,          // 字符串，官方原文（如 "172.86459434"）
    costCurrency: 'CNY',
    costUpdatedAt: null,
    costError: null,

    // ── 本地 token 汇总（扫 session_projcache）──
    totalTokens: null,
    tokenSessions: null,
    tokenUpdatedAt: null,
    tokenError: null,
};

/** 写入余额（不动其它字段）。 */
export function updateBalanceCache(next) {
    cache = {
        ...cache,
        currency: next.currency ?? 'CNY',
        total: next.total ?? '--',
        granted: next.granted ?? '0.00',
        toppedUp: next.toppedUp ?? '0.00',
        updatedAt: next.updatedAt ?? Date.now(),
        error: next.error ?? null,
    };
}

/** 写入累计消费。 */
export function updateUsageCache(next) {
    if (!next || next.ok !== true) {
        cache = {
            ...cache,
            costError: (next && next.error) || '查询失败',
            costUpdatedAt: Date.now(),
        };
        return;
    }
    cache = {
        ...cache,
        totalCost: next.totalCost ?? null,
        costCurrency: next.currency || 'CNY',
        costUpdatedAt: Date.now(),
        costError: null,
    };
}

/** 写入本地 token 汇总。 */
export function updateTokenCache(next) {
    if (!next || next.ok !== true) {
        cache = {
            ...cache,
            tokenError: (next && next.error) || '扫描失败',
            tokenUpdatedAt: Date.now(),
        };
        return;
    }
    cache = {
        ...cache,
        totalTokens: next.total ?? null,
        tokenSessions: next.sessions ?? null,
        tokenUpdatedAt: Date.now(),
        tokenError: null,
    };
}

/** 供调试。 */
export function readBalanceCache() {
    return cache;
}

const shape = {
    currency: z.string(),
    total: z.string(),
    granted: z.string(),
    toppedUp: z.string(),
    updatedAt: z.number().nullable(),
    error: z.string().nullable(),

    totalCost: z.string().nullable(),
    costCurrency: z.string(),
    costUpdatedAt: z.number().nullable(),
    costError: z.string().nullable(),

    totalTokens: z.number().nullable(),
    tokenSessions: z.number().nullable(),
    tokenUpdatedAt: z.number().nullable(),
    tokenError: z.string().nullable(),
};

const stateSchema = z.object(shape).strict();
const viewSchema = z.object(shape).strict();

/** 两个缓存是否等价（用于避免无谓的下游重算）。 */
function same(a, b) {
    for (const k of Object.keys(shape)) {
        if (a[k] !== b[k]) return false;
    }
    return true;
}

export const balanceProjectionDefinition = {
    key: 'deepseekBalance',
    stateVersion: 4,          // 3 → 4：状态里换成"官方累计消费 + 本地 token"
    stateSchema,
    init: () => ({ ...cache }),
    apply: (state, event) => {
        // 每个会话事件都是"把最新缓存吐出去"的机会。
        // 值没变则返回同一引用（Object.is 会拦住下游重算）。
        if (same(state, cache)) return state;
        return { ...cache };
    },
    wire: {
        viewSchema,
        view: (state) => {
            const out = {};
            for (const k of Object.keys(shape)) out[k] = state[k];
            return out;
        },
    },
};
