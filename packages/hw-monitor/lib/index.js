// dsh-plugin-hw-monitor -- host 侧
//
// 采集五项硬件指标并挂成投影，供浏览器侧读取。
//
// 采集开销（本机实测，2026-10-03）：
//   os 模块（内存 + CPU 占用）      0.65 微秒/次   —— 基本免费
//   nvidia-smi（显存/GPU/温度/功耗/频率）  48 ms/次  —— 一次调用拿全部
//   Get-Counter（CPU 实时频率）     约 1.1 秒/次   —— PDH 必须跨一个采样窗口，绕不开
//
// 因此采用三档频率：
//   2.5 秒：nvidia-smi + os 模块
//   10 秒：Get-Counter 取 CPU 频率（异步，且不重入）
//
// 实测：推理中每 800ms 调一次 nvidia-smi，生成速度 36.79 → 36.79 tok/s（影响 0%）。
//
// ⚠️ 投影是【会话事件驱动】的（与 balance-mvp 同一机制）：agent 工作时事件密集、
//    刷新频繁；空闲时保持最后一次的值。对"看推理时的硬件状态"这个用途是够的。

import { execFile } from 'node:child_process';
import os from 'node:os';
import { z } from 'zod';

const GPU_MS = 2500;      // nvidia-smi + os 模块
const CPUCLK_MS = 10000;  // Get-Counter 取 CPU 频率

// ── 主机侧缓存（定时器写入，投影读取）──
let cache = {
    // GPU（nvidia-smi 一次拿全）
    vramUsed: null,        // MiB
    vramTotal: null,       // MiB
    gpuPct: null,          // %
    gpuTempC: null,        // °C
    gpuWatt: null,         // W
    gpuMHz: null,          // MHz

    // 内存（os 模块）
    memUsedGB: null,
    memTotalGB: null,

    // CPU（os 模块 delta）
    cpuPct: null,
    cpuCores: null,

    // CPU 实时频率（PDH，慢）
    cpuMHz: null,

    updatedAt: null,
    cpuClkUpdatedAt: null,
    error: null,
};

export function readHwCache() {
    return cache;
}

// ── CPU 占用：靠两次 os.cpus() 采样算 delta（0.65 微秒，几乎免费）──
let lastCpu = null;

function sampleCpu() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
        for (const k in c.times) total += c.times[k];
        idle += c.times.idle;
    }
    const now = { idle, total };
    let pct = null;
    if (lastCpu !== null) {
        const dt = now.total - lastCpu.total;
        const di = now.idle - lastCpu.idle;
        if (dt > 0) pct = Math.max(0, Math.min(100, (1 - di / dt) * 100));
    }
    lastCpu = now;
    return { pct, cores: cpus.length };
}

function sampleMem() {
    const total = os.totalmem();
    const free = os.freemem();
    return {
        usedGB: (total - free) / 1073741824,
        totalGB: total / 1073741824,
    };
}

/** nvidia-smi 一次拿 6 项（48ms）。 */
function readGpu() {
    return new Promise((resolve) => {
        const q = 'memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,clocks.current.graphics';
        execFile('nvidia-smi', ['--query-gpu=' + q, '--format=csv,noheader,nounits'],
            { timeout: 5000, windowsHide: true },
            (err, stdout) => {
                if (err || !stdout) {
                    resolve({ ok: false, error: err ? String(err.message || err) : 'no output' });
                    return;
                }
                const line = String(stdout).trim().split(/\r?\n/)[0] || '';
                const a = line.split(',').map((s) => s.trim());
                const num = (v) => {
                    const n = Number(v);
                    return Number.isFinite(n) ? n : null;
                };
                resolve({
                    ok: true,
                    vramUsed: num(a[0]),
                    vramTotal: num(a[1]),
                    gpuPct: num(a[2]),
                    gpuTempC: num(a[3]),
                    gpuWatt: num(a[4]),
                    gpuMHz: num(a[5]),
                });
            });
    });
}

/** CPU 实时频率：PDH 必须跨采样窗口，约 1.1 秒。异步、不重入。 */
let cpuClkBusy = false;

function readCpuClock() {
    if (cpuClkBusy) return;
    cpuClkBusy = true;
    const ps = 'powershell.exe';
    const cmd = "(Get-Counter -Counter '\\Processor Information(_Total)\\Processor Frequency' -MaxSamples 1 -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue";
    execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { timeout: 15000, windowsHide: true },
        (err, stdout) => {
            cpuClkBusy = false;
            if (err || !stdout) return;
            const v = Number(String(stdout).trim());
            if (Number.isFinite(v) && v > 0) {
                cache = { ...cache, cpuMHz: Math.round(v), cpuClkUpdatedAt: Date.now() };
            }
        });
}

// ── 投影定义（照 balance-mvp / 官方 dsh-session-stats 的接口）──
const shape = {
    vramUsed: z.number().nullable(),
    vramTotal: z.number().nullable(),
    gpuPct: z.number().nullable(),
    gpuTempC: z.number().nullable(),
    gpuWatt: z.number().nullable(),
    gpuMHz: z.number().nullable(),

    memUsedGB: z.number().nullable(),
    memTotalGB: z.number().nullable(),

    cpuPct: z.number().nullable(),
    cpuCores: z.number().nullable(),
    cpuMHz: z.number().nullable(),

    updatedAt: z.number().nullable(),
    cpuClkUpdatedAt: z.number().nullable(),
    error: z.string().nullable(),
};

const stateSchema = z.object(shape).strict();
const viewSchema = z.object(shape).strict();

function same(a, b) {
    for (const k of Object.keys(shape)) {
        if (a[k] !== b[k]) return false;
    }
    return true;
}

export const hwProjectionDefinition = {
    key: 'hwMonitor',
    stateVersion: 1,
    stateSchema,
    init: () => ({ ...cache }),
    apply: (state, _event) => {
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

// ── 插件主体 ──
export const name = 'hw-monitor';
// 必须声明 inject 才能访问 ctx.sessionProjections（否则报
// "cannot get property ... without inject"）。与官方 dsh-session-stats 一致。
export const inject = ['sessionProjections'];

export function apply(ctx) {
    console.log('[hw-monitor] host apply()');

    // 注册投影
    try {
        ctx.sessionProjections.register(hwProjectionDefinition);
        console.log('[hw-monitor] ✅ 投影已注册: hwMonitor');
    } catch (e) {
        console.log('[hw-monitor] ⚠ 投影注册失败: ' + (e && e.message ? e.message : String(e)));
    }

    // ── 快档：GPU + 内存 + CPU 占用 ──
    const tickFast = async () => {
        const mem = sampleMem();
        const cpu = sampleCpu();
        const next = {
            ...cache,
            memUsedGB: Math.round(mem.usedGB * 100) / 100,
            memTotalGB: Math.round(mem.totalGB * 100) / 100,
            cpuPct: cpu.pct === null ? null : Math.round(cpu.pct * 10) / 10,
            cpuCores: cpu.cores,
            updatedAt: Date.now(),
        };
        const g = await readGpu();
        if (g.ok) {
            Object.assign(next, {
                vramUsed: g.vramUsed,
                vramTotal: g.vramTotal,
                gpuPct: g.gpuPct,
                gpuTempC: g.gpuTempC,
                gpuWatt: g.gpuWatt,
                gpuMHz: g.gpuMHz,
                error: null,
            });
        } else {
            next.error = g.error;
        }
        cache = next;
    };

    // 立即采一次（预热 CPU delta 与显存）
    tickFast().catch(() => {});
    setTimeout(() => { tickFast().catch(() => {}); }, 400);
    const tFast = setInterval(() => { tickFast().catch(() => {}); }, GPU_MS);

    // ── 慢档：CPU 实时频率 ──
    setTimeout(() => readCpuClock(), 1500);
    const tSlow = setInterval(() => readCpuClock(), CPUCLK_MS);

    ctx.on('dispose', () => {
        clearInterval(tFast);
        clearInterval(tSlow);
    });

    console.log('[hw-monitor] 采样已启动: GPU/内存/CPU 每 ' + (GPU_MS / 1000) + 's, CPU频率每 ' + (CPUCLK_MS / 1000) + 's');
}
