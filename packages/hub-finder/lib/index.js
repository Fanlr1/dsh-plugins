// dsh-plugin-hub-finder -- host 侧
//
// 一个工具：find_dsh_plugin —— 中文搜索 DSH 社区插件，返回 GitHub 地址 + 中文简介 + 安装命令。
//
// ★ 为什么需要（2026-10-15 用户需求）：
//   "再看到有趣的插件项目，你能不能直接找到它的 GitHub 地址，不用我到处找链接"
//   ⇒ 装那个界面市场（dsh-plugin）解决不了这件事：它只挂 HTTP 路由 + 提供 UI，
//     **不注册任何 host 工具**，agent 这侧拿不到数据。
//
// ★ 数据源（从 dshplugin/dsh-plugin-hub 的 src/server/http/catalog.ts 里挖出的确切端点）：
//     https://api.dsh-plugin.org/plugins.zh.json    10.3 MB · 14,309 条 · 全中文字段
//     https://api.dsh-plugin.org/stats.json         { total, verified }
//   每条记录的关键字段（单字母，官方就是这么压的）：
//     r = "owner/repo"（GitHub 地址的原料）· d = 中文简介 · f = 中文功能要点数组
//     n = 包名 · o = owner · c = 分类 · t = topics · sg/fk = stars/forks
//     u = 更新时间 · vr = 版本 · ic = 安装命令 · v = verified
//   ⇒ 中文简介是数据自带的，不是翻译；搜索用本地关键词匹配即可（对比 GitHub search API
//     对中文分词很差、description 只有一行）。
//
// ★ 设计取舍：
//   · 全量 10.3 MB 拉一次 + 落盘缓存（TTL 1 小时，与它服务端的缓存口径一致）
//   · 用 curl 子进程拉（本机 Node 直连会撞 mitm 根证书 → UNABLE_TO_VERIFY_LEAF_SIGNATURE）
//   · 零第三方依赖
//   · 参数严格自校验（裸 ctx.tools.register 不做参数检查 —— 官方原话）
//   · output.schema 只用单一类型（DSH 不支持类型数组）+ 返回值逐字段过滤 undefined
//     （这两条都是我们踩过的坑，见 handbooks/dsh-plugin/01-插件开发上手.md §2.5）

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

export const name = 'hub-finder';
export const inject = ['tools'];

const INDEX_URL = 'https://api.dsh-plugin.org/plugins.zh.json';
const STATS_URL = 'https://api.dsh-plugin.org/stats.json';
const CACHE_FILE = process.env.HUB_FINDER_CACHE || join(os.homedir(), '.dsh', 'logs', 'dsh-plugin-index.json');
const TTL_MS = 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const KNOWN_ARGS = ['query', 'repo', 'sort', 'limit', 'category', 'refresh'];
const MAX_LIMIT = 30;            // 工具（find_dsh_plugin）的返回上限
const PAGE_LIMIT = 100;          // HTTP 路由的每页上限（UI 翻页用，比工具宽松）
const DEFAULT_LIMIT = 10;

function fileLog(msg) {
    try {
        const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
        if (!existsSync(dirname(CACHE_FILE))) mkdirSync(dirname(CACHE_FILE), { recursive: true });
        const old = existsSync(CACHE_FILE + '.log') ? readFileSync(CACHE_FILE + '.log', 'utf8') : '';
        writeFileSync(CACHE_FILE + '.log', (old + line).slice(-20000), 'utf8');
    } catch (e) { /* 静默 */ }
}

/** 参数严格自校验：未知键必须拒绝（裸注册会静默丢弃未知参数）。 */
export function validateArgs(args) {
    if (!args || typeof args !== 'object') throw new Error('invalid args: expected an object');
    for (const k of Object.keys(args)) {
        if (KNOWN_ARGS.indexOf(k) < 0) throw new Error('invalid arg "' + k + '": known args are ' + KNOWN_ARGS.join(', '));
    }
    let query = '';
    if (args.query !== undefined) {
        if (typeof args.query !== 'string') throw new Error('invalid query: expected a string');
        query = args.query.trim();
    }
    let repo = '';
    if (args.repo !== undefined) {
        if (typeof args.repo !== 'string') throw new Error('invalid repo: expected a string');
        repo = args.repo.trim();
    }
    if (!query && !repo) throw new Error('invalid args: 至少给一个 query（关键词）或 repo（owner/repo 或链接）');
    let sort = 'stars';
    if (args.sort !== undefined) {
        if (args.sort !== 'stars' && args.sort !== 'updated') throw new Error("invalid sort: expected 'stars' or 'updated'");
        sort = args.sort;
    }
    let limit = DEFAULT_LIMIT;
    if (args.limit !== undefined) {
        if (!Number.isFinite(args.limit) || args.limit <= 0) throw new Error('invalid limit: expected a positive number');
        limit = Math.min(Math.floor(args.limit), MAX_LIMIT);
    }
    let category = '';
    if (args.category !== undefined) {
        if (typeof args.category !== 'string') throw new Error('invalid category: expected a string');
        category = args.category.trim().toLowerCase();
    }
    if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new Error('invalid refresh: expected a boolean');
    return { query: query, repo: repo, sort: sort, limit: limit, category: category, refresh: args.refresh === true };
}

/**
 * 把各种写法归一成 "owner/repo"：
 *   owner/repo · https://github.com/owner/repo(.git) · https://dsh-plugin.org/plugins/owner/name
 * 认不出来返回 null（调用方再决定报错还是原样回显）。
 */
export function normalizeRepo(input) {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (!s) return null;
    s = s.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const gh = s.match(/github\.com[/:]+([^/\s]+)\/([^/\s?#]+)/i);
    if (gh) return gh[1] + '/' + gh[2];
    const hub = s.match(/dsh-plugin\.org\/plugins\/([^/\s]+)\/([^/\s?#]+)/i);
    if (hub) return hub[1] + '/' + hub[2];
    const bare = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (bare) return bare[1] + '/' + bare[2];
    return null;
}

/**
 * 取一条记录的 owner/repo。
 * ★ 2026-10-15 实测：索引里 r 字段【两种形状】—— 字符串（9714 条）或对象 { repo, npmPackage }（4595 条，占 32%）。
 *   直接 String(it.r) 会把那 32% 变成 "[object Object]"（UI 上就是这么暴露的）。
 */
export function repoOf(it) {
    let r = it && it.r;
    if (r && typeof r === 'object') r = r.repo || r.url || r.name || '';
    if (typeof r !== 'string' || !r) r = String((it && it.o) || '') + '/' + String((it && it.n) || '');
    return r;
}

/** 一条记录的可搜文本（包名 + 简介 + 要点 + topics + owner + 分类 + 对象的 r 里的 repo/npm 名）。 */
export function searchableText(item) {
    const parts = [item.n, item.s, item.o, item.c, item.d];
    if (item.r && typeof item.r === 'object') parts.push(item.r.repo, item.r.npmPackage);
    if (Array.isArray(item.f)) parts.push(item.f.join(' '));
    if (Array.isArray(item.t)) parts.push(item.t.join(' '));
    return parts.filter((x) => typeof x === 'string').join(' \n ').toLowerCase();
}

/** 多关键词 AND 匹配（空格分词；全部命中才算）。 */
export function matchItem(item, tokens) {
    if (!tokens || !tokens.length) return true;
    const hay = searchableText(item);
    for (const tk of tokens) {
        if (hay.indexOf(tk) < 0) return false;
    }
    return true;
}

/** 搜索 + 排序 + 截断。 */
export function searchIndex(items, opts) {
    const o = opts || {};
    const tokens = String(o.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    let list = items.filter((it) => matchItem(it, tokens));
    if (o.category) list = list.filter((it) => String(it.c || '').toLowerCase() === o.category);
    if (o.sort === 'updated') {
        list = list.slice().sort((a, b) => String(b.u || '').localeCompare(String(a.u || '')));
    } else {
        list = list.slice().sort((a, b) => (Number(b.sg) || 0) - (Number(a.sg) || 0));
    }
    return list.slice(0, o.limit || DEFAULT_LIMIT);
}

/** 渲染一条记录（给模型看）。 */
export function renderItem(item, idx) {
    const repo = repoOf(item);
    const lines = [];
    lines.push((idx ? (idx + '. ') : '') + '★ ' + (Number(item.sg) || 0) + '  ' + repo + (item.v ? '  [' + item.v + ']' : ''));
    lines.push('   GitHub: https://github.com/' + repo);
    if (item.d) lines.push('   简介: ' + String(item.d).slice(0, 400));
    if (Array.isArray(item.f) && item.f.length) lines.push('   要点: ' + item.f.slice(0, 6).join(' · ').slice(0, 400));
    const meta = [];
    if (item.c) meta.push('分类=' + item.c);
    if (item.vr) meta.push('版本=' + item.vr);
    if (item.u) meta.push('更新=' + String(item.u).slice(0, 10));
    if (item.fk) meta.push('fork=' + item.fk);
    if (meta.length) lines.push('   ' + meta.join(' · '));
    if (item.ic) lines.push('   安装: ' + item.ic);
    return lines.join('\n');
}

/** 渲染整次查询结果。 */
export function renderResults(list, meta) {
    const head = '匹配 ' + list.length + ' 条' + (meta && meta.total ? ('（索引共 ' + meta.total + ' 条' + (meta.age ? ' · 缓存 ' + meta.age + ' 分钟前' : '') + '）') : '');
    if (!list.length) {
        return head + '\n没找到。换个中文关键词试试（数据里的简介本身就是中文），或先用 repo 参数按 owner/repo 精确反查。';
    }
    return head + '\n\n' + list.map((it, i) => renderItem(it, i + 1)).join('\n\n');
}

/** 读缓存（含 TTL）；返回 { items, ageMs } 或 null。 */
export function readCache(file, ttlMs, now) {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (!raw || !Array.isArray(raw.items) || typeof raw.at !== 'number') return null;
        const age = (now || Date.now()) - raw.at;
        if (ttlMs !== Infinity && age > ttlMs) return null;
        return { items: raw.items, ageMs: age };
    } catch (e) { return null; }
}

export function writeCache(file, items, now) {
    try {
        if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ at: now || Date.now(), items: items }), 'utf8');
        return true;
    } catch (e) { return false; }
}

/** 用 curl 拉一个 URL 的全文（Node 直连会撞本机 mitm 根证书）。 */
export function curlGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        let child;
        try {
            child = spawn('curl', ['-sS', '-m', String(Math.round((timeoutMs || 60000) / 1000)), '-A', UA, url], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) { reject(e); return; }
        child.stdout.on('data', (c) => { out += String(c); });
        child.stderr.on('data', (c) => { err += String(c); });
        child.on('error', (e) => reject(e));
        child.on('close', (code) => {
            if (code === 0 && out.length > 0) resolve(out);
            else reject(new Error('curl exit=' + code + (err ? (' ' + err.slice(0, 200)) : '')));
        });
    });
}

/** 取索引：缓存命中直接用；否则拉远程（可选强制刷新）。 */
export async function loadIndex(opts) {
    const o = opts || {};
    if (!o.refresh) {
        const hit = readCache(CACHE_FILE, TTL_MS);
        if (hit) return { items: hit.items, ageMs: hit.ageMs, source: 'cache' };
    }
    const body = await curlGet(INDEX_URL, 90000);
    const items = JSON.parse(body);
    if (!Array.isArray(items)) throw new Error('索引格式不对：顶层不是数组');
    writeCache(CACHE_FILE, items);
    return { items: items, ageMs: 0, source: 'remote' };
}

/** 构造工具定义（含 output 声明 —— 漏了 register 直接抛错）。 */
export function finderDefinition(deps) {
    const d = deps || {};
    // 说明：execute 返回结构化 value，由 output.render 转成 content
    const value = (text, extra) => {
        const base = { text: text, content: [{ type: 'text', text: text }] };
        if (extra) { for (const k of Object.keys(extra)) { if (extra[k] !== undefined) base[k] = extra[k]; } }
        return base;
    };
    return {
        name: 'find_dsh_plugin',
        description: [
            '在 DSH 社区插件目录里搜索（数据源 api.dsh-plugin.org，14,000+ 条，简介本身就是中文）。',
            '给 query 就是中文/英文关键词搜索；给 repo 就是按 owner/repo 或链接精确反查。',
            '返回：GitHub 地址、中文简介、中文功能要点、stars、分类、更新时间与安装命令。',
            '★ 用途：用户提到"某个 DSH 插件"时，用它直接拿到 GitHub 地址，不必让用户去找链接。',
            '不确定关键词时先用宽泛的中文词（如"图表""终端""余额"），再用 limit 收窄。',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词（中文即可，空格分词，全部命中才返回）。' },
                repo: { type: 'string', description: '精确反查：owner/repo、github.com 链接或 dsh-plugin.org 链接。' },
                sort: { type: 'string', enum: ['stars', 'updated'], description: '排序：stars（默认）或 updated。' },
                limit: { type: 'number', description: '返回条数（默认 10，上限 30）。' },
                category: { type: 'string', description: '限定分类（如 model / ui / tool / session）。' },
                refresh: { type: 'boolean', description: '忽略缓存强制重拉（默认 false，缓存 1 小时）。' },
            },
            additionalProperties: false,
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const v = validateArgs(args);
            let idx;
            try {
                idx = await (d.loadIndex ? d.loadIndex({ refresh: v.refresh }) : loadIndex({ refresh: v.refresh }));
            } catch (e) {
                return value('取插件索引失败: ' + ((e && e.message) || e) + '\n（可以先试 refresh: true 重拉；仍失败说明网络/端点不可用）');
            }
            const items = idx.items;
            const meta = { total: items.length, age: Math.round(idx.ageMs / 60000) };
            if (v.repo) {
                const want = normalizeRepo(v.repo);
                if (!want) return value('看不懂这个 repo 参数：' + v.repo + '\n给 owner/repo、GitHub 链接或 dsh-plugin.org 链接都行。');
                const hit = items.filter((it) => String(it.r || '').toLowerCase() === want.toLowerCase());
                if (!hit.length) {
                    return value('索引里没有 ' + want + '（可能未被收录）。\nGitHub 地址仍然可以拼出来：https://github.com/' + want + '\n想确认它是不是 DSH 插件：去仓库看有没有 dsh-plugin topic。');
                }
                return value(renderItem(hit[0], 0) + '\n（来自 ' + meta.total + ' 条索引 · 缓存 ' + meta.age + ' 分钟前）', { repo: want, stars: Number(hit[0].sg) || 0 });
            }
            const list = searchIndex(items, { query: v.query, sort: v.sort, limit: v.limit, category: v.category });
            return value(renderResults(list, meta), { count: list.length, total: meta.total });
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: { text: { type: 'string' } },
                required: ['text'],
            },
            render: (_args, v) => [{ type: 'text', text: String((v && v.text) || '') }],
        },
    };
}

// ==================== host 侧只读 HTTP 路由（给「插件市场」UI 用） ====================
//
// ★ 为什么要有这层：client 插件跑在浏览器里，读不到 host 的文件系统；
//   索引（10.3 MB / 14,309 条）在 host 侧 ⇒ 必须由 host 提供同源只读路由，UI 才能查。
//   这也是那个 dsh-plugin 界面市场的架构（它挂 /dsh-plugin-hub/catalog）。
//
// ★ 安全边界：
//   · 只收 loopback（remoteAddress + Host 头双重校验，照 dsh-plugin-session-tidy 的做法）
//   · 只读：两个 GET，不接受任何写操作，不碰 profile、不装卸任何插件
//   · 参数复用工具那套（searchIndex / normalizeRepo），行为与 find_dsh_plugin 完全一致

/** 只允许本机访问（remoteAddress 与 Host 头都要是 loopback）。 */
export function isLoopback(req) {
    const a = req && req.socket && req.socket.remoteAddress;
    const okAddr = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
    if (!okAddr) return false;
    const h = String((req.headers && req.headers.host) || '').split(':')[0].toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

function sendJson(res, code, obj) {
    try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
    } catch (e) { /* 连接已断，忽略 */ }
}

/** 一条索引记录 → 给 UI 的精简形状（字段名直白，省得 UI 去记单字母）。 */
export function toWire(it) {
    const repo = repoOf(it);
    return {
        repo: repo,
        url: 'https://github.com/' + repo,
        name: it.n || '',
        desc: it.d || '',
        features: Array.isArray(it.f) ? it.f.slice(0, 6) : [],
        stars: Number(it.sg) || 0,
        forks: Number(it.fk) || 0,
        category: it.c || '',
        version: it.vr || '',
        updated: String(it.u || '').slice(0, 10),
        install: it.ic || '',
        verified: it.v || '',
    };
}

/** 挂两个只读路由：/hub-finder/search 与 /hub-finder/stats。返回 disposer。 */
/**
 * 扫描 \\llm\\dsh-plugin-*\\package.json 取【自研插件】的包名。
 * 用途：插件页的类别徽章要区分「官方 / 自研 / 第三方」—— client 读不到文件系统，
 * 所以由 host 提供这份名单（本机事实，硬编码基目录可接受）。
 */
export function selfPluginNames() {
    const base = process.env.DSH_PLUGIN_DIR || join(os.homedir(), 'llm');
    const names = [];
    try {
        for (const e of readdirSync(base, { withFileTypes: true })) {
            if (!e.isDirectory() || !e.name.startsWith('dsh-plugin-')) continue;
            try {
                const j = JSON.parse(readFileSync(join(base, e.name, 'package.json'), 'utf8'));
                if (j && typeof j.name === 'string' && j.name) names.push(j.name);
            } catch (err) { /* 单个包读不动就跳过 */ }
        }
    } catch (e) { /* 目录不可读 -> 空名单（client 会退化成"第三方"） */ }
    return names.sort();
}

export function registerRoutes(ctx) {
    const guard = (req, res) => {
        if (isLoopback(req)) return true;
        sendJson(res, 403, { ok: false, error: 'forbidden', message: '仅允许本机访问' });
        return false;
    };
    const disposeSearch = ctx.webServer.register({
        kind: 'exact',
        path: '/hub-finder/search',
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
            try {
                const u = new URL(req.url || '/', 'http://localhost');
                const repo = u.searchParams.get('repo') || '';
                const sort = u.searchParams.get('sort') === 'updated' ? 'updated' : 'stars';
                const rawLimit = Number(u.searchParams.get('limit'));
                const rawOffset = Number(u.searchParams.get('offset'));
                const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), PAGE_LIMIT) : DEFAULT_LIMIT;
                const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
                const idx = await loadIndex({ refresh: u.searchParams.get('refresh') === '1' });
                const items = idx.items;
                const base = { ok: true, total: items.length, ageMin: Math.round(idx.ageMs / 60000), count: 0, items: [] };
                if (repo) {
                    const want = normalizeRepo(repo);
                    if (!want) { sendJson(res, 400, { ok: false, error: 'bad repo' }); return; }
                    const hit = items.filter((it) => String(it.r || '').toLowerCase() === want.toLowerCase());
                    base.matched = hit.length;
                    base.offset = 0;
                    base.limit = limit;
                    base.items = hit.slice(0, limit).map(toWire);
                    base.count = base.items.length;
                    base.githubFallback = 'https://github.com/' + want;
                    sendJson(res, 200, base);
                    return;
                }
                // ★ 先全量匹配再切片：内存里过滤 1.4 万条是毫秒级，
                //   这样才能给出【真正的匹配总数】（UI 的翻页要靠它算页数）。
                //   旧版直接把 limit 传给 searchIndex，UI 只能显示"索引共 N 条"，看着像匹配数，其实是索引总量。
                const all = searchIndex(items, { query: u.searchParams.get('q') || '', sort: sort, limit: Number.MAX_SAFE_INTEGER, category: u.searchParams.get('category') || '' });
                base.matched = all.length;
                base.offset = offset;
                base.limit = limit;
                base.items = all.slice(offset, offset + limit).map(toWire);
                base.count = base.items.length;
                sendJson(res, 200, base);
            } catch (e) {
                sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) });
            }
        },
    });
    const disposeSelf = ctx.webServer.register({
        kind: 'exact',
        path: '/hub-finder/self-plugins',
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
            try {
                const names = selfPluginNames();
                sendJson(res, 200, { ok: true, count: names.length, names: names });
            } catch (e) { sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) }); }
        },
    });
    const disposeStats = ctx.webServer.register({
        kind: 'exact',
        path: '/hub-finder/stats',
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
            try {
                const hit = readCache(CACHE_FILE, Infinity);
                sendJson(res, 200, { ok: true, cached: !!hit, total: hit ? hit.items.length : 0, ageMin: hit ? Math.round(hit.ageMs / 60000) : null });
            } catch (e) { sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) }); }
        },
    });
    return () => {
        try { disposeSearch && disposeSearch(); } catch (e) { /* 忽略 */ }
        try { disposeSelf && disposeSelf(); } catch (e) { /* 忽略 */ }
        try { disposeStats && disposeStats(); } catch (e) { /* 忽略 */ }
    };
}
export function apply(ctx) {
    try {
        const dispose = ctx.tools.register(finderDefinition());
        ctx.effect(() => () => { try { dispose?.(); } catch (e) { /* 忽略 */ } });
        try { ctx.logger?.info?.('[hub-finder] 已注册 find_dsh_plugin 工具'); } catch (e) { /* 静默 */ }
        fileLog('已注册 find_dsh_plugin 工具');
        // ★ webServer 是【可选】依赖：不存在（纯 CLI 等）时跳过，绝不影响工具注册。
        //   不能写进 inject —— 那会让插件在无 webServer 的环境里根本不加载。
        try {
            ctx.inject(['webServer'], (c) => {
                try {
                    const d = registerRoutes(c);
                    c.effect(() => () => { try { d && d(); } catch (e) { /* 忽略 */ } }, 'hub-finder: http routes');
                    fileLog('已挂载只读路由 /hub-finder/search 与 /hub-finder/stats（给插件市场 UI 用）');
                    try { ctx.logger?.info?.('[hub-finder] 已挂载 /hub-finder/search 只读路由'); } catch (e) { /* 忽略 */ }
                } catch (e) { fileLog('路由挂载失败: ' + ((e && e.message) || e)); }
            });
        } catch (e) { fileLog('ctx.inject([webServer]) 不可用: ' + ((e && e.message) || e)); }
    } catch (e) {
        try { ctx.logger?.error?.('[hub-finder] 注册失败: ' + ((e && e.message) || e)); } catch (e2) { /* 静默 */ }
        fileLog('注册失败: ' + ((e && e.message) || e));
    }
}
