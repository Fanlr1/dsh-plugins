// dsh-plugin-gh-tools -- host 侧（GitHub 仓库管理：PR / Issue / CI / 评论 / 合并）
//
// 为什么不装 gh CLI：本机没有 gh；本插件直接用 GitHub REST API（node:https + S302 根证书）。
// 凭据：ctx.credentials.resolve('GITHUB_TOKEN')（DSH credential seam）→ 兜底 process.env.GITHUB_TOKEN。
// ★ 网络注意：fetch/undici 不认 S302 根证书 → 统一用 node:https 并显式给 ca（与 github-tools 同法）。

import https from 'node:https';
import fs from 'node:fs';

export const name = 'gh-tools';
export const inject = ['tools', 'credentials'];

const API = 'https://api.github.com';
const UA = 'dsh-plugin-gh-tools';
const TIMEOUT_MS = 25000;

const CA_PATH = process.env.DSH_GH_TOOLS_CA
  || process.env.NODE_EXTRA_CA_CERTS
  || null;
let CA = null;
try { if (CA_PATH) CA = fs.readFileSync(CA_PATH); } catch { CA = null; }

function request(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(API + path);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: 'token ' + token,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      ...(CA ? { ca: CA } : {}),
      timeout: TIMEOUT_MS,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + TIMEOUT_MS + 'ms')));
    req.on('error', (e) => resolve({ status: 0, json: null, text: String(e && e.message), headers: {} }));
    if (data) req.write(data);
    req.end();
  });
}

async function resolveToken(ctx) {
  try {
    const hit = await ctx.credentials.resolve('GITHUB_TOKEN');
    if (hit && typeof hit.value === 'string' && hit.value) return hit.value;
  } catch { /* fallthrough */ }
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return env || null;
}

const txt = (t, extra) => {
  const out = { text: String(t), content: [{ type: 'text', text: String(t) }] };
  if (extra) for (const k of Object.keys(extra)) if (extra[k] !== undefined) out[k] = extra[k];
  return out;
};

const bad = (m) => txt('参数不合法：' + m);
const ago = (s) => {
  if (!s) return '?';
  const d = new Date(s);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return mins + 'm';
  if (mins < 1440) return Math.round(mins / 60) + 'h';
  return Math.round(mins / 1440) + 'd';
};

function repoArgs(a) {
  if (typeof a.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(a.repo)) return { err: 'repo 必填，格式 owner/name' };
  if (a.limit !== undefined && (typeof a.limit !== 'number' || a.limit <= 0 || a.limit > 100)) return { err: 'limit 必须是 1~100 的数字' };
  return { repo: a.repo, limit: a.limit || 10 };
}

async function api(ctx, method, path, body) {
  const token = await resolveToken(ctx);
  if (!token) return { err: '没有 GITHUB_TOKEN（凭据 seam 与环境都没有）' };
  const r = await request(method, path, body, token);
  if (r.status === 0) return { err: '网络失败：' + r.text };
  if (r.status >= 400) return { err: 'HTTP ' + r.status + '：' + (r.text || '').slice(0, 300) };
  return r;
}

// ── 工具定义 ────────────────────────────────────────────────

function mkListTool(ctx, name, desc, kind) {
  return {
    name,
    description: desc,
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name' },
        state: { type: 'string', description: 'open / closed / all（默认 open）' },
        limit: { type: 'number', description: '条数，默认 10，上限 100' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = repoArgs(args || {});
      if (a.err) return bad(a.err);
      const st = (args.state || 'open').toLowerCase();
      if (!['open', 'closed', 'all'].includes(st)) return bad('state 只能是 open / closed / all');
      let path;
      if (kind === 'pr') path = '/repos/' + a.repo + '/pulls?state=' + st + '&per_page=' + a.limit;
      else if (kind === 'issue') path = '/repos/' + a.repo + '/issues?state=' + st + '&per_page=' + a.limit;
      else path = '/repos/' + a.repo + '/actions/runs?per_page=' + a.limit;
      const r = await api(ctx, 'GET', path);
      if (r.err) return txt(r.err);
      if (kind === 'run') {
        const runs = (r.json && r.json.workflow_runs) || [];
        const lines = ['CI runs（' + a.repo + '，最近 ' + runs.length + ' 条）：'];
        for (const w of runs) lines.push('  ' + (w.conclusion || w.status || '?').padEnd(10) + ' ' + (w.name || '').slice(0, 28).padEnd(28) + ' #' + w.run_number + ' · ' + ago(w.created_at) + ' · ' + (w.head_branch || ''));
        return txt(lines.join('\n'));
      }
      const items = Array.isArray(r.json) ? r.json : [];
      const list = items.filter((x) => !(kind === 'issue' && x.pull_request));  // issues API 会把 PR 混进来
      const lines = [kind === 'pr' ? 'Pull requests' : 'Issues', '（' + a.repo + '，' + st + '，' + list.length + ' 条）：'];
      for (const x of list) lines.push('  #' + x.number + ' ' + (x.title || '').slice(0, 60) + ' · @' + (x.user && x.user.login) + ' · ' + ago(x.updated_at));
      return txt(lines.join('\n'));
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: String((v && v.text) || '') }],
    },
  };
}

export function apply(ctx) {
  const log = (m) => { try { ctx.logger?.info?.('[gh-tools] ' + m); } catch { } };
  const disposes = [];
  const defs = [
    {
      name: 'gh_pr_view',
      description: '查看一个 PR 的详情与改动文件列表（repo + number）；返回标题/状态/作者/分支/改动文件（最多 30 个）。',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name' },
          number: { type: 'number', description: 'PR 编号' },
        },
        required: ['repo', 'number'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const a = repoArgs(args || {});
        if (a.err) return bad(a.err);
        if (typeof args.number !== 'number' || args.number <= 0) return bad('number 必须是正数');
        const n = args.number;
        const [pr, files] = await Promise.all([
          api(ctx, 'GET', '/repos/' + a.repo + '/pulls/' + n),
          api(ctx, 'GET', '/repos/' + a.repo + '/pulls/' + n + '/files?per_page=50'),
        ]);
        if (pr.err) return txt(pr.err);
        if (files.err) return txt(files.err);
        const p = pr.json || {};
        const lines = ['PR #' + n + ' ' + (p.title || '')];
        lines.push('  状态: ' + (p.state || '?') + (p.draft ? '（draft）' : '') + ' · 作者 @' + (p.user && p.user.login) + ' · ' + (p.head && p.head.ref) + ' → ' + (p.base && p.base.ref));
        lines.push('  ' + (p.body || '').slice(0, 300));
        const fl = Array.isArray(files.json) ? files.json : [];
        lines.push('  改动文件（' + fl.length + '）:');
        for (const f of fl.slice(0, 30)) lines.push('    ' + f.status + '  ' + f.filename + '  (+' + f.additions + ' -' + f.deletions + ')');
        return txt(lines.join('\n'));
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_a, v) => [{ type: 'text', text: String((v && v.text) || '') }],
      },
    },
    {
      name: 'gh_comment',
      description: '给 GitHub Issue/PR 发评论（repo + number + body）。★ 公开动作：确认内容后再调。',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name' },
          number: { type: 'number', description: 'Issue/PR 编号' },
          body: { type: 'string', description: '评论内容（Markdown）' },
        },
        required: ['repo', 'number', 'body'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const a = repoArgs(args || {});
        if (a.err) return bad(a.err);
        if (typeof args.number !== 'number' || args.number <= 0) return bad('number 必须是正数');
        if (typeof args.body !== 'string' || !args.body.trim()) return bad('body 必填且非空');
        const r = await api(ctx, 'POST', '/repos/' + a.repo + '/issues/' + args.number + '/comments', { body: args.body });
        if (r.err) return txt(r.err);
        return txt('已评论：' + ((r.json && r.json.html_url) || ''));
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_a, v) => [{ type: 'text', text: String((v && v.text) || '') }],
      },
    },
    {
      name: 'gh_run_watch',
      description: '查 GitHub Actions 最新运行状态（repo，可选 workflow 名）；未完成时提示等待。',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name' },
          workflow: { type: 'string', description: '可选：workflow 名称片段（如 ci）' },
        },
        required: ['repo'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const a = repoArgs(args || {});
        if (a.err) return bad(a.err);
        const r = await api(ctx, 'GET', '/repos/' + a.repo + '/actions/runs?per_page=5');
        if (r.err) return txt(r.err);
        let runs = (r.json && r.json.workflow_runs) || [];
        if (args.workflow) {
          const wf = String(args.workflow).toLowerCase();
          runs = runs.filter((x) => String(x.name || '').toLowerCase().includes(wf));
        }
        if (!runs.length) return txt('没有匹配的 CI 运行');
        const lines = [];
        for (const w of runs.slice(0, 3)) {
          const status = w.status === 'completed' ? (w.conclusion || 'completed') : '⏳' + (w.status || '');
          lines.push('#' + w.run_number + ' ' + status + ' · ' + (w.name || '') + ' · ' + ago(w.created_at) + ' · ' + (w.head_branch || ''));
          if (w.status !== 'completed') lines.push('  ⚠️ 未完成（稍后再查）');
        }
        return txt(lines.join('\n'));
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_a, v) => [{ type: 'text', text: String((v && v.text) || '') }],
      },
    },
    mkListTool(ctx, 'gh_pr_list', '列 GitHub 仓库的 Pull Request（repo/state/limit）；返回编号/标题/作者/更新时间。', 'pr'),
    mkListTool(ctx, 'gh_issue_list', '列 GitHub 仓库的 Issue（repo/state/limit，自动过滤 PR）；返回编号/标题/作者/更新时间。', 'issue'),
    mkListTool(ctx, 'gh_run_list', '列 GitHub Actions CI 运行（repo/limit）；返回结论/工作流/编号/时间/分支。', 'run'),
  ];
  for (const d of defs) { try { disposes.push(ctx.tools.register(d)); } catch (e) { log('注册 ' + d.name + ' 失败：' + (e && e.message)); } }
  ctx.effect(() => () => { for (const d of disposes) { try { d?.(); } catch { } } });
  log('已注册 gh_pr_list / gh_issue_list / gh_run_list / gh_pr_view / gh_comment / gh_run_watch');
}