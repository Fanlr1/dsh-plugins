// dsh-plugin-session-tidy -- host 侧
//
// 为什么需要它：官方【只归档不删除】（dsh-client-ui-workspace README：
// 「会话可以归档但绝不会被删除」；dsh-session-persistence-jsonl：「seam 无删除接口」），
// 而 archiveSession 只是往注册表塞 id —— 文件仍在原地，不省空间。
//
// 删除动作【可恢复】：移到 ~/.dsh/sessions-trash/<时间戳>/，再由用户显式清空。
//
// 三条保护（用户 2026-10-13 定）：
//   ① 置顶会话        ← ~/.dsh/storages/workspace.json 的 global.pinnedSessionIds（只读）
//   ② 正在运行的会话  ← ctx.agents.list() 的 session.id
//   ③ mtime 兜底      ← RECENT_MS 内动过的一律禁选
// 前两条【前端禁选 + 后端拒绝】双重校验 —— 前端只是提示，后端才是闸门。
//
// 来源检查：只接受 loopback（远程 / tls-proxy 反代一律 403）。

import { readdir, stat, mkdir, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'session-tidy';

/** webServer 承载路由；agents 用来识别"正在运行的会话"（拿不到就退化为只靠 mtime）。 */
export const inject = ['webServer', 'agents'];

const DSH = join(homedir(), '.dsh');
const SESSIONS = join(DSH, 'sessions');
const TRASH = join(DSH, 'sessions-trash');
const WORKSPACE_JSON = join(DSH, 'storages', 'workspace.json');

/** 最近这么久内动过的会话禁选（保护正在进行的对话）。 */
const RECENT_MS = 10 * 60 * 1000;

const SESSION_FILE = 'session.v4.jsonl.zstd';

/** 只认本机回环来源：远程（含反代）一律拒绝。 */
function isLoopback(req) {
    const a = req.socket && req.socket.remoteAddress;
    const ok = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
    if (!ok) return false;
    const host = String(req.headers.host || '');
    const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function sendJson(res, code, body) {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
}

async function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let d = '';
        req.on('data', (chunk) => {
            d += chunk;
            if (d.length > limit) { reject(new Error('body too large')); req.destroy(); }
        });
        req.on('end', () => resolve(d));
        req.on('error', reject);
    });
}

async function dirBytes(dir) {
    let total = 0;
    async function walk(d) {
        let entries;
        try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else { try { total += (await stat(p)).size; } catch { /* 忽略 */ } }
        }
    }
    await walk(dir);
    return total;
}

/** 工作区转义名 ⇒ 可读路径（--C-Users-x-Desktop-~7BA1~5BB6-- ⇒ C:\Users\x\Desktop\管家）。 */
export function decodeWorkspace(name) {
    const core = name.replace(/^--/, '').replace(/--$/, '');
    return core
        .replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/^([A-Za-z])-/, '$1:\\')   // 盘符：C-Users ⇒ C:\Users
        .replace(/-/g, '\\');
}

/**
 * 读 DSH 的 workspace 注册表（**只读，绝不写**）。
 * 返回 { pinned:Set, archived:Set, titles:Map<sessionId,title> }，失败时返回空集合。
 */
export async function readRegistry() {
    const pinned = new Set();
    const archived = new Set();
    const titles = new Map();
    try {
        const j = JSON.parse(await readFile(WORKSPACE_JSON, 'utf8'));
        for (const id of j?.global?.pinnedSessionIds ?? []) pinned.add(String(id));
        for (const id of j?.global?.archivedSessionIds ?? []) archived.add(String(id));
        for (const w of Object.values(j?.tables?.workspaces ?? {})) {
            for (const sid of w?.sessionIds ?? []) if (!titles.has(String(sid))) titles.set(String(sid), String(w?.title ?? ''));
        }
    } catch { /* 注册表不可读 ⇒ 空保护集合，靠 mtime 兜底 */ }
    return { pinned, archived, titles };
}

/**
 * 正在【运行】的会话 id —— 判据是 agent.status === 'running'。
 *
 * ★ 2026-10-14 修 bug（用户："没在运行的会话也被提示正在运行、拒绝删除"）：
 *   agents.list() 返回的是【所有 live agent】（官方注释原文：All live agents, in registration
 *   order）—— 会话切走或结束后 agent 仍会驻留，只看"存在"必然把整屏历史会话误判成"正在运行"。
 *   官方的 AgentStatus 是【二元】的：'idle' | 'running'
 *   （原句：export type AgentStatus = 'idle' | 'running'，见 extensions/tool-cordis 的 api-catalog）
 *   ⇒ 只把 running 当运行；idle 的只是驻留，可以删。
 *   拿不到 status 时【放行】：宁可让用户删掉已结束的会话，也不要把列表全锁死；
 *   真正在写的文件还有 mtime 与 rename 失败两道兜底。
 */
export function activeSessionIds(ctx) {
    const out = new Set();
    try {
        for (const agent of ctx?.get?.('agents')?.list?.() ?? []) {
            const id = agent?.session?.id ?? agent?.sessionId;
            if (!id) continue;
            if (agent && agent.status === 'running') out.add(String(id));
        }
    } catch { /* 拿不到就不保护这一维 */ }
    return out;
}

/**
 * 扫出所有会话（含不可删的，带标记 —— 让用户看到"为什么删不了"）。
 * @returns { sessions, totalBytes, deletableBytes }
 */
export async function scanSessions(opts = {}) {
    const now = opts.now ?? Date.now();
    const pinned = opts.pinned ?? new Set();
    const archived = opts.archived ?? new Set();
    const active = opts.active ?? new Set();
    const titles = opts.titles ?? new Map();

    const out = [];
    let workspaces = [];
    try { workspaces = await readdir(SESSIONS, { withFileTypes: true }); } catch { return { sessions: [], totalBytes: 0, deletableBytes: 0 }; }

    for (const w of workspaces) {
        if (!w.isDirectory()) continue;
        const wdir = join(SESSIONS, w.name);
        let sessions = [];
        try { sessions = await readdir(wdir, { withFileTypes: true }); } catch { continue; }
        for (const s of sessions) {
            if (!s.isDirectory()) continue;
            const id = s.name;
            const sdir = join(wdir, id);
            let st;
            try { st = await stat(join(sdir, SESSION_FILE)); } catch { continue; }
            const bytes = await dirBytes(sdir);
            const recent = now - st.mtimeMs < RECENT_MS;

            // 磁盘目录名可能带 session- 前缀；注册表里的 id 也带。两种都比一次。
            const bare = id.replace(/^session-/, '');
            const isPinned = pinned.has(id) || pinned.has(bare) || pinned.has('session-' + bare);
            const isArchived = archived.has(id) || archived.has(bare) || archived.has('session-' + bare);
            const isActive = active.has(id) || active.has(bare) || active.has('session-' + bare);

            let lockedBy = null;
            if (isActive) lockedBy = 'active';
            else if (isPinned) lockedBy = 'pinned';
            else if (recent) lockedBy = 'recent';

            out.push({
                id,
                workspace: w.name,
                workspacePath: decodeWorkspace(w.name),
                title: titles.get(id) || titles.get(bare) || '',
                bytes,
                mtime: st.mtimeMs,
                archived: isArchived,
                lockedBy,
            });
        }
    }
    // 已归档的排前面（用户主动归档过 ⇒ 最可能想清），同组按大小倒序
    out.sort((a, b) => (Number(b.archived) - Number(a.archived)) || (b.bytes - a.bytes));
    const totalBytes = out.reduce((n, x) => n + x.bytes, 0);
    const deletableBytes = out.filter((x) => !x.lockedBy).reduce((n, x) => n + x.bytes, 0);
    return { sessions: out, totalBytes, deletableBytes };
}

/** 回收目录现状。 */
export async function trashInfo() {
    let stamps = [];
    try { stamps = await readdir(TRASH, { withFileTypes: true }); } catch { return { count: 0, bytes: 0 }; }
    let count = 0, bytes = 0;
    for (const d of stamps) {
        if (!d.isDirectory()) continue;
        const p = join(TRASH, d.name);
        let wsList = [];
        try { wsList = await readdir(p, { withFileTypes: true }); } catch { continue; }
        for (const w of wsList) {
            if (!w.isDirectory()) continue;
            let inner = [];
            try { inner = await readdir(join(p, w.name), { withFileTypes: true }); } catch { continue; }
            for (const s of inner) {
                if (!s.isDirectory()) continue;
                count++;
                bytes += await dirBytes(join(p, w.name, s.name));
            }
        }
    }
    return { count, bytes };
}

/**
 * 把指定会话移到回收目录。
 * ★ 后端再次校验三条保护 —— 前端禁选只是提示。
 */
export async function moveToTrash(ids, guards = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pinned = guards.pinned ?? new Set();
    const active = guards.active ?? new Set();
    const moved = [];
    const failed = [];

    for (const it of ids) {
        const id = String(it?.id ?? '');
        const workspace = String(it?.workspace ?? '');
        // 防路径穿越
        if (!id || !workspace || /[\\/]|\.\./.test(id) || /[\\/]|\.\./.test(workspace)) {
            failed.push({ id, error: '非法名字' });
            continue;
        }
        const bare = id.replace(/^session-/, '');
        const inSet = (s) => s.has(id) || s.has(bare) || s.has('session-' + bare);
        if (inSet(active)) { failed.push({ id, error: '正在运行，拒绝删除' }); continue; }
        if (inSet(pinned)) { failed.push({ id, error: '置顶会话，拒绝删除' }); continue; }

        const src = join(SESSIONS, workspace, id);
        try {
            const st = await stat(src);
            if (Date.now() - st.mtimeMs < RECENT_MS) { failed.push({ id, error: '最近仍活跃，拒绝删除' }); continue; }
            const dstDir = join(TRASH, stamp, workspace);
            await mkdir(dstDir, { recursive: true });
            await rename(src, join(dstDir, id));
            moved.push(id);
        } catch (e) {
            failed.push({ id, error: (e && e.message) || String(e) });
        }
    }
    // ★ 文件移走了，还要把这个会话从 DSH 的 workspace 注册表里摘掉 ——
    //   否则侧边栏列表照样显示它，再点还会报「找不到」（实测就是这个症状）。
    let unregistered = null;
    if (moved.length) unregistered = await unregisterSessions(moved);
    return { moved, failed, stamp, unregistered };
}

/**
 * 从 DSH 的 workspace 注册表里摘掉这些会话 id。
 *
 * ★ 为什么必须做（2026-10-14 实测）：已删会话仍留在 workspaces[].sessionIds 里（6 个里 5 个还在），
 *   而侧边栏列表读的就是这份状态 ⇒ 不摘掉的话「删了文件列表照样显示、再点还报找不到」。
 *
 * ★ 关于官方 archiveSession：归档是【用户的主动状态】（想留着只是不想看），所以【不用它代替删除】。
 *   但 2026-10-14 起 client 侧会在【文件删除成功之后】顺手调一次归档 —— 唯一目的是让 host 侧状态
 *   立即更新（否则侧边栏要重启才干净，用户实测："怎么还在啊"）；紧接着本函数会把该 id 从
 *   archivedSessionIds 里也摘掉 ⇒ 不留下"伪归档"。
 *   顺序讲究：先删文件、成功后才归档 —— 删除失败时不归档，会话仍留在列表里，语义更直白。
 *
 * ★ 安全措施（针对「DSH 也会写这个文件」）：
 *   ① 写前【重读】磁盘最新内容，不拿旧副本覆盖
 *   ② 只改那三个数组，其余字段原样带回
 *   ③ 先备份 .bak-session-tidy-<时间戳>
 *   ④ 原子写：先写临时文件再 rename（避免写一半被读到）
 *   ⑤ 整段 try/catch —— 这步失败【不影响删除本身】（文件已经移走了）
 *
 * ★ 生效时机：DSH 内存里那份状态不会因此改变 ⇒ 【重启 DSH 后】列表才干净。
 */
export async function unregisterSessions(ids) {
    if (!ids || !ids.length) return { ok: false, reason: 'empty' };
    const set = new Set(ids.map(String));
    try {
        const before = await readFile(WORKSPACE_JSON, 'utf8');
        const j = JSON.parse(before);
        let removed = 0;

        for (const w of Object.values(j?.tables?.workspaces ?? {})) {
            if (!Array.isArray(w?.sessionIds)) continue;
            const next = w.sessionIds.filter((x) => !set.has(String(x)));
            removed += w.sessionIds.length - next.length;
            w.sessionIds = next;
        }
        for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
            const arr = j?.global?.[key];
            if (!Array.isArray(arr)) continue;
            const next = arr.filter((x) => !set.has(String(x)));
            removed += arr.length - next.length;
            j.global[key] = next;
        }
        if (!removed) return { ok: true, removed: 0 };

        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await writeFile(WORKSPACE_JSON + '.bak-session-tidy-' + stamp, before, 'utf8').catch(() => { /* 备份失败不阻断 */ });
        const tmp = WORKSPACE_JSON + '.tmp-' + Date.now();
        await writeFile(tmp, JSON.stringify(j, null, 2), 'utf8');
        await rename(tmp, WORKSPACE_JSON);
        console.log('[session-tidy] 已从 workspace 注册表摘除 ' + removed + ' 处引用（重启 DSH 后列表生效）');
        return { ok: true, removed: removed };
    } catch (e) {
        console.log('[session-tidy] 摘除注册表失败（不影响已删除的文件）: ' + ((e && e.message) || e));
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

/** 彻底清空回收目录。 */
export async function emptyTrash() {
    const info = await trashInfo();
    await rm(TRASH, { recursive: true, force: true });
    return info;
}

export function apply(ctx) {
    console.log('[session-tidy] apply() 开始');

    const guard = (req, res) => {
        if (isLoopback(req)) return true;
        sendJson(res, 403, { error: 'forbidden', message: '仅允许本机访问' });
        return false;
    };

    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/session-tidy/list',
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            if (req.method !== 'GET') { sendJson(res, 405, { error: 'method' }); return; }
            try {
                const reg = await readRegistry();
                const active = activeSessionIds(ctx);
                const scan = await scanSessions({ ...reg, active });
                const trash = await trashInfo();
                sendJson(res, 200, {
                    ok: true,
                    ...scan,
                    trash,
                    recentMs: RECENT_MS,
                    counts: { pinned: reg.pinned.size, archived: reg.archived.size, active: active.size },
                });
            } catch (e) {
                sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) });
            }
        },
    }), 'session-tidy: list');

    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/session-tidy/delete',
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            if (req.method !== 'POST') { sendJson(res, 405, { error: 'method' }); return; }
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const ids = Array.isArray(body.ids) ? body.ids : [];
                if (!ids.length) { sendJson(res, 400, { ok: false, error: '没有选中任何会话' }); return; }
                if (ids.length > 500) { sendJson(res, 400, { ok: false, error: '一次最多 500 个' }); return; }
                const reg = await readRegistry();
                const active = activeSessionIds(ctx);
                const r = await moveToTrash(ids, { pinned: reg.pinned, active });
                console.log('[session-tidy] 移入回收目录 ' + r.moved.length + ' 个，拒绝/失败 ' + r.failed.length);
                sendJson(res, 200, { ok: true, ...r });
            } catch (e) {
                sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) });
            }
        },
    }), 'session-tidy: delete');

    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/session-tidy/empty-trash',
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            if (req.method !== 'POST') { sendJson(res, 405, { error: 'method' }); return; }
            try {
                const info = await emptyTrash();
                console.log('[session-tidy] 清空回收目录 ' + info.count + ' 个 / ' + info.bytes + ' B');
                sendJson(res, 200, { ok: true, ...info });
            } catch (e) {
                sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) });
            }
        },
    }), 'session-tidy: empty-trash');

    // ★ 会话行菜单用：只给 sessionId（菜单插槽的 props 里没有 workspace），host 自己定位。
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/session-tidy/delete-one',
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            if (req.method !== 'POST') { sendJson(res, 405, { error: 'method' }); return; }
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const id = String(body.id || '');
                if (!id) { sendJson(res, 400, { ok: false, error: '缺少 id' }); return; }
                const reg = await readRegistry();
                const active = activeSessionIds(ctx);
                const scan = await scanSessions({ ...reg, active });
                const hit = scan.sessions.find((s) => s.id === id);
                if (!hit) {
                    // 文件已不在 ⇒ 多半是【已经删过一次】（用户又点了一下，属正常操作）。
                    // 不再报 404「找不到该会话」—— 那会让人以为出错了。
                    sendJson(res, 200, { ok: true, already: true, id: id, moved: [], failed: [] });
                    return;
                }
                const r = await moveToTrash([{ id: hit.id, workspace: hit.workspace }], { pinned: reg.pinned, active });
                if (!r.moved.length) {
                    sendJson(res, 200, { ok: false, error: (r.failed[0] && r.failed[0].error) || '未移动', ...r });
                    return;
                }
                console.log('[session-tidy] 菜单删除: ' + id + ' (' + hit.bytes + ' B)');
                sendJson(res, 200, { ok: true, id, bytes: hit.bytes, ...r });
            } catch (e) {
                sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) });
            }
        },
    }), 'session-tidy: delete-one');

    console.log('[session-tidy] ✅ 四条路由已注册');
}
