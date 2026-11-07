// dsh-plugin-comfyui -- host 侧
//
// 目的：把「跑 ComfyUI 工作流」固定成两个工具，不再靠每次手搓 curl。
//   · comfyui_list —— 列出工作流文件（UI 格式 / API 格式都认）
//   · comfyui_run  —— 提交工作流、轮询、返回生成的图片
//
// 关键事实（2026-10-19 实测）：
//   · ComfyUI 只认 API 格式（/prompt 对 UI 格式返回 500 / 校验失败）
//   · 本机工作流是 UI 格式，且含 2 个 subgraph ⇒ 这里内置「展开 + 转 API」
//   · ★ CreateBoundingBoxes 的 editor_state 是 required 的 BOUNDING_BOXES 类型，
//     服务端校验器把 list 值一律当「连接」⇒ UI 格式【无法】自动转成可跑的 API。
//     遇到它时返回明确错误，并提示导出 API 格式 / 用 no-bbox 工作流。
//
// 工具注册要点（照 github-tools / hub-finder 的成熟写法）：
//   · inject: ['tools']；ctx.tools.register(def) 返回 dispose
//   · 裸 register 不做参数校验 ⇒ 自己严格校验
//   · output 必须 { schema(根 object), render(fn) }；返回值不能带 undefined

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'comfyui';
export const inject = ['tools'];

// 路径默认值基于 homedir（不写死用户名）；全部可用环境变量覆盖。
const LLM_DIR = process.env.COMFYUI_LLM_DIR || path.join(os.homedir(), 'llm');
const LOG = process.env.COMFYUI_LOG || path.join(LLM_DIR, 'logs', 'comfyui-plugin.log');
const DEFAULT_BASE = 'http://127.0.0.1:8188';
const DEFAULT_DIR = process.env.COMFYUI_WORKFLOWS || path.join(LLM_DIR, 'ComfyUI', 'user', 'default', 'workflows');
const DEFAULT_OUT = process.env.COMFYUI_OUTPUT || path.join(LLM_DIR, 'ComfyUI', 'output');
const DEFAULT_IN = process.env.COMFYUI_INPUT || path.join(LLM_DIR, 'ComfyUI', 'input');

/** apply() 时保存的宿主上下文（工具 execute 里要用 jobs/webServer）。 */
let hostCtx = null;

function log(msg) {
  try {
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf8');
  } catch {}
}

const txt = (t) => ({ text: String(t), content: [{ type: 'text', text: String(t) }] });

function baseUrl() {
  return (process.env.COMFYUI_URL || DEFAULT_BASE).replace(/\/+$/, '');
}
function workflowsDir() {
  return process.env.COMFYUI_WORKFLOWS || DEFAULT_DIR;
}
function outputDir() {
  return process.env.COMFYUI_OUTPUT || DEFAULT_OUT;
}
function inputDir() {
  return process.env.COMFYUI_INPUT || DEFAULT_IN;
}

// ── HTTP（本地明文，fetch 够用）──────────────────────────────────────────────
async function jget(url, timeoutMs = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + text.slice(0, 300));
  return JSON.parse(text);
}

async function jpost(url, body, timeoutMs = 30000) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + text.slice(0, 800));
  return JSON.parse(text);
}

// ── 工作流读取与格式判定 ────────────────────────────────────────────────────
function loadWorkflow(spec) {
  const p = path.isAbsolute(spec) ? spec : path.join(workflowsDir(), spec);
  if (!fs.existsSync(p)) throw new Error('工作流不存在: ' + p);
  if (!/\.json$/i.test(p)) throw new Error('只支持 .json: ' + p);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const isUI = Array.isArray(raw.nodes);
  return { path: p, raw, isUI };
}

// ── UI → API：展开 subgraph + 按 /object_info 映射 widget ─────────────────────
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
// 连接型（必须由 link 提供值）—— 其余一律当 widget，包括 DynamicCombo（COMFY_DYNAMICCOMBO_V3）
const CONN_TYPES = new Set(['MODEL', 'CLIP', 'VAE', 'CONDITIONING', 'LATENT', 'IMAGE', 'MASK', 'CONTROL_NET',
  'STYLE_MODEL', 'CLIP_VISION', 'SIGMAS', 'GUIDER', 'SAMPLER', 'NOISE', 'UPSCALE_MODEL', 'BOUNDING_BOX',
  'BOUNDING_BOXES', 'ARRAY', 'AUDIO', 'VIDEO']);

function linkOf(l) {
  if (Array.isArray(l)) return { id: l[0], o: l[1], os: l[2], t: l[3], ts: l[4] };
  return { id: l.id, o: l.origin_id, os: l.origin_slot, t: l.target_id, ts: l.target_slot };
}

function flattenUI(wf) {
  const subs = new Map();
  for (const s of (wf.definitions && wf.definitions.subgraphs) || []) subs.set(s.id, s);
  const nodes = new Map();
  const edges = [];

  function walk(list, links, prefix, outerSrc, outerDst) {
    const keymap = new Map();
    const local = new Map();
    const inst = new Map();
    for (const n of list) {
      const k = prefix + String(n.id);
      keymap.set(n.id, k);
      local.set(k, n);
      if (subs.has(n.type)) inst.set(k, { node: n, in: new Map() });
    }
    const resolved = [];
    for (const l of links || []) {
      const { o, os: os_, t, ts } = linkOf(l);
      const src = o === -10 ? outerSrc.get(os_) : [keymap.get(o), os_];
      if (t === -20) {
        for (const d of outerDst.get(ts) || []) resolved.push([src, d]);
      } else if (inst.has(keymap.get(t))) {
        inst.get(keymap.get(t)).in.set(ts, src);
      } else {
        resolved.push([src, [keymap.get(t), ts]]);
      }
    }
    for (const [k, it] of inst) {
      const sg = subs.get(it.node.type);
      const outerD = new Map();
      for (const [s, d] of resolved) {
        if (s && s[0] === k) {
          if (!outerD.has(s[1])) outerD.set(s[1], []);
          outerD.get(s[1]).push(d);
        }
      }
      walk(sg.nodes, sg.links, k + '_', it.in, outerD);
    }
    for (const [k, n] of local) if (!inst.has(k)) nodes.set(k, n);
    for (const [s, d] of resolved) {
      if (!s || !s[0]) continue;
      if (inst.has(s[0]) || inst.has(d[0])) continue;
      edges.push([s[0], s[1], d[0], d[1]]);
    }
  }

  walk(wf.nodes, wf.links || [], 'n', new Map(), new Map());
  return { nodes, edges };
}

function buildPrompt(flat, info) {
  const prompt = {};
  const problems = [];
  const inputSpec = (ct, name) => {
    const d = info[ct];
    if (!d || !d.input) return null;
    for (const sec of ['required', 'optional']) {
      const s = d.input[sec] && d.input[sec][name];
      if (s) return { sec, type: s[0] };
    }
    return null;
  };
  // 连接型判定：只有明确属于 CONN_TYPES 的才算连接；其余（含 DynamicCombo）都按 widget 传值
  const isConn = (ct, name) => {
    const s = inputSpec(ct, name);
    if (!s) return false;
    return Array.isArray(s.type) ? false : CONN_TYPES.has(s.type);
  };
  const widgetKeys = (ct) => {
    const d = info[ct];
    if (!d || !d.input) return [];
    const out = [];
    for (const sec of ['required', 'optional']) {
      for (const k of Object.keys(d.input[sec] || {})) if (!isConn(ct, k)) out.push(k);
    }
    return out;
  };

  for (const [k, n] of flat.nodes) {
    const ct = n.type;
    if (ct === 'MarkdownNote') continue;
    const inputs = {};
    const named = n.widgets_values_named;
    if (named && typeof named === 'object' && !Array.isArray(named)) {
      for (const [kk, vv] of Object.entries(named)) {
        if (isConn(ct, kk)) continue;
        if (kk === 'last_incoming') continue;   // BOUNDING_BOXES 的画布内部状态，API 里不能传
        inputs[kk] = vv;                        // 含 DynamicCombo 的 `x` 与 `x.y` 子键（必须保持扁平）
      }
    } else {
      const keys = widgetKeys(ct);
      (n.widgets_values || []).forEach((v, i) => {
        if (i < keys.length) inputs[keys[i]] = v;
      });
    }
    prompt[k] = { class_type: ct, inputs };
  }

  for (const [src, ss, dst, ds] of flat.edges) {
    if (!prompt[dst]) continue;
    const node = flat.nodes.get(dst);
    const slot = (node.inputs || [])[ds];
    if (!slot) continue;
    prompt[dst].inputs[slot.name] = [src, ss];
  }

  // 校验：required 里既不是 widget 也没连接的输入 ⇒ 明确报错
  for (const [k, d] of Object.entries(prompt)) {
    const ct = d.class_type;
    const meta = info[ct];
    if (!meta || !meta.input) continue;
    for (const name of Object.keys(meta.input.required || {})) {
      if (!(name in d.inputs)) {
        const t = meta.input.required[name][0];
        // ★ BOUNDING_BOXES 恰好在连接型名单里（所以 named 分支会跳过它），但它是 required 的
        //   画布状态 ⇒ 必须先特判，否则会报 required_input_missing。
        if (t === 'BOUNDING_BOXES') { d.inputs[name] = { __value__: [] }; continue; }
        if (!(Array.isArray(t) ? false : CONN_TYPES.has(t))) {
          // 非连接型却缺失：
          // · BOUNDING_BOXES（CreateBoundingBoxes.editor_state）⇒ 官方 __value__ 包装传空值
          //   （依据 execution.py 的「Unwraps values wrapped in __value__ key」分支）
          // · COMFY_AUTOGROW_V3 / COMFY_DYNAMICCOMBO_V3 ⇒ 动态组，子项以 `values.a` / `x.y` 形式提供，
          //   组本身缺失是正常的，交给服务端处理
          if (t === 'BOUNDING_BOXES') d.inputs[name] = { __value__: [] };
        }
      }
    }
  }
  return { prompt, problems };
}

function applyOverrides(prompt, opts) {
  const applied = [];

  /** 沿 inputs 里的 [nodeId, slot] 引用往上找，返回第一个 class_type 命中的节点 id。 */
  function resolveRef(id, want, depth = 0) {
    if (depth > 8 || id === null || id === undefined) return null;
    const node = prompt[String(id)];
    if (!node) return null;
    if (want.test(node.class_type || '')) return String(id);
    for (const v of Object.values(node.inputs || {})) {
      if (Array.isArray(v) && typeof v[0] === 'string') {
        const hit = resolveRef(v[0], want, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  if (opts.prompt) {
    // ★ 2026-11-04 修 bug：原来只认 PrimitiveStringMultiline，而 Wan/手写 API 工作流是把
    //   文本直接写在 CLIPTextEncode.text 里的 ⇒ 一律「没找到」。
    //   现在按【采样器的 positive 引用链】定位正向文本节点，负向节点不会被误改。
    let target = null;
    const samplers = Object.entries(prompt)
      .filter(([, d]) => /^KSampler/.test(d.class_type || '') && Array.isArray(d.inputs && d.inputs.positive));
    for (const [, sampler] of samplers) {
      const hit = resolveRef(sampler.inputs.positive[0], /CLIPTextEncode$/);
      if (hit) { target = hit; break; }
    }
    // 兜底：没有任何采样器引用时，找唯一的 CLIPTextEncode
    if (target === null) {
      const encoders = Object.entries(prompt).filter(([, d]) => d.class_type === 'CLIPTextEncode');
      if (encoders.length === 1) target = encoders[0][0];
    }
    // 再兜底：旧的 PrimitiveStringMultiline 关联（Flux 那类工作流）
    if (target === null) {
      const consumers = new Map();
      for (const d of Object.values(prompt)) {
        for (const [name, v] of Object.entries(d.inputs || {})) {
          if (Array.isArray(v) && typeof v[0] === 'string') {
            if (!consumers.has(v[0])) consumers.set(v[0], []);
            consumers.get(v[0]).push(d.class_type + '.' + name);
          }
        }
      }
      for (const [k, d] of Object.entries(prompt)) {
        if (d.class_type !== 'PrimitiveStringMultiline' || typeof d.inputs.value !== 'string') continue;
        const use = (consumers.get(k) || []).join(',');
        if (/TextGenerate\.prompt|Flux3LayoutPrompt\.prompt|CLIPTextEncode\.text/.test(use)) { target = k; break; }
      }
    }
    if (target !== null) {
      const node = prompt[target];
      if (typeof node.inputs.value === 'string') node.inputs.value = opts.prompt;
      else node.inputs.text = opts.prompt;
      applied.push('prompt → 节点 ' + target + '（' + node.class_type + '）');
    } else {
      applied.push('⚠️ 没找到可替换的提示词节点');
    }
  }

  if (opts.seed !== undefined) {
    // ★ 2026-11-04 修 bug：原来 break 只改第一个 KSampler（14B 双模型会漏改）；
    //   而且文案「seed → 7」看着像 seed=7，其实 7 是节点 id ⇒ 改成明确写法。
    let n = 0;
    for (const [k, d] of Object.entries(prompt)) {
      if (/^KSampler/.test(d.class_type || '') && d.inputs && 'seed' in d.inputs) {
        d.inputs.seed = opts.seed;
        applied.push('seed = ' + opts.seed + ' → 节点 ' + k);
        n++;
      }
    }
    if (n === 0) applied.push('⚠️ 没找到 KSampler.seed');
  }

  // ★ 2026-11-05：audio 快捷参数 → 填给 LoadAudio 节点（overrides 若显式指定则随后覆盖）
  if (opts._audioName) {
    let n = 0;
    for (const [k, d] of Object.entries(prompt)) {
      if (d.class_type === 'LoadAudio' && d.inputs) {
        d.inputs.audio = opts._audioName;
        applied.push('audio = ' + opts._audioName + ' → 节点 ' + k);
        n++;
      }
    }
    if (n === 0) applied.push('⚠️ 没找到 LoadAudio 节点（audio 参数未生效）');
  }

  if (opts.width && opts.height) {
    // ★ 2026-11-04：原来只认 EmptyFlux2LatentImage，Wan 系列不认。
    const SIZE_NODES = new Set([
      'EmptyFlux2LatentImage', 'Wan22ImageToVideoLatent', 'WanImageToVideo',
      'EmptyHunyuanLatentVideo', 'EmptyLatentImage', 'EmptySD3LatentImage',
    ]);
    for (const [k, d] of Object.entries(prompt)) {
      if (SIZE_NODES.has(d.class_type) && d.inputs && 'width' in d.inputs && 'height' in d.inputs) {
        d.inputs.width = opts.width;
        d.inputs.height = opts.height;
        applied.push('size = ' + opts.width + 'x' + opts.height + ' → 节点 ' + k + '（' + d.class_type + '）');
        break;
      }
    }
  }

  return applied;
}

// ── 参数清单：工作流可调的 widget（给模型看的「旋钮表」）──────────────────────
async function describeWorkflow(spec) {
  const wf = loadWorkflow(spec);
  const info = await jget(baseUrl() + '/object_info', 30000);
  const rows = [];
  const add = (nodeId, ct, inputs) => {
    const meta = info[ct];
    const row = { node: nodeId, class_type: ct, inputs: {} };
    for (const [name, v] of Object.entries(inputs)) {
      if (Array.isArray(v) && typeof v[0] === 'string' && v.length === 2) continue;  // 连接
      const spec = meta && meta.input
        ? (meta.input.required && meta.input.required[name]) || (meta.input.optional && meta.input.optional[name])
        : null;
      const type = spec ? (Array.isArray(spec[0]) ? 'COMBO' : spec[0]) : '?';
      const options = spec && Array.isArray(spec[0]) ? spec[0].slice(0, 20) : undefined;
      row.inputs[name] = options ? { type, value: v, options } : { type, value: v };
    }
    if (Object.keys(row.inputs).length) rows.push(row);
  };
  if (wf.isUI) {
    const flat = flattenUI(wf.raw);
    const built = buildPrompt(flat, info);
    for (const [k, d] of Object.entries(built.prompt)) add(k, d.class_type, d.inputs);
  } else {
    const prompt = wf.raw.prompt || wf.raw;
    for (const [k, d] of Object.entries(prompt)) add(k, d.class_type, d.inputs || {});
  }
  return { path: wf.path, isUI: wf.isUI, rows };
}

/** 按 { 节点id 或 class_type: { 输入名: 值 } } 覆盖；键名写错直接拒绝。 */
function applyUserOverrides(prompt, overrides) {
  const applied = [];
  const problems = [];
  if (overrides === undefined) return { applied, problems };
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { applied, problems: ['overrides 必须是 { 节点id/class_type: { 输入名: 值 } }'] };
  }
  const byClass = new Map();
  for (const [id, d] of Object.entries(prompt)) {
    if (!byClass.has(d.class_type)) byClass.set(d.class_type, []);
    byClass.get(d.class_type).push(id);
  }
  for (const [key, patch] of Object.entries(overrides)) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      problems.push(key + ' 的值必须是 { 输入名: 值 }');
      continue;
    }
    let targets;
    if (prompt[key]) targets = [key];
    else if (byClass.has(key)) targets = byClass.get(key);
    else { problems.push('找不到节点 id 或 class_type: ' + key); continue; }
    for (const id of targets) {
      const d = prompt[id];
      for (const [input, value] of Object.entries(patch)) {
        if (!(input in d.inputs)) {
          problems.push(id + '(' + d.class_type + ') 没有输入 ' + input + '；可用: ' + Object.keys(d.inputs).join(', '));
          continue;
        }
        d.inputs[input] = value;
        applied.push(id + '.' + input + ' = ' + JSON.stringify(value));
      }
    }
  }
  return { applied, problems };
}

// ── 进度：订阅 ComfyUI 的 /ws（progress 事件）──────────────────────────────────
let comfyWs = null;
let wsRetry = null;
const progressMap = new Map();
function ensureWs() {
  if (comfyWs) return;
  try {
    const s = new WebSocket(baseUrl().replace(/^http/, 'ws') + '/ws');
    comfyWs = s;
    s.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(String(ev.data));
        const d = m && m.type === 'progress' && m.data;
        if (d && typeof d.prompt_id === 'string') {
          progressMap.set(d.prompt_id, { value: d.value, max: d.max, node: d.node });
        }
      } catch {}
    });
    s.addEventListener('close', () => {
      comfyWs = null;
      if (wsRetry === null) wsRetry = setTimeout(() => { wsRetry = null; ensureWs(); }, 3000);
    });
    s.addEventListener('error', () => { try { s.close(); } catch {} });
    log('已连接 ComfyUI WS 进度通道');
  } catch (e) {
    comfyWs = null;
    log('WS 连接失败: ' + (e && e.message));
  }
}
function progressOf(pid) { return progressMap.get(pid); }

/** 取消一个 prompt：排队中的删队列，运行中的发 interrupt。 */
async function cancelPrompt(pid) {
  try {
    await jpost(baseUrl() + '/queue', { delete: [pid] }, 8000);
    log('已从队列删除 ' + pid);
  } catch (e) { log('删队列失败: ' + (e && e.message)); }
  try {
    await jpost(baseUrl() + '/interrupt', {}, 8000);
    log('已发送 interrupt（' + pid + '）');
  } catch (e) { log('interrupt 失败: ' + (e && e.message)); }
}

// ── 资产索引（完成的图，供 /comfyui/assets 与面板）──────────────────────────
const ASSETS = process.env.COMFYUI_ASSETS || path.join(LLM_DIR, 'logs', 'comfyui-assets.json');
function recordAsset(rec) {
  try {
    let arr = [];
    if (fs.existsSync(ASSETS)) {
      try { arr = JSON.parse(fs.readFileSync(ASSETS, 'utf8')); } catch { arr = []; }
    }
    if (!Array.isArray(arr)) arr = [];
    arr.unshift(rec);
    fs.writeFileSync(ASSETS, JSON.stringify(arr.slice(0, 500), null, 1), 'utf8');
  } catch (e) { log('记录资产失败: ' + (e && e.message)); }
}
function listAssets(limit = 50) {
  try {
    if (!fs.existsSync(ASSETS)) return [];
    const arr = JSON.parse(fs.readFileSync(ASSETS, 'utf8'));
    return Array.isArray(arr) ? arr.slice(0, limit) : [];
  } catch { return []; }
}

async function submitWorkflow(spec, opts) {
  const wf = loadWorkflow(spec);
  const base = baseUrl();
  let prompt;
  const notes = [];
  if (wf.isUI) {
    const info = await jget(base + '/object_info', 30000);
    const flat = flattenUI(wf.raw);
    const built = buildPrompt(flat, info);
    if (built.problems.length) {
      throw new Error('无法从 UI 格式转换：\n- ' + built.problems.join('\n- ') +
        '\n建议：在 ComfyUI 里 Workflow → Export (API) 导出一次。');
    }
    prompt = built.prompt;
    notes.push('UI→API 展开：' + flat.nodes.size + ' 节点 / ' + flat.edges.length + ' 边');
  } else {
    prompt = wf.raw.prompt || wf.raw;
    if (typeof prompt !== 'object') throw new Error('API 格式应为 { nodeId: { class_type, inputs } }');
    notes.push('API 格式直接使用');
  }
  const applied = applyOverrides(prompt, opts);
  for (const a of applied) notes.push(a);
  if (opts.overrides !== undefined) {
    const ov = applyUserOverrides(prompt, opts.overrides);
    if (ov.problems.length) throw new Error('overrides 有误：\n- ' + ov.problems.join('\n- '));
    for (const a of ov.applied) notes.push('覆盖: ' + a);
  }
  const sub = await jpost(base + '/prompt', { prompt, client_id: 'dsh-comfyui' });
  notes.push('prompt_id ' + sub.prompt_id);
  return { wf, pid: sub.prompt_id, notes };
}

async function awaitResult(wf, pid, notes, timeoutSec, onProgress) {
  const base = baseUrl();
  const deadline = Date.now() + (timeoutSec || 300) * 1000;
  let hist = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const h = await jget(base + '/history/' + encodeURIComponent(pid), 10000);
      if (h && h[pid]) { hist = h[pid]; break; }
    } catch (e) { /* 继续等 */ }
    if (typeof onProgress === 'function') {
      try { const p = progressOf(pid); if (p) onProgress(p); } catch {}
    }
  }
  if (!hist) throw new Error('等待超时（' + (timeoutSec || 300) + 's），prompt_id=' + pid + '；可用 /comfyui/status 查队列');

  const st = (hist.status || {}).status_str || 'unknown';
  if (st !== 'success') {
    const msgs = JSON.stringify((hist.status || {}).messages || []).slice(0, 800);
    throw new Error('生成失败（' + st + '）：' + msgs);
  }

  // ★ 2026-11-04：视频工作流也走 out.images（ComfyUI PreviewVideo.as_dict() 返回
  //   { images: [...], animated: [true] }）。按 animated 标记或扩展名识别视频。
  const MEDIA_EXT = /\.(mp4|webm|mov|mkv|gif)$/i;
  const images = [];
  // ★ 2026-11-05：ASR / 文本类工作流 —— PreviewAny、ShowText 等把 STRING 输出放在
  //   /history 的 outputs[node].text 数组里（实测 Qwen3-ASR GGUF 节点 → PreviewAny）。
  const texts = [];
  for (const [nid, out] of Object.entries(hist.outputs || {})) {
    const animated = Array.isArray(out.animated) && out.animated.length > 0;
    for (const im of out.images || []) {
      const video = animated || MEDIA_EXT.test(String(im.filename || ''));
      images.push({ node: nid, filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output', width: im.metadata && im.metadata.width, height: im.metadata && im.metadata.height, video });
    }
    if (Array.isArray(out.text)) {
      for (const t of out.text) {
        const s = typeof t === 'string' ? t : JSON.stringify(t);
        if (s != null && String(s).trim() !== '') texts.push({ node: nid, text: String(s) });
      }
    }
  }
  try { recordAsset({ promptId: pid, ts: new Date().toISOString(), workflow: wf.path, images: images.map((i) => ({ filename: i.filename, subfolder: i.subfolder, width: i.width, height: i.height, video: !!i.video })) }); } catch {}
  const lines = ['✅ 完成', '工作流: ' + wf.path, ...notes.map((n) => '· ' + n)];
  for (const im of images) {
    const label = im.video ? '视频' : '图片';
    lines.push(label + ': ' + im.filename + (im.width ? ' (' + im.width + '×' + im.height + ')' : ''));
    lines.push('  本地: ' + path.join(outputDir(), im.subfolder, im.filename));
    lines.push('  URL : /comfyui/media?filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder) + '&type=' + encodeURIComponent(im.type));
  }
  for (const t of texts) {
    lines.push('文本(node ' + t.node + '):');
    for (const ln of String(t.text).split('\n')) lines.push('  ' + ln);
  }
  if (!images.length && !texts.length) lines.push('（没有图片/视频/文本输出）');
  return { text: lines.join('\n'), promptId: pid, images, texts };
}

async function runWorkflow(spec, opts, onProgress) {
  const s = await submitWorkflow(spec, opts);
  return awaitResult(s.wf, s.pid, s.notes, opts.timeoutSec, onProgress);
}

// ── 工具定义 ────────────────────────────────────────────────────────────────
// ★★ 本文件约定（2026-11-05 踩过）：DSH 传给工具 execute 的 args 是 **frozen 对象**
//   （Object.freeze）—— **任何工具都不许往 args 上写字段**，否则抛：
//     TypeError: Cannot add property xxx, object is not extensible
//   需要派生/附加内部字段时：`const opts = { ...args };` 只写 opts（comfyui_run 的 audio 参数就是这样）。
const listDef = {
  name: 'comfyui_list',
  description: '列出 ComfyUI 工作流文件（识别 UI 格式 / API 格式，含大小与修改时间）。参数 dir 可覆盖默认目录。',
  parameters: {
    type: 'object',
    properties: { dir: { type: 'string', description: '工作流目录（默认 <ComfyUI>/user/default/workflows，可用环境变量 COMFYUI_WORKFLOWS 覆盖）' } },
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_a, v) => [{ type: 'text', text: String((v && v.text) || '') }],
  },
  async execute(args) {
    const dir = (args && typeof args.dir === 'string' && args.dir.trim()) || workflowsDir();
    if (!fs.existsSync(dir)) throw new Error('目录不存在: ' + dir);
    const files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f));
    const rows = files.map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      let kind = '?';
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        kind = Array.isArray(j.nodes) ? 'UI' : (j.prompt ? 'API(prompt)' : 'API');
      } catch { kind = '坏 JSON'; }
      return { f, kb: Math.round(st.size / 1024), kind, mtime: st.mtime.toISOString().slice(0, 16) };
    });
    const head = 'ComfyUI 工作流目录: ' + dir + '\n服务: ' + baseUrl() + '\n';
    const body = rows.map((r) => '· ' + r.f + '  [' + r.kind + ']  ' + r.kb + ' KB  ' + r.mtime).join('\n');
    return txt(head + (rows.length ? body : '（无 .json）'));
  },
};

const paramsDef = {
  name: 'comfyui_params',
  description: '列出一个工作流的可调参数（节点 id / class_type / 输入名 / 类型 / 当前值 / 可选值）。配合 comfyui_run 的 overrides 使用。',
  parameters: {
    type: 'object',
    properties: { workflow: { type: 'string', description: '工作流文件名或绝对路径' } },
    required: ['workflow'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_a, v) => [{ type: 'text', text: String((v && v.text) || '') }],
  },
  async execute(args) {
    if (!args || typeof args.workflow !== 'string' || !args.workflow.trim()) throw new Error('workflow 必填');
    const d = await describeWorkflow(args.workflow.trim());
    const lines = ['工作流: ' + d.path, '格式: ' + (d.isUI ? 'UI（已展开）' : 'API'), ''];
    for (const r of d.rows) {
      lines.push(r.node + '  ' + r.class_type);
      for (const [name, v] of Object.entries(r.inputs)) {
        let line = '    ' + name + '  [' + v.type + ']  = ' + JSON.stringify(v.value);
        if (v.options) line += '   可选: ' + v.options.join(' | ');
        lines.push(line);
      }
    }
    return txt(lines.join('\n'));
  },
};

const runDef = {
  name: 'comfyui_run',
  description: '运行 ComfyUI 工作流（UI 或 API 格式）。mode=sync 阻塞等待并返回图片/视频/【文本】（ASR 等文本输出以 texts 返回并显示）；mode=async 提交为后台 job 后立刻返回 —— 之后【结束本轮】等完成通知，再调一次 job_output 取现成 Markdown。可覆盖 prompt / seed / 宽高；ASR 用 audio 参数直接传本地音频（自动复制到 ComfyUI/input 并填入 LoadAudio）。',
  parameters: {
    type: 'object',
    properties: {
      workflow: { type: 'string', description: '工作流文件名（默认目录下）或绝对路径' },
      prompt: { type: 'string', description: '替换提示词（自动挑喂给 TextGenerate/CLIPTextEncode 的那个节点，避开 system_prompt）' },
      seed: { type: 'number', description: '替换 KSampler.seed' },
      width: { type: 'number' }, height: { type: 'number' },
      timeoutSec: { type: 'number', description: '等待上限，默认 300' },
      mode: { type: 'string', enum: ['sync', 'async'], description: 'sync（默认）等结果；async 交给后台 job，提交后结束本轮' },
      overrides: { type: 'object', additionalProperties: true, description: '按节点覆盖输入：{ "节点id或class_type": { "输入名": 值 } }；键名写错会被拒绝（先 comfyui_params 查）' },
      audio: { type: 'string', description: '本地音频路径（ASR 用）：插件自动复制到 ComfyUI/input 并填入工作流里的 LoadAudio.audio' },
    },
    required: ['workflow'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_a, v) => [{ type: 'text', text: String((v && v.text) || '') }],
  },
  async execute(args, exec) {
    if (!args || typeof args.workflow !== 'string' || !args.workflow.trim()) throw new Error('workflow 必填（文件名或绝对路径）');
    const allowed = ['workflow', 'prompt', 'seed', 'width', 'height', 'timeoutSec', 'mode', 'overrides', 'audio'];
    for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new Error('未知参数: ' + k);
    if (args.mode !== undefined && args.mode !== 'sync' && args.mode !== 'async') throw new Error('mode 只能是 sync 或 async');
    const spec = args.workflow.trim();

    // ★ 2026-11-05：audio 快捷参数 —— 本地音频自动复制进 ComfyUI/input/，
    //   再由 applyOverrides 填给工作流里的 LoadAudio.audio（overrides 显式指定时优先）。
    // ★ 2026-11-05 修 bug：DSH 传给工具的 args 是 frozen 对象（Object.freeze），
    //   直接 `args._audioName = ...` 会抛「Cannot add property _audioName, object is not extensible」。
    //   ⇒ 先 spread 出可写副本 opts，内部字段只写 opts。
    const opts = { ...args };

    if (args.audio !== undefined) {
      if (typeof args.audio !== 'string' || !args.audio.trim()) throw new Error('audio 须为本地音频文件路径');
      const src = path.resolve(args.audio.trim());
      if (!fs.existsSync(src)) throw new Error('audio 文件不存在: ' + src);
      const dir = inputDir();
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(src);
      fs.copyFileSync(src, path.join(dir, base));
      opts._audioName = base;
      log('audio 已复制到 input: ' + base);
    }

    if (opts.mode === 'async') {
      const ctx = hostCtx;
      // ★ cordis：未声明 inject 的属性访问会抛「cannot get property … without inject」
      //   ⇒ jobs 只走 ctx.get()，不碰 ctx.jobs。
      const jobs = ctx && typeof ctx.get === 'function' ? ctx.get('jobs') : null;
      if (!jobs || typeof jobs.start !== 'function') throw new Error('jobs 服务不可用（宿主过旧），请改用 mode=sync');
      const session = typeof jobs.readAt === 'function';   // 0.1.7+：owner 是 sessionId，结果在 result
      const s = await submitWorkflow(spec, opts);
      // ★ owner 必须来自【工具执行上下文】exec.agent —— 插件的 apply ctx 上没有 agent。
      //   依据：dsh-comfyui 的 ToolRunContext { agent?, signal, callId? }。
      const rawOwner = exec && exec.agent;
      const owner = session && rawOwner && typeof rawOwner === 'object' && typeof rawOwner.id === 'string'
        ? rawOwner.id : rawOwner;
      const jobId = jobs.start({
        kind: 'comfyui',
        label: 'ComfyUI: ' + path.basename(s.wf.path),
        ...(owner ? { owner } : {}),
        // ★ jobs-local 的契约：run(handle) 必须返回 { cancel, done } —— 不是 Promise！
        //   依据：@deepseek-ai/dsh-jobs-local/lib/index.js 的 start()：
        //     const hooks = spec.run(handle); job.cancel = hooks.cancel.bind(hooks); hooks.done.then(...)
        //   返回 Promise 会让 hooks.cancel === undefined ⇒ 「Cannot read properties of undefined (reading 'bind')」
        run: (handle) => {
          ensureWs();
          const done = (async () => {
            try {
              const r = await awaitResult(s.wf, s.pid, s.notes, opts.timeoutSec, (pr) => {
                try { if (handle && handle.updateProgress) handle.updateProgress('节点 ' + (pr.node === null || pr.node === undefined ? '?' : pr.node) + ': ' + pr.value + '/' + pr.max); } catch {}
              });
              try {
                if (handle && handle.append) {
                  const parts = [];
                  if (r.images && r.images.length) parts.push(r.images.map((i) => i.filename).join(', '));
                  if (r.texts && r.texts.length) parts.push('文本: ' + r.texts[0].text.slice(0, 80));
                  handle.append('完成: ' + (parts.join(' | ') || '无输出'));
                }
              } catch {}
              return session ? { status: 'completed', result: r.text } : { status: 'completed', output: r.text };
            } catch (e) {
              log('async job 失败: ' + (e && e.message));
              return session
                ? { status: 'failed', detail: 'comfyui: ' + (e && e.message) }
                : { status: 'failed', detail: 'comfyui', output: String(e && e.message) };
            }
          })();
          return {
            cancel: () => {
              try { log('job 被取消: ' + s.pid); } catch {}
              try { cancelPrompt(s.pid).catch(() => {}); } catch {}
            },
            done,
          };
        },
      });
      log('async job ' + jobId + ' prompt ' + s.pid);
      return txt([
        '已提交到后台：job ' + jobId + '，prompt ' + s.pid + '。',
        '',
        '**不要等待、不要轮询、不要现在调 job_output** —— 告诉用户正在生成，然后结束本轮。',
        '完成后本会话会收到通知；届时调一次 job_output（不带 wait），结果就是现成的 Markdown 图片行，直接贴进回复。',
      ].join('\n'));
    }

    const res = await runWorkflow(spec, opts);
    return txt(res.text);
  },
};

export function apply(ctx) {
  hostCtx = ctx;
  const logger = ctx.logger || console;
  log('=== apply() 开始 ===');
  const disposes = [];

  try {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') {
      log('ctx.tools 不可用');
      return;
    }
    disposes.push(ctx.tools.register(listDef));
    disposes.push(ctx.tools.register(paramsDef));
    disposes.push(ctx.tools.register(runDef));
    log('已注册 comfyui_list / comfyui_params / comfyui_run');
  } catch (e) {
    log('注册工具失败: ' + (e && e.message));
    try { logger.error && logger.error('[comfyui] 注册失败', e); } catch {}
  }

  // 可选：同源媒体路由。★ apply() 执行时 webServer 可能还没就绪（时序问题，
  //   2026-10-19 实测第一次装载就遇到），所以先直接取，取不到再用 ctx.inject 延迟挂载。
  const mountRoutes = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return false;
    webServer.register({ kind: 'exact', path: '/comfyui/status', handler: async (req, res) => {
      try {
        const s = await jget(baseUrl() + '/system_stats', 5000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, base: baseUrl(), comfyui: s.system && s.system.comfyui_version }));
      } catch (e) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
      }
    } });
    webServer.register({ kind: 'exact', path: '/comfyui/media', handler: async (req, res) => {
      try {
        const u = new URL(req.url, 'http://x');
        const fn = u.searchParams.get('filename') || '';
        const sub = u.searchParams.get('subfolder') || '';
        const type = u.searchParams.get('type') || 'output';
        if (type !== 'output') { res.writeHead(400); res.end('only output'); return; }
        const root = path.resolve(outputDir());
        const full = path.resolve(root, sub, fn);
        if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) { res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(full).toLowerCase();
        // ★ 2026-11-04：加视频 MIME + Range 支持（<video> 播放与拖动进度条需要 206）
        const MEDIA_MIME = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
          '.gif': 'image/gif', '.bmp': 'image/bmp',
          '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
        };
        const mime = MEDIA_MIME[ext] || 'application/octet-stream';
        const stat = fs.statSync(full);
        const headers = { 'content-type': mime, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
        const rangeHeader = req.headers && req.headers.range;
        if (rangeHeader) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
          if (m) {
            let start = m[1] === '' ? stat.size - Number(m[2]) : Number(m[1]);
            let end = (m[1] === '' || m[2] === '') ? stat.size - 1 : Number(m[2]);
            if (!Number.isFinite(start) || start < 0) start = 0;
            if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
            if (start > end) {
              res.writeHead(416, { 'content-range': 'bytes */' + stat.size });
              res.end();
              return;
            }
            headers['content-length'] = String(end - start + 1);
            headers['content-range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
            res.writeHead(206, headers);
            fs.createReadStream(full, { start, end }).pipe(res);
            return;
          }
        }
        headers['content-length'] = String(stat.size);
        res.writeHead(200, headers);
        fs.createReadStream(full).pipe(res);
      } catch (e) {
        res.writeHead(500); res.end(String(e && e.message));
      }
    } });
    webServer.register({ kind: 'exact', path: '/comfyui/assets', handler: async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(listAssets(100)));
    } });
    webServer.register({ kind: 'exact', path: '/comfyui/queue', handler: async (req, res) => {
      try {
        const q = await jget(baseUrl() + '/queue', 5000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(q));
      } catch (e) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message) }));
      }
    } });
    log('已挂载 /comfyui/status · /comfyui/media · /comfyui/assets · /comfyui/queue');
    return true;
  };
  try {
    let ws = null;
    try { ws = ctx.webServer; } catch { ws = null; }   // ★ 是属性，不是 ctx.get('webServer')（后者拿到 undefined）
    if (!mountRoutes(ws)) {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (c) => {
          try { mountRoutes(c.webServer); } catch (e) { log('延迟挂载路由失败: ' + (e && e.message)); }
        });
        log('webServer 尚未就绪，已用 ctx.inject 延迟挂载');
      } else {
        log('webServer 不可用，跳过媒体路由');
      }
    }
  } catch (e) {
    log('注册路由失败: ' + (e && e.message));
  }

  if (ctx.effect) {
    try { ctx.effect(() => () => { for (const d of disposes) { try { d && d(); } catch {} } }); } catch {}
  }
  log('=== apply() 结束 ===');
}
