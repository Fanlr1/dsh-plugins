// dsh-plugin-github-tools -- host 侧
//
// 两个只读工具，把「扒一个 GitHub 仓库」的标准动作固化下来：
//   · github_repo  —— 元信息（stars/license/pushed_at/description）+ 文件树（含每个文件大小）+ 单文件内容
//   · github_probe —— 一次报告哪条路活着（api / raw），附耗时与推荐
//
// 为什么自己写而不是装 dsh-github-router（那是个 289KB / 5 工具 / 5 路回退的同类）：
//   ★ 它的复杂度是为「任意恶劣环境」付的（无 gh、无 git、直连 TLS 被 reset、无代理、要走镜像）——
//     而本机实测：api.github.com 与 raw.githubusercontent.com 经 S302 反代【都是 200】。
//     ⇒ 五条路我们只有一条是活的，照搬就是为一个不存在的多样性付代价。
//   抄的是它的【架构】：失败返回矩阵（不是笼统错误）+ 处处限幅（byte/list caps + 截断说明 + ratelimit）。
//
// 零依赖：用 Node 内置 fetch（需要 Node >= 18，本机 24）+ AbortSignal.timeout。
//
// 工具注册要点（照 hub-finder 的成熟写法）：
//   · inject: ['tools']；ctx.tools.register(def) 返回 dispose
//   · ★ 裸 register 不做参数校验 ⇒ 自己校验
//   · 返回 { text, content:[{type:'text',text}] }；output.render 给展示层

import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';

// ★ 为什么不用 fetch/undici：**S302 的根证书它不认**。
//   本机实测（2026-10-16）：
//     fetch(url)                     → fetch failed（undici 用自带 CA 池）
//     https.get(url) 不带 ca          → unable to verify the first certificate
//     https.get(url, { ca: mitm.pem }) → ✅ 200
//   ⇒ 用 node:https 并显式给 ca。CA 路径可被 DSH_GITHUB_TOOLS_CA 覆盖。
const CA_PATH = process.env.DSH_GITHUB_TOOLS_CA
  || [process.env.NODE_EXTRA_CA_CERTS, os.homedir() + '\\llm\\mitm-root.pem'].find((p) => p && fs.existsSync(p))
  || null;
let CA = null;
try { if (CA_PATH) CA = fs.readFileSync(CA_PATH); } catch { CA = null; }

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

export const name = 'github-tools';
export const inject = ['tools'];

// ── 限幅（上下文效率；默认值都往小里给，需要时显式放大） ──────────────────────
const DEFAULT_TREE_LIMIT = 60;
const DEFAULT_FILE_BYTES = 120 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const UA = 'dsh-plugin-github-tools';

const txt = (t, extra) => {
  const out = { text: String(t), content: [{ type: 'text', text: String(t) }] };
  if (extra) for (const k of Object.keys(extra)) if (extra[k] !== undefined) out[k] = extra[k];
  return out;
};

const nf = (n) => {
  if (n === null || n === undefined) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
};

function parseRepo(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '');
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(t);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** 一次 GET（node:https + ca），返回 { status, headers, body(截断后), bytes, truncated, ms, error } —— 失败不抛。 */
function get(url, { maxBytes = 512 * 1024, accept = 'application/vnd.github+json', redirects = 3 } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const done = (r) => resolve({ ms: Date.now() - t0, ...r });
    const attempt = (target, left) => {
      let u;
      try { u = new URL(target); } catch (e) { return done({ status: 0, headers: null, body: '', bytes: 0, truncated: false, error: 'bad url' }); }
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'user-agent': UA, accept, 'x-github-api-version': '2022-11-28', 'accept-encoding': 'identity' },
        ...(CA ? { ca: CA } : {}),
      }, (res) => {
        const loc = res.headers.location;
        if (loc && res.statusCode >= 300 && res.statusCode < 400 && left > 0) {
          res.resume();
          return attempt(new URL(loc, target).toString(), left - 1);
        }
        const chunks = [];
        let n = 0;
        let kept = 0;
        res.on('data', (c) => {
          n += c.length;
          if (kept < maxBytes) {                       // ★ 收【部分】而不是整块丢弃
            const room = maxBytes - kept;
            chunks.push(room >= c.length ? c : c.subarray(0, room));
            kept += Math.min(room, c.length);
          }
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          done({
            status: res.statusCode || 0,
            headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
            body: buf.toString('utf8'),
            bytes: n,
            truncated: n > maxBytes,
          });
        });
      });
      req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => done({ status: 0, headers: null, body: '', bytes: 0, truncated: false, error: String((e && e.message) || e) }));
      req.end();
    };
    attempt(url, redirects);
  });
}

const rateOf = (h) => (h && h.get ? { remaining: h.get('x-ratelimit-remaining'), limit: h.get('x-ratelimit-limit') } : null);

// ── 工具一：github_repo ────────────────────────────────────────────────────

async function runRepo(args) {
  const target = parseRepo(args.repo);
  if (!target) return txt('看不懂 repo 参数：' + String(args.repo) + '\n给 owner/repo 或 GitHub 链接都行。');
  const { owner, repo } = target;
  const ref = typeof args.ref === 'string' && args.ref.length > 0 ? args.ref : null;
  const wantFile = typeof args.file === 'string' && args.file.length > 0 ? args.file : null;
  // theme 名可能是分支名，别硬编码 main；先取默认分支
  const meta = await get(API + '/repos/' + owner + '/' + repo);
  if (meta.status === 404) return txt('仓库不存在或不可见：' + owner + '/' + repo + '（api 返回 404）');
  if (meta.status !== 200) {
    return txt('取元信息失败：status=' + meta.status + (meta.error ? (' · ' + meta.error) : '') + '\n先跑 github_probe 看哪条路活着。');
  }
  let j;
  try { j = JSON.parse(meta.body); } catch { return txt('元信息不是合法 JSON（可能被劫持/登录页）：\n' + meta.body.slice(0, 300)); }
  const branch = ref || j.default_branch || 'main';
  const rl = rateOf(meta.headers);
  const head = [
    '仓库  ' + owner + '/' + repo,
    '描述  ' + (j.description || '(无)'),
    '语言  ' + (j.language || '?') + ' · stars ' + (j.stargazers_count ?? '?') + ' · forks ' + (j.forks_count ?? '?'),
    '许可  ' + ((j.license && j.license.spdx_id) || '⚠️ 无 license 字段 ⇒ 不是开源，只是源码可见'),
    '时间  建 ' + String(j.created_at || '').slice(0, 10) + ' · 最后推送 ' + String(j.pushed_at || '').slice(0, 10),
    '默认分支 ' + branch + (j.archived ? ' · ⚠️ 已归档' : ''),
    'API  ' + meta.status + ' · ' + meta.ms + 'ms' + (rl && rl.remaining ? (' · 限流剩 ' + rl.remaining + '/' + rl.limit) : ''),
  ].join('\n');

  // 只要一个文件
  if (wantFile) {
    const limit = Math.min(Number(args.maxBytes) || DEFAULT_FILE_BYTES, MAX_FILE_BYTES);
    const url = RAW + '/' + owner + '/' + repo + '/' + branch + '/' + wantFile.split('/').map(encodeURIComponent).join('/');
    const f = await get(url, { maxBytes: limit, accept: '*/*' });
    if (f.status !== 200) return txt(head + '\n\n文件 ' + wantFile + ' 取不到：status=' + f.status + (f.error ? (' · ' + f.error) : ''));
    return txt(head + '\n\n文件 ' + wantFile + ' @ ' + branch + '  ' + nf(f.bytes) + (f.truncated ? ('（已截断到 ' + nf(limit) + '）') : '') + '\n' + '-'.repeat(60) + '\n' + f.body, { bytes: f.bytes, truncated: f.truncated });
  }

  // 文件树
  const t = await get(API + '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1');
  if (t.status !== 200) return txt(head + '\n\n取文件树失败：status=' + t.status + (t.error ? (' · ' + t.error) : ''));
  let tj;
  try { tj = JSON.parse(t.body); } catch { return txt(head + '\n\n文件树不是合法 JSON'); }
  const files = (tj.tree || []).filter((x) => x.type === 'blob');
  const total = files.reduce((a, x) => a + (x.size || 0), 0);
  const big = files.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 8);
  const limit = Math.min(Number(args.limit) || DEFAULT_TREE_LIMIT, 400);
  const shown = files.slice(0, limit);
  const lines = [
    '',
    '体量  ' + files.length + ' 文件 · ' + nf(total) + (tj.truncated ? '（⚠️ 树被上游截断）' : ''),
    '',
    '最大的文件（前 8）:',
    ...big.map((x) => '  ' + nf(x.size) + '\t' + x.path),
    '',
    '文件列表（' + shown.length + '/' + files.length + '）:',
    ...shown.map((x) => '  ' + nf(x.size) + '\t' + x.path),
  ];
  if (files.length > limit) lines.push('  … 另有 ' + (files.length - limit) + ' 个未列出（用 limit 放大）');
  return txt(head + '\n' + lines.join('\n'), { fileCount: files.length, totalBytes: total, truncated: files.length > limit });
}

// ── 工具二：github_probe ──────────────────────────────────────────────────

async function runProbe() {
  const rows = [];
  const t1 = await get(API + '/rate_limit');
  rows.push(['api.github.com', t1, t1.status === 200 ? '✓ 直连可用' : ('✗ ' + (t1.error || ('HTTP ' + t1.status)))]);
  const t2 = await get(RAW + '/torvalds/linux/master/README', { maxBytes: 2048, accept: '*/*' });
  rows.push(['raw.githubusercontent.com', t2, t2.status === 200 ? '✓ 直连可用' : ('✗ ' + (t2.error || ('HTTP ' + t2.status)))]);
  const t3 = await get('https://github.com', { maxBytes: 2048, accept: 'text/html' });
  rows.push(['github.com（页面）', t3, t3.status === 200 ? '✓ 可用' : ('✗ ' + (t3.error || ('HTTP ' + t3.status)))]);
  const lines = ['GitHub 路由探针（本机实测，各条独立计时）', ''];
  let best = null;
  for (const [name, r, verdict] of rows) {
    lines.push('  ' + name.padEnd(28) + String(r.ms + 'ms').padStart(7) + '  ' + verdict);
    if (r.status === 200 && (best === null || r.ms < best.ms)) best = { name, ms: r.ms };
  }
  lines.push('');
  const apiOk = rows[0][1].status === 200;
  const rawOk = rows[1][1].status === 200;
  if (apiOk && rawOk) {
    lines.push('两条主路都通（api ' + rows[0][1].ms + 'ms · raw ' + rows[1][1].ms + 'ms）—— 分工不同，不是二选一：');
    lines.push('  · 元信息 / 文件树 / 目录列表 ⇒ 只能走 api.github.com');
    lines.push('  · 单个文件内容           ⇒ 走 raw（更快、不吃 api 限流）');
    lines.push('⇒ 直接用 github_repo({ repo: "owner/name" }) 即可，它内部会各走各的。');
  } else if (apiOk) {
    lines.push('⚠️ api 通但 raw 不通 ⇒ 元信息与文件树可用，单文件内容会失败（github_repo 会报 status）。');
  } else if (rawOk) {
    lines.push('⚠️ raw 通但 api 不通 ⇒ 只能按「已知 owner/name/分支/路径」取单文件，列不出文件树。');
  } else {
    lines.push('⚠️ 三条都不通 —— 先确认 S302 在跑（127.0.0.1:443 有监听）与 CA 路径（DSH_GITHUB_TOOLS_CA）。');
  }
  const rl = rateOf(t1.headers);
  if (rl && rl.remaining) lines.push('api 限流剩 ' + rl.remaining + '/' + rl.limit);
  return txt(lines.join('\n'), { routes: rows.map(([n, r]) => ({ name: n, status: r.status, ms: r.ms })) });
}

// ── 参数校验（裸 register 不做校验，必须自己来） ─────────────────────────────

function bad(msg) { return txt('参数不合法：' + msg); }

const repoDef = {
  name: 'github_repo',
  description: [
    '只读读取一个 GitHub 仓库：给 repo（owner/name 或链接）返回元信息（stars/许可/最后推送/描述）',
    '与文件树（含每个文件大小、最大的几个文件）；给 file 再返回该文件内容（raw）。',
    '★ 用途：扒一个插件/项目的源码，先看体量与主体文件，再读关键文件 —— 一次调用替代「元信息+树+文件」三条 curl。',
    '★ 判断开源：license 字段为 null 且没有 LICENSE 文件 ⇒ 只是源码可见，不是开源。',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name，或 https://github.com/owner/name 链接。' },
      ref: { type: 'string', description: '分支 / 标签 / commit（默认取仓库默认分支）。' },
      file: { type: 'string', description: '要读的单个文件路径（走 raw）。给了它就不再列文件树。' },
      limit: { type: 'number', description: '文件树列出条数（默认 60，上限 400）。' },
      maxBytes: { type: 'number', description: '单文件字节上限（默认 122880，上限 2MB，超出截断）。' },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  isConcurrencySafe: () => true,
  execute: async (args) => {
    const a = args || {};
    if (typeof a.repo !== 'string' || a.repo.length === 0) return bad('repo 必填且是字符串。');
    if (a.ref !== undefined && typeof a.ref !== 'string') return bad('ref 必须是字符串。');
    if (a.file !== undefined && typeof a.file !== 'string') return bad('file 必须是字符串。');
    if (a.limit !== undefined && (typeof a.limit !== 'number' || a.limit <= 0)) return bad('limit 必须是正数。');
    if (a.maxBytes !== undefined && (typeof a.maxBytes !== 'number' || a.maxBytes <= 0)) return bad('maxBytes 必须是正数。');
    return runRepo(a);
  },
  output: {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_a, v) => [{ type: 'text', text: String((v && v.text) || '') }],
  },
};

const probeDef = {
  name: 'github_probe',
  description: [
    '一次探测本机到 GitHub 的各条读写路径是否可用（api / raw / 页面），附各自耗时与推荐。',
    '★ 用途：任何 GitHub 请求失败或变慢时，先跑它一次 —— 比反复试 curl 省事。',
  ].join(' '),
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  isConcurrencySafe: () => true,
  execute: async () => runProbe(),
  output: {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_a, v) => [{ type: 'text', text: String((v && v.text) || '') }],
  },
};

export function apply(ctx) {
  const log = (m) => { try { ctx.logger?.info?.('[github-tools] ' + m); } catch { /* ignore */ } };
  const disposes = [];
  try { disposes.push(ctx.tools.register(repoDef)); } catch (e) { log('注册 github_repo 失败：' + (e && e.message)); }
  try { disposes.push(ctx.tools.register(probeDef)); } catch (e) { log('注册 github_probe 失败：' + (e && e.message)); }
  ctx.effect(() => () => { for (const d of disposes) { try { d?.(); } catch { /* ignore */ } } });
  log('已注册 github_repo / github_probe');
}

export const _internals = { parseRepo, runRepo, runProbe, get };
