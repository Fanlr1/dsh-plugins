// lib/usage.js -- 汇总本机所有会话的 token 用量
//
// 数据来源：DSH 的投影缓存
//   ~/.dsh/storages/session_projcache/sessions/*.json
// 每个文件里有 tokenUsage.val.totals（由官方 dsh-token-meter 维护）：
//   { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
//
// 为什么不读会话原文：它是 session.v3.jsonl.zstd（压缩），要解压才能读；
// 而投影缓存是明文 JSON，且已经是官方算好的累计值。
//
// 为什么不走 DeepSeek API：官方只有 /user/balance，没有用量接口
// （/user/usage、/usage、/dashboard/billing/usage 实测都是 404）。

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJCACHE_DIR = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');

// 官方空闲时段价（元 / 百万 token）。高峰时段翻倍，这里不区分 —— 界面标明是估算。
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
const PRICE_PER_M = { miss: 1, hit: 0.02, out: 4 };

/**
 * 扫描全部会话的投影缓存并汇总。
 * @returns 成功时 { ok:true, sessions, skipped, 四项 token, total, cost }
 *          失败时 { ok:false, error }
 */
export async function scanUsage() {
    let files;
    try {
        files = await readdir(PROJCACHE_DIR);
    } catch (e) {
        return { ok: false, error: '读不到投影缓存目录：' + ((e && e.message) || e) };
    }

    const sums = {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
    let sessions = 0;
    let skipped = 0;

    for (const f of files) {
        if (!f.endsWith('.json') || f.includes('.bak')) continue;
        let raw;
        try {
            raw = await readFile(join(PROJCACHE_DIR, f), 'utf8');
        } catch {
            skipped++;
            continue;
        }
        const i = raw.indexOf('"tokenUsage"');
        if (i < 0) { skipped++; continue; }
        // totals 紧跟 tokenUsage 出现，取一小段即可，不必 parse 整个大 JSON
        const m = raw.slice(i, i + 900).match(/"totals"\s*:\s*\{([^}]*)\}/);
        if (!m) { skipped++; continue; }
        let got = false;
        for (const kv of m[1].split(',')) {
            const mm = kv.match(/"(\w+)"\s*:\s*(\d+)/);
            if (mm && sums[mm[1]] !== undefined) {
                sums[mm[1]] += Number(mm[2]);
                got = true;
            }
        }
        if (got) sessions++;
        else skipped++;
    }

    const total = sums.uncachedInputTokens + sums.outputTokens +
        sums.cacheReadTokens + sums.cacheWriteTokens;
    const cost = sums.uncachedInputTokens / 1e6 * PRICE_PER_M.miss +
        sums.cacheReadTokens / 1e6 * PRICE_PER_M.hit +
        sums.outputTokens / 1e6 * PRICE_PER_M.out;

    return {
        ok: true,
        sessions,
        skipped,
        uncachedInputTokens: sums.uncachedInputTokens,
        outputTokens: sums.outputTokens,
        cacheReadTokens: sums.cacheReadTokens,
        cacheWriteTokens: sums.cacheWriteTokens,
        total,
        cost: Math.round(cost * 100) / 100,
        updatedAt: Date.now(),
    };
}
