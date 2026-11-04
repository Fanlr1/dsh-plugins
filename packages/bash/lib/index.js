// dsh-plugin-bash -- host 侧
//
// ★ 为什么需要它（2026-10-14 调研结论，依据都可核）：
//   DSH 官方【有】bash 工具（@deepseek-ai/dsh-tool-bash，本机 app.asar 里已装），
//   但在 Windows 上被【设计性禁用】：
//       packages/bundle/base/cordis.patch.yml:276
//       - id: tool-bash
//         disabled: !!js process.platform === 'win32'
//   执行器侧同理（bash-sandbox 也在 win32 禁用），而 bash-local 是直接 "bash -c"
//   ⇒ 要求 bash 在 PATH 上，本机的 Git bash 并不在 PATH。
//   ⇒ 结果：Windows 上只剩 pwsh，而我们的真实痛点正是"文本处理被 PowerShell 的
//      转义/解析坑反复咬"（见 ~/.dsh/AGENTS.md「PowerShell 坑」三条根规律）。
//
// 本插件三件事：
//   A. 注册 bash 工具（走本机 Git for Windows）
//   B. 对【子 agent】隐藏 pwsh —— 子 agent 的活多是文本/批量/摘要，几乎不用 Windows 原生；
//      主 agent 保留全能力（注册表/服务/证书/防火墙这些只有主 agent 干）
//   C. 路由写进工具 description：文本/行处理优先 bash；Windows 原生与 .cmd 链用 pwsh
//
// ★ 第一版的设计取舍（都记在这，免得下一个人重推）：
//   · 不做 run_in_background —— 需要接 jobs 服务；要后台时继续用 pwsh 的 run_in_background
//   · 不注入 systemPrompt 段落 —— 路由放 description，零 API 风险
//   · 不用 DSH 的 subprocess 服务 —— 裸 node:child_process + taskkill（Windows 进程树）
//   · ★ 参数必须【自校验】：官方原话 —— 走裸 ctx.tools.register() 注册的工具
//     "is not argument-checked"，拼错的键会静默丢失，必须自己严格拒绝
//
// ★ 关于沙箱：本工具 spawn 的子进程与 DSH 原生工具处在同一进程/文件系统策略下
//   （实测：workspace-write 下写工作区外会被拒）⇒ 不开后门。
//   差异：官方 pwsh 工具带 sandbox_permissions 提权申请路径，本工具没有 —— 遇到
//   沙箱拒绝只能报错，不能升级。这是【功能差异】，不是安全差异。

import { spawn } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import os from 'node:os';

export const name = 'bash-tool';
export const inject = ['tools'];

// 默认写 ~/.dsh/logs，可用环境变量覆盖（开源版去本机路径化）
const LOG = process.env.DSH_BASH_LOG || joinPath(os.homedir(), '.dsh', 'logs', 'bash-tool.log');
const BASH_CANDIDATES = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];
const MAX_TIMEOUT = 600000;
const DEFAULT_TIMEOUT = 120000;
const MAX_OUTPUT = 64000;          // 显示上限：超了就截断（保留尾部，与官方 pwsh 工具一致）
// ★ E（2026-10-14 用户要求）：截断【不能把内容丢掉】—— 学官方 pwsh 的 spill：
//   超限时把完整输出落盘，并在截断提示里给出路径（官方 render.ts: "[output truncated; full output: <path>]"）。
const SPILL_DIR = process.env.DSH_BASH_SPILL || joinPath(os.homedir(), '.dsh', 'logs', 'bash-spill');
const SPILL_CAP = 2 * 1024 * 1024; // 内存里最多留 2MB（再多就真丢，并注明）

/** 把完整输出落盘，返回路径（失败返回 null，绝不因 spill 失败影响命令结果）。 */
export function spill(text, tag) {
    try {
        mkdirSync(SPILL_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const p = SPILL_DIR + '\\' + stamp + '-' + (tag || 'out') + '.log';
        writeFileSync(p, text, 'utf8');
        return p;
    } catch (e) { return null; }
}

function fileLog(msg) {
    try { appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) { /* 静默 */ }
}
function logger(ctx) { return (ctx && ctx.logger) ? ctx.logger : console; }
function say(ctx, msg, level) {
    try { logger(ctx)[level || 'info']?.('[bash-tool] ' + msg); } catch (e) { /* 静默 */ }
    fileLog(msg);
}

/** 找 bash：按候选路径探测，返回第一个存在的。 */
export function resolveBash(candidates) {
    const list = candidates || BASH_CANDIDATES;
    for (const p of list) { try { if (existsSync(p)) return p; } catch (e) { /* 忽略 */ } }
    return null;
}

/**
 * 参数严格校验（裸 register 不校验 ⇒ 这里必须自己来）。
 * 未知键直接拒绝 —— 静默丢弃会让调用方以为生效了。
 */
export function validateArgs(args) {
    if (!args || typeof args !== 'object') throw new Error('invalid args: expected an object');
    const known = ['command', 'description', 'workdir', 'timeoutMs', 'run_in_background'];
    for (const k of Object.keys(args)) {
        if (known.indexOf(k) < 0) throw new Error('invalid arg "' + k + '": known args are ' + known.join(', '));
    }
    const command = args.command;
    if (typeof command !== 'string' || command.trim() === '') {
        throw new Error('invalid command: expected a non-empty string');
    }
    if (args.description !== undefined && typeof args.description !== 'string') {
        throw new Error('invalid description: expected a string');
    }
    if (args.workdir !== undefined && (typeof args.workdir !== 'string' || args.workdir.trim() === '')) {
        throw new Error('invalid workdir: expected a non-empty string');
    }
    let timeoutMs = DEFAULT_TIMEOUT;
    if (args.timeoutMs !== undefined) {
        if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
            throw new Error('invalid timeoutMs: expected a positive number');
        }
        timeoutMs = Math.min(args.timeoutMs, MAX_TIMEOUT);
    }
    if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') {
        throw new Error('invalid run_in_background: expected a boolean');
    }
    return { command: command, workdir: args.workdir, timeoutMs: timeoutMs, runInBackground: args.run_in_background === true };
}

/** 截断：保留尾部（错误信息通常在尾巴上），并说明省略了多少。 */
export function truncate(text, limit) {
    const max = limit || MAX_OUTPUT;
    if (typeof text !== 'string' || text.length <= max) return { text: text || '', truncated: false, omitted: 0 };
    const omitted = text.length - max;
    return { text: text.slice(omitted), truncated: true, omitted: omitted };
}

/**
 * 跑一条命令。返回 { code, signal, stdout, stderr, timedOut }。
 * Windows 上杀进程树要 taskkill /T（子进程会活下来）。
 */
export function runCommand(bashPath, command, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(bashPath, ['-c', command], {
                cwd: o.workdir || undefined,
                env: process.env,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (e) {
            resolve({ code: null, signal: null, stdout: '', stderr: String((e && e.message) || e), timedOut: false, spawnError: true });
            return;
        }
        try { o.onChild?.(child); } catch (e) { /* 忽略 */ }
        if (o.signal) {
            try { o.signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ } }, { once: true }); } catch (e) { /* 忽略 */ }
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const cap = (s, chunk) => (s.length < SPILL_CAP ? s + chunk : s);
        const emit = (chan, text) => { try { o.onChunk?.(chan, text); } catch (e) { /* 忽略 */ } };
        child.stdout?.on('data', (c) => { const t = String(c); stdout = cap(stdout, t); emit('stdout', t); });
        child.stderr?.on('data', (c) => { const t = String(c); stderr = cap(stderr, t); emit('stderr', t); });
        // ★ timeoutMs <= 0 = 【不自己超时】。job 路径必须这样：
        //   超时判断交给 registry.wait；若这里也设一个同样的超时，runCommand 会抢先把进程杀掉，
        //   "前台超时 ⇒ 转后台"就永远不可能发生（2026-10-15 实测就是这么坏的）。
        const timer = (o.timeoutMs && o.timeoutMs > 0) ? setTimeout(() => {
            timedOut = true;
            try {
                // ★ Windows：必须杀进程树，否则 bash 的子进程会活下来
                if (process.platform === 'win32' && child.pid) {
                    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                } else {
                    child.kill('SIGKILL');
                }
            } catch (e) { /* 忽略 */ }
            // ★ 不等 close 事件：taskkill 之后 close 可能还要几秒（实测 800ms 超时 → 5s 才 close）
            //   ⇒ 超时就立刻把已经抓到的输出交出去；随后的 close 会被 settled 拦住。
            done(null, null);
        }, o.timeoutMs) : null;
        const done = (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code, signal: signal, stdout: stdout, stderr: stderr, timedOut: timedOut });
        };
        child.on('error', (e) => { stderr = stderr + '\n' + String((e && e.message) || e); done(null, null); });
        child.on('close', (code, signal) => done(code, signal));
    });
}

/**
 * ★ F（2026-10-14）：把 bash 子进程接进 DSH 的 jobs 注册表 ——
 *   这样现成的 job_output / job_kill 工具就能收割它，用户不必记两套用法。
 *
 * 契约来自官方 @deepseek-ai/dsh-tool-pwsh（同目录 src/background.ts 与 src/index.ts）：
 *   registry.start({ kind, label, owner?, output, run }) -> id
 *     output: [{ channel: 'stdout'|'stderr', read(fromByte) -> { text, nextOffset, lossy } }]
 *     run(): { done: Promise<{status:'completed'|'killed'|'failed', detail:string}>, cancel(reason) }
 *   registry.wait(id, timeoutMs, owner) / kill(id, owner, reason) / remove(id, owner)
 * 这里用 JS 字符串游标实现 read（自己 push / 自己 read，计数自洽即可）。
 */
export function makeOutputSource(channel) {
    let text = '';
    let lossy = false;
    return {
        channel: channel,
        push: (chunk) => {
            text += chunk;
            if (text.length > SPILL_CAP) { text = text.slice(text.length - SPILL_CAP); lossy = true; }
        },
        read: (fromByte) => {
            const from = Number.isFinite(fromByte) && fromByte > 0 ? fromByte : 0;
            const body = text.length > from ? text.slice(from) : '';
            return { text: body, nextOffset: text.length, lossy: lossy };
        },
    };
}

/** 起一个已注册的 job。返回 { id, outcome }。 */
export function startBashJob(registry, args, exec, deps) {
    const outSrc = makeOutputSource('stdout');
    const errSrc = makeOutputSource('stderr');
    const controller = new AbortController();
    let childRef = null;
    const done = (async () => {
        try {
            const r = await runCommand(deps.bash, args.command, {
                workdir: args.workdir, timeoutMs: 0,   // ★ 不自己超时（见 runCommand 里的说明）
                onChunk: (chan, text) => { (chan === 'stderr' ? errSrc : outSrc).push(text); },
                onChild: (c) => { childRef = c; },
                signal: controller.signal,
            });
            holder.result = r;
            return { status: r.timedOut ? 'killed' : 'completed', detail: 'exit code: ' + (r.code === null ? '?' : r.code) };
        } catch (e) {
            return { status: 'failed', detail: String((e && e.message) || e) };
        }
    })();
    const holder = { id: null, sources: { stdout: outSrc, stderr: errSrc }, result: null, done: done };
    const id = registry.start({
        kind: 'bash',
        label: args.command,
        ...(exec && exec.agent ? { owner: exec.agent.id } : {}),
        output: [outSrc, errSrc],
        run: () => ({
            done: done,
            cancel: (reason) => {
                try { controller.abort(reason); } catch (e) { /* 忽略 */ }
                try {
                    if (childRef && childRef.pid && process.platform === 'win32') {
                        spawn('taskkill', ['/pid', String(childRef.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                    } else if (childRef) { childRef.kill('SIGKILL'); }
                } catch (e) { /* 忽略 */ }
            },
        }),
    });
    holder.id = id;
    return holder;
}

/** 把执行结果渲染成给模型看的文本。 */
export function renderResult(r, timeoutMs) {
    const out = truncate(r.stdout);
    const err = truncate(r.stderr);
    const lines = [];
    if (r.timedOut) lines.push('[超时 ' + Math.round(timeoutMs / 1000) + 's，已杀进程树]');
    lines.push('exit=' + (r.code === null ? '(no code)' : r.code) + (r.signal ? (' signal=' + r.signal) : ''));
    if (out.text.trim()) lines.push('--- stdout ---\n' + out.text.replace(/\s+$/, ''));
    if (err.text.trim()) lines.push('--- stderr ---\n' + err.text.replace(/\s+$/, ''));
    // ★ 截断时把【完整】输出落盘并给路径（否则超出的部分就永久丢了）
    if (out.truncated) {
        const p = spill(r.stdout, 'stdout');
        lines.push('[stdout 截断：省略前面 ' + out.omitted + ' 字符；完整输出: ' + (p || '(落盘失败)') + ']');
    }
    if (err.truncated) {
        const p = spill(r.stderr, 'stderr');
        lines.push('[stderr 截断：省略前面 ' + err.omitted + ' 字符；完整输出: ' + (p || '(落盘失败)') + ']');
    }
    if (!out.text.trim() && !err.text.trim()) lines.push('(无输出)');
    return lines.join('\n');
}

export const BASH_DESCRIPTION = [
    '★ 这是【默认的命令执行工具】—— 敲命令前先想它，而不是 pwsh。',
    '文本/行处理（sed awk sort uniq cut tr xargs 与管道）、批量改名、正则替换、跨文件统计、查文件、看字节、下载、查进程端口 ——',
    '一律用它：一条管道搞定，比 PowerShell 的 Get-ChildItem/Where-Object/ForEach-Object 又短又快（启动也快 5 倍：43ms vs 241ms）。',
    '★ 只有这三种情况才改用 pwsh：',
    '  ① 要 Windows 对象 / 原生能力：注册表 · 服务 · WMI-CIM · 证书 · 防火墙 · 事件日志 · .NET 静态调用（[System.IO.*]::）；',
    '  ② 要调 .cmd / .ps1 脚本链（llm\\*.cmd 这类老脚本按 5.1 语法写）；',
    '  ③ PowerShell 特有 cmdlet 而 bash 没有等价物。',
    '★ 判断法：这条命令里有【Windows 对象】吗？没有 ⇒ bash。',
    '执行方式：给 command（必填）与 description（必填）；用 workdir 指定工作目录，不要用 cd。独立进程、每次全新 shell。',
    '★ 这些场景也优先用它（省一次工具往返，也避免 PowerShell 的转义坑）：',
    '  · 多模式找文件：rg --files -g "*.{ts,tsx}" -g "!node_modules" / ls **/*.css',
    '  · 先看分布再决定读哪里（代替逐行 grep）：rg -c 模式 或 rg -l 模式',
    '  · 看字节/编码/不可见字符：xxd 文件 | head、od -c 文件、head -c 16 文件 | xxd',
    '  · 批量文件操作：先用 find/printf 干跑一遍看清清单，确认后再 mv/rm（先看后做）',
    '★ 后台：run_in_background=true 时立即返回 job id，用现成的 job_output / job_kill 收割（不必换回 pwsh）；',
    '前台命令若超时，会【自动转为后台】继续跑并给出 job id（进度不丢）。',
    '输出超限截断到尾部，并【把完整输出落盘 + 给出路径】。',
].join(' ');

export const BASH_PARAMETERS = {
    type: 'object',
    properties: {
        command: { type: 'string', description: '要执行的 bash 命令（会以 bash -c 运行）。' },
        description: { type: 'string', description: '一句话说明这条命令在做什么（显示用）。' },
        workdir: { type: 'string', description: '工作目录（绝对或相对会话 cwd）；不要用 cd。' },
        timeoutMs: { type: 'number', description: '超时毫秒数（默认 120000，上限 600000）。前台命令超时后【自动转为后台】继续跑，不会被杀。' },
        run_in_background: { type: 'boolean', description: '放后台跑：立即返回 job id，之后用 job_output 看输出、job_kill 终止（默认 false）。' },
    },
    required: ['command', 'description'],
    additionalProperties: false,
};

/**
 * ★ 工具返回值（2026-10-14 实测教训）：裸 ctx.tools.register() 注册的工具
 *   【必须】声明 output: { schema, render }，否则 register 直接抛
 *   「tool "x" must declare output { schema, render, presentationMeta? }」——
 *   第一版漏了它，两个工具都没注册上（幸好 apply() 里写了 fileLog，日志一眼看到）。
 *   execute 返回的是【结构化 value】，由 output.render 转成模型看到的 content。
 *   这里 value 同时带 text 与 content：render 用 text，老测试/兼容路径用 content。
 */
export function toolValue(text, extra) {
    const base = { text: text, content: [{ type: 'text', text: text }] };
    // ⚠️ 必须剔除 undefined：DSH 会校验返回的 value 是【lossless JSON】，
    //    带一个 undefined 属性就会报 'tool "bash" returned invalid output: value is not lossless JSON'
    //    （2026-10-15 实测：前台路径给 cwd: undefined 时整个调用失败，后台路径因为只传了字符串 jobId 反而正常）
    if (extra) {
        for (const k of Object.keys(extra)) {
            if (extra[k] !== undefined) base[k] = extra[k];
        }
    }
    return base;
}

/** 构造工具定义（导出来是为了能在离线测试里断言形状）。 */
export function bashToolDefinition(deps) {
    const d = deps || {};
    const jobs = d.jobs;                       // 可能为 undefined ⇒ 退化为纯前台
    return {
        name: 'bash',
        description: BASH_DESCRIPTION,
        parameters: BASH_PARAMETERS,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const v = validateArgs(args);
            const bash = d.bash || resolveBash();
            if (!bash) throw new Error('找不到 bash：候选路径都不存在（' + BASH_CANDIDATES.join(' / ') + '）');
            const workdir = v.workdir ? resolvePath(v.workdir) : undefined;
            if (workdir && !existsSync(workdir)) throw new Error('workdir 不存在：' + workdir);
            const spec = { command: v.command, workdir: workdir, timeoutMs: v.timeoutMs };
            const owner = exec && exec.agent ? exec.agent.id : undefined;

            // ① 显式后台 ⇒ 注册成 job，立即把 id 交出去
            if (jobs && v.runInBackground) {
                const h = startBashJob(jobs, spec, exec, { bash: bash });
                return toolValue('已在后台启动（job id: ' + h.id + '）\n用 job_output 看输出、job_kill 终止。', { kind: 'background', jobId: h.id });
            }
            // ② 前台但接了 jobs ⇒ 也注册成 job：超时就能【转后台】而不是把进度杀掉
            if (jobs) {
                let h = null;
                try {
                    h = startBashJob(jobs, spec, exec, { bash: bash });
                    const view = await jobs.wait(h.id, v.timeoutMs, owner);
                    const st = view && view.status;
                    if (st === 'running' || st === 'stopping') {
                        return toolValue('前台等待超时（' + Math.round(v.timeoutMs / 1000) + 's），命令已【转为后台】继续跑（job id: ' + h.id + '）\n用 job_output 收割输出、job_kill 终止。', { kind: 'promoted', jobId: h.id });
                    }
                    try { jobs.remove(h.id, owner); } catch (e) { /* 忽略 */ }
                    // ★ 先等 done 落定，再取结果：wait 返回"已落定"不等于我们自己的 runCommand 回调已跑完
                    //   （否则会渲染出空输出 —— 测试里就是这条先失败）
                    try { await h.done; } catch (e) { /* 忽略 */ }
                    const r = h.result || { code: null, stdout: h.sources.stdout.read(0).text, stderr: h.sources.stderr.read(0).text, timedOut: false };
                    return toolValue(renderResult(r, v.timeoutMs), { kind: 'foreground', exitCode: r.code, cwd: workdir });
                } catch (e) {
                    // ★ 等待失败（例如调用方中止）：绝不能回退去【重跑一遍】命令 —— 那会执行两次。
                    //   如实报告，并把 job id 交出去（命令可能仍在后台跑）。
                    return toolValue('前台等待失败: ' + ((e && e.message) || e)
                        + (h ? ('\n命令可能仍在后台跑（job id: ' + h.id + '）—— 用 job_output 收割、job_kill 终止。') : ''), { kind: 'error' });
                }
            }
            // ③ 纯前台（没有 jobs 服务时的退化路径）
            const r = await runCommand(bash, spec.command, { workdir: workdir, timeoutMs: v.timeoutMs });
            return toolValue(renderResult(r, v.timeoutMs), { kind: 'foreground', exitCode: r.code, cwd: workdir });
        },
        // ★ 必须声明（漏了 register 直接抛错，见 toolValue 上方注释）
        //   ⚠️ 再记一个坑（2026-10-15 实测）：DSH 的 schema 校验器【不支持类型数组】——
        //      写 type: ['number','null'] 会被拒："type arrays are not supported"。
        //      ⇒ 只声明必要字段（text），其余靠 additionalProperties: true 放行。
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    text: { type: 'string' },
                },
                required: ['text'],
            },
            render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
        },
    };
}

/** 判断一个 agent 是不是子 agent（源码原句见宿主API速查 §2.2）。 */
export function isSubagent(agent) {
    try {
        const header = agent?.session?.header;
        return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0;
    } catch (e) { return false; }
}

/**
 * B：对子 agent 隐藏 pwsh。
 * ★ restrict 必须挂在【该 agent 自己的 ctx】上（scoped context），并把返回的 lift 存好，
 *   agent 销毁时调用 —— 否则限制会跟着泄漏。
 */
export function installSubagentPwshDenial(ctx, hooks) {
    const lifts = new Map();
    const onLog = (hooks && hooks.log) || (() => {});
    const visible = (agent) => {
        try { return (ctx.get('tools')?.schemas?.(agent) ?? []).map((s) => s && s.name); }
        catch (e) { return []; }
    };
    const apply = (agent) => {
        try {
            if (!agent || lifts.has(agent)) return;
            if (!isSubagent(agent)) return;                       // 主 agent 一律不动
            if (visible(agent).indexOf('pwsh') < 0) return;        // 本来就没有 pwsh 就别碰
            const scoped = agent.ctx && agent.ctx.tools;
            if (!scoped || typeof scoped.restrict !== 'function') return;
            lifts.set(agent, scoped.restrict({ deny: ['pwsh'] }));
            onLog('已对子 agent 隐藏 pwsh');
        } catch (e) {
            onLog('隐藏 pwsh 失败（忽略）: ' + ((e && e.message) || e));
        }
    };
    const release = (agent) => {
        try { lifts.get(agent)?.(); } catch (e) { /* 忽略 */ }
        lifts.delete(agent);
    };
    ctx.on('agent/created', (payload) => apply(payload && payload.agent));
    ctx.on('agent/disposed', (payload) => release(payload && payload.agent));
    for (const a of (ctx.get('agents')?.list?.() ?? [])) apply(a);
    ctx.effect(() => () => { for (const a of [...lifts.keys()]) release(a); });
    return { apply: apply, release: release, size: () => lifts.size };
}

export function apply(ctx) {
    const log = (m, l) => say(ctx, m, l);
    log('host apply() 开始');
    if (!ctx || typeof ctx.on !== 'function') { log('ctx.on 不可用，未挂载', 'warn'); return; }

    // A：注册 bash 工具
    try {
        const bash = resolveBash();
        if (!bash) { log('找不到 bash，跳过工具注册（候选都不存在）', 'warn'); }
        else {
            // ★ 时序坑（2026-10-14 实测）：本插件只 inject ['tools']，apply 时 jobs 服务【可能还没注册】
            //   ⇒ ctx.get('jobs') 拿到 undefined ⇒ 永久退化成"仅前台"（日志里就是 job 服务: 不可用）。
            //   正解：先注册一版（此刻可能没 jobs），再用 ctx.inject(['jobs'], …) 等服务就绪后【带 jobs 重新注册】。
            let jobsRef = null;
            let disposeTool = null;
            const registerTool = () => {
                // ⚠️ 这里只能用 apply 作用域里的 bash（d 是 bashToolDefinition 内部的概念，
                //    上一版误写成 d 导致 "d is not defined" —— 被自测当场抓到）
                try { if (disposeTool) disposeTool(); } catch (e) { /* 忽略 */ }
                disposeTool = ctx.tools.register(bashToolDefinition({ bash: bash, jobs: jobsRef }));
            };
            try { jobsRef = ctx.get('jobs') || null; } catch (e) { jobsRef = null; }
            registerTool();
            ctx.effect(() => () => { try { if (disposeTool) disposeTool(); } catch (e) { /* 忽略 */ } });
            log('已注册 bash 工具 → ' + bash + '（jobs 服务: ' + (jobsRef ? '立即可用 ⇒ 支持 run_in_background 与超时转后台' : '暂未就绪，等它就绪后自动升级') + '）');
            if (!jobsRef) {
                try {
                    ctx.inject(['jobs'], (jobsCtx) => {
                        try {
                            jobsRef = jobsCtx.get('jobs') || null;
                            if (!jobsRef) return;
                            registerTool();     // 幂等：先注销旧定义再注册新的
                            log('jobs 服务就绪 ⇒ 已重新注册 bash 工具（支持 run_in_background 与超时转后台）');
                        } catch (e) {
                            log('jobs 注入回调失败: ' + ((e && e.message) || e), 'warn');
                        }
                    });
                } catch (e) {
                    log('ctx.inject([jobs]) 不可用，后台能力不可用: ' + ((e && e.message) || e), 'warn');
                }
                // ★ 兜底：万一 inject 不回调（或 jobs 出现得更晚），轮询再试 30 秒。
                //   两条机制互补 —— 已经让用户重启三次了，这里不能再赌。
                let tries = 0;
                const timer = setInterval(() => {
                    if (jobsRef || ++tries > 60) { clearInterval(timer); return; }
                    try {
                        const j = ctx.get('jobs');
                        if (j) {
                            jobsRef = j;
                            registerTool();
                            log('jobs 服务就绪（轮询兜底）⇒ 已重新注册 bash 工具（支持后台）');
                            clearInterval(timer);
                        }
                    } catch (e) { /* 忽略 */ }
                }, 500);
                if (timer && typeof timer.unref === 'function') timer.unref();   // 别拖住进程退出
                ctx.effect(() => () => { try { clearInterval(timer); } catch (e) { /* 忽略 */ } });
            }
        }
    } catch (e) {
        log('注册 bash 工具失败: ' + ((e && e.message) || e), 'error');
    }

    // B：子 agent 隐藏 pwsh
    try {
        // （清理由 installSubagentPwshDenial 内部自己的 ctx.effect 负责，这里不再包一层）
        const guard = installSubagentPwshDenial(ctx, { log: (m) => log(m) });
        log('子 agent 的 pwsh 隐藏已挂载（当前命中 ' + guard.size() + ' 个）');
    } catch (e) {
        log('子 agent 隐藏 pwsh 挂载失败: ' + ((e && e.message) || e), 'error');
    }
}
