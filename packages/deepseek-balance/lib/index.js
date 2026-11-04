// dsh-plugin-balance -- host 侧（A 方案 + 真实余额 + 用量汇总）
//
// · 注册 deepseekBalance 投影（前端 useProjection 读）
// · 从 DSH 凭证读 DEEPSEEK_API_KEY，查 api.deepseek.com/user/balance
// · 扫描 ~/.dsh/storages/session_projcache 汇总本机全部会话的 token 用量
// · 两条定时器分别刷新，写进投影的缓存

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import {
    balanceProjectionDefinition,
    updateBalanceCache,
    updateUsageCache,
    updateTokenCache,
    readBalanceCache,
} from './projection.js';
import { scanUsage } from './usage.js';
import { newMeter, addUsage, totalOf, sessionsOf, calibrate } from './live.js';

const CRED_FILE = join(homedir(), '.dsh', '.credentials.yaml');
const REF_NAME = 'DEEPSEEK_API_KEY';
const PLATFORM_ORIGIN = 'https://platform.deepseek.com';

// 刷新间隔：余额会随每次调用下降，所以不能太慢。
// 60 秒是"看起来准"和"别把 API 打爆"之间的折中。
const REFRESH_MS = 60 * 1000;

// ★ 2026-10-15 改事件驱动：本地 token 不再靠「每 90 秒扫一次 projcache」——
//   那份文件本身就滞后（实测：会话内 usage 之和比它多 330/146560/2350）。
//   现在每次 assistant/message 的 usage 当场记账（吸收 dsh-cost-meter 的做法），
//   下面的低频扫描退化为【校准】，只用来兜住「本进程之外也在写 projcache」。
const CALIBRATE_MS = 5 * 60 * 1000;

/** 从 DSH 凭证文件读 API Key（只在主机侧使用，不传给前端）。 */
function readApiKey() {
    const text = readFileSync(CRED_FILE, 'utf8');
    // 凭证是简单 YAML：refs: 段下 <NAME>: <value>
    const re = new RegExp('^\\s*' + REF_NAME + ':\\s*(\\S+)\\s*$', 'm');
    const m = text.match(re);
    if (!m) throw new Error('凭证里没有 ' + REF_NAME);
    return m[1];
}

/**
 * 读 DSH 登录的 DeepSeek 账号 grant（不是 API Key）。
 * 它在 .credentials.yaml 的 deepseek-account-platform/default 段里。
 * 这是官方账号模块自己用的凭据，我们会话内只读它来查累计消费。
 */
function readAccountGrant() {
    const text = readFileSync(CRED_FILE, 'utf8');
    const i = text.indexOf('deepseek-account-platform/default');
    if (i < 0) return null;
    const seg = text.slice(i, i + 600);
    const tok = seg.match(/token:\s*(\S+)/);
    const iss = seg.match(/issuer:\s*(\S+)/);
    if (!tok) return null;
    return { token: tok[1], origin: (iss ? iss[1] : PLATFORM_ORIGIN).replace(/\/+$/, '') };
}

/**
 * 查 Platform 的账号汇总（累计消费）。
 *
 * 路径与认证方式取自 DSH 自己的账号模块：
 *   getProfile / getBalance 把 grant 放在 x-dsh-auth-token 头里，
 *   请求 {platformOrigin}/api/v0/users/get_user_summary
 * 返回里的 total_costs 就是【累计消费金额】。
 *
 * 注意：官方【公开 API】(api.deepseek.com) 只有 /user/balance，没有用量接口；
 * 这个是 Platform Web 的接口，靠 DSH 的登录态才通。
 * 也试过给它加 start_date / date / start_time 等参数，服务端一律忽略，
 * 所以"某一天的消费"无法直接查 —— 只能在本地每天记一次基线做差。
 */
function queryAccountSummary(grant) {
    return new Promise((resolve, reject) => {
        const u = new URL(grant.origin + '/api/v0/users/get_user_summary');
        const req = httpsRequest({
            host: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            headers: {
                'x-dsh-auth-token': grant.token,
                Accept: 'application/json',
            },
            timeout: 15000,
        }, (r) => {
            let d = '';
            r.on('data', (c) => { d += c; });
            r.on('end', () => {
                if (r.statusCode !== 200) {
                    return reject(new Error('HTTP ' + r.statusCode + ': ' + d.slice(0, 160)));
                }
                try {
                    const j = JSON.parse(d);
                    const biz = j && j.data && j.data.biz_data;
                    if (!biz) return reject(new Error('响应里没有 biz_data'));
                    const cost = (biz.total_costs || [])[0];
                    resolve({
                        totalCost: cost ? String(cost.amount) : null,
                        currency: cost ? cost.currency : 'CNY',
                    });
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.end();
    });
}

/** 查 DeepSeek 余额。返回 { currency, total, granted, toppedUp } */
function queryBalance(apiKey) {
    return new Promise((resolve, reject) => {
        const req = httpsRequest({
            host: 'api.deepseek.com',
            path: '/user/balance',
            method: 'GET',
            headers: {
                Authorization: 'Bearer ' + apiKey,
                Accept: 'application/json',
            },
            timeout: 15000,
        }, (r) => {
            let d = '';
            r.on('data', (c) => { d += c; });
            r.on('end', () => {
                if (r.statusCode !== 200) {
                    return reject(new Error('HTTP ' + r.statusCode + ': ' + d.slice(0, 200)));
                }
                try {
                    const j = JSON.parse(d);
                    const b = (j.balance_infos || [])[0];
                    if (!b) return reject(new Error('响应里没有 balance_infos'));
                    resolve({
                        currency: b.currency,
                        total: b.total_balance,
                        granted: b.granted_balance,
                        toppedUp: b.topped_up_balance,
                        available: j.is_available,
                    });
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.end();
    });
}

class BalanceService {
    constructor() {
        this.timer = null;
        this.usageTimer = null;
        this.lastError = null;
        // ── 实时账本 ──
        // 基线 = 启动时 projcache 里的历史累计（固定）；增量 = 本进程启动后的 usage。
        // 显示值 = 基线 + 增量 ⇒ 既含历史，又能做到「每次调用后立刻 +」。
        this.meter = newMeter();   // 实时账本（见 lib/live.js）
    }

    /** 把「基线 + 增量」推给投影。 */
    publishTokens() {
        updateTokenCache({
            ok: true,
            total: totalOf(this.meter),
            sessions: sessionsOf(this.meter),
        });
    }

    /** 会话事件到达 ⇒ usage 当场记账（不等下一个定时器）。 */
    onSessionEvent(session, event) {
        try {
            if (!event || event.type !== 'assistant/message') return;
            if (addUsage(this.meter, event.data && event.data.usage, session)) this.publishTokens();
        } catch (e) { /* 记账失败绝不影响会话 */ }
    }

    async refresh() {
        try {
            const key = readApiKey();
            const b = await queryBalance(key);
            this.lastError = null;
            updateBalanceCache({
                currency: b.currency,
                total: b.total,
                granted: b.granted,
                toppedUp: b.toppedUp,
                updatedAt: Date.now(),
            });
            console.log('[balance] 已刷新: ' + b.currency + ' ' + b.total +
                '（充值 ' + b.toppedUp + ' + 赠送 ' + b.granted + '）');
        } catch (e) {
            this.lastError = (e && e.message) || String(e);
            updateBalanceCache({ error: this.lastError });
            console.error('[balance] 刷新失败: ' + this.lastError);
        }

        // 累计消费（走账号 grant，失败不影响余额显示）
        try {
            const grant = readAccountGrant();
            if (!grant) {
                updateUsageCache({ ok: false, error: '未找到账号登录凭据' });
            } else {
                const s = await queryAccountSummary(grant);
                updateUsageCache({ ok: true, totalCost: s.totalCost, currency: s.currency });
                console.log('[balance] 累计消费: ' + (s.currency || 'CNY') + ' ' + s.totalCost);
            }
        } catch (e) {
            const msg = (e && e.message) || String(e);
            updateUsageCache({ ok: false, error: msg });
            console.error('[balance] 消费查询失败: ' + msg);
        }
    }

    /**
     * 本地 token 校准（低频）。
     * 事件记账只覆盖「本进程」；projcache 还可能含别的写入 ⇒ 取两者较大值，绝不把数算小。
     */
    async refreshUsage() {
        try {
            const u = await scanUsage();
            if (!u.ok) { updateTokenCache(u); return; }
            calibrate(this.meter, u.total, u.sessions);   // 只在扫描值更大时并进基线
            this.publishTokens();
            if (true) {
                console.log('[balance] 本地 token: ' + u.sessions + ' 个会话 · ' +
                    (u.total / 1e6).toFixed(1) + 'M');
            } else {
                console.error('[balance] token 扫描失败: ' + u.error);
            }
        } catch (e) {
            const msg = (e && e.message) || String(e);
            updateTokenCache({ ok: false, error: msg });
            console.error('[balance] token 扫描异常: ' + msg);
        }
    }

    start() {
        this.refresh();
        this.timer = setInterval(() => this.refresh(), REFRESH_MS);
        this.refreshUsage();   // 首次：建立历史基线（此时增量为 0）
        this.usageTimer = setInterval(() => this.refreshUsage(), CALIBRATE_MS);
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.usageTimer) { clearInterval(this.usageTimer); this.usageTimer = null; }
    }
}

export const name = 'balance';
export const inject = ['sessionProjections'];

export function apply(ctx) {
    console.log('[balance] apply() 开始');
    console.log('[balance] 凭证文件: ' + CRED_FILE);

    try {
        ctx.sessionProjections.register(balanceProjectionDefinition);
        console.log('[balance] ✅ 投影已注册: deepseekBalance');
    } catch (e) {
        console.error('[balance] ❌ 投影注册失败: ' + (e && e.message));
        if (e && e.stack) console.error(e.stack);
    }

    const svc = new BalanceService();
    // ★ 实时记账：会话事件一落，usage 立刻进账（不再依赖轮询）
    try {
        ctx.on('session/event', (session, event) => svc.onSessionEvent(session, event));
        console.log('[balance] ✅ 已挂 session/event（实时记账）');
    } catch (e) {
        console.error('[balance] ⚠️ 挂 session/event 失败（退回纯轮询）: ' + ((e && e.message) || e));
    }
    ctx.effect(() => {
        svc.start();
        return () => {
            svc.stop();
            console.log('[balance] 已停止刷新');
        };
    });
}
