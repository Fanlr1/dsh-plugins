// dsh-plugin-chat-user-edit -- host 侧
//
// 改写【自己已发出的 user 消息】（打错字了不用重打一遍）。
//
// 机制（照 dsh-chat-thinking-editor 的成熟做法，那份源码验证过）：
//   会话日志是 append-only；改一条消息 = **追加一条带 surfaceOp 的替换事件**。
//   deriveMessages 折叠后模型只看到改后的版本，旧副本被遮蔽（不删除，不破坏历史）。
//   目标必须同时满足：① 带该 message id ② 仍在 session.surface.nodes 上 ——
//   已被压缩摘要扫走的会明确拒绝，而不是把 fold 弄坏。同一条可反复改。
//
// 零 DSH 依赖：
//   · 官方 import '@deepseek-ai/dsh-session' 只是 TS 的 Context 类型合并，纯 JS 运行时不需要
//   · isSurfaceEvent 的官方实现（dsh-session/surface.js:33）就是
//     SURFACE_EVENT_TYPES.has(type) && event.surfaceOp !== undefined，
//     而 user/message 是 surface-eligible（commands.js:84）⇒ 内联这一句即可
//   （不这么写就得依赖软链在 npx 缓存里的包，那些包离线解析不到 cordis）
//
// 通道：挂到 DSH 自己的 webServer 上（相对路径 /edit-user，同源）。
//   ⚠️ 2026-10-16 实测修正：原先自己起 node:http(48512)，但页面在 dsh-app://app/，
//      client 请求 http://127.0.0.1:48512 会被拦（wallpaper 那边就是这样 UMD 加载 false 的）。
//      正解是 webServer.register —— 与 hub-finder 的 /hub-finder/* 同一路子。


const MAX_BODY = 1 << 20;   // 一条消息 1MB 足够了

export const name = 'chat-user-edit';
export const inject = ['sessions'];

/** user/message 且带 surfaceOp ⇒ 是 surface 事件（内联官方 isSurfaceEvent）。 */
const isSurfaceOf = (ev, type) => ev.type === type && ev.surfaceOp !== undefined;

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

/** 只替换第一个 text 块；其余块（附件/图片/引用）原样保留。 */
export function buildContent(original, text) {
  const out = [];
  let done = false;
  for (const b of original) {
    if (b.type === 'text' && !done) { out.push({ type: 'text', text }); done = true; continue; }
    out.push(b);
  }
  if (!done) out.unshift({ type: 'text', text });
  return out;
}

/**
 * 改一条 user 消息。返回业务结果（不抛），便于离线测试复用同一条路径。
 * @param {{sessionId: string, messageId: string, text: string}} req
 * @param {{sessions?: {get(id: string): any}}} ctx
 */
export function editUser(req, ctx) {
  const { sessionId, messageId, turn, text } = req || {};
  // 宽容：数字或数字字符串都收（DOM 属性天生是字符串，别让调用方踩这个坑）
  const turnNum = turn === undefined ? undefined : Number(turn);
  const byTurn = turnNum !== undefined;
  if (typeof sessionId !== 'string' || typeof text !== 'string') {
    return { ok: false, error: { code: 'invalid-request', message: 'sessionId / text 必须是字符串' } };
  }
  if (!byTurn && typeof messageId !== 'string') {
    return { ok: false, error: { code: 'invalid-request', message: '要给 messageId，或者给 turn 号' } };
  }
  if (byTurn && !Number.isInteger(turnNum)) {
    return { ok: false, error: { code: 'invalid-request', message: 'turn 必须是整数' } };
  }
  // ★ sessionId 宽容：mainReference 给的是 "session-<uuid>"，而 sessions.get 可能要 uuid，
  //   两种都试一遍（2026-10-16 实测：带前缀拿去 get 会拿到一个形状不对的对象，导致 events 不可迭代）
  const get = ctx?.sessions?.get;
  let session = get?.call(ctx.sessions, sessionId);
  let usedId = sessionId;
  if (!session || !session.events) {
    const bare = String(sessionId).replace(/^session-/, '');
    for (const cand of [bare, 'session-' + bare]) {
      try {
        const s2 = get?.call(ctx.sessions, cand);
        if (s2 && (s2.log || s2.events)) { session = s2; usedId = cand; break; }
      } catch { /* 试下一个 */ }
    }
  }
  if (session === undefined || session === null) {
    return { ok: false, error: { code: 'session-not-found', message: '会话不在本进程（可能已关闭）：' + sessionId } };
  }
  if (!session.log && !session.events) {
    return {
      ok: false,
      error: {
        code: 'bad-session-shape',
        message: 'sessions.get(' + usedId + ') 拿到的对象 events 不可迭代；它的键：'
          + (session && typeof session === 'object' ? Object.keys(session).slice(0, 12).join(',') : String(session)),
      },
    };
  }

  // 找【当前 surface 上】最新的一条目标 user/message。
  // 两种定位方式：按 messageId（精确）或按 turn 号（client 侧 DOM 只给得出这个）。
  // ★ 为什么给 turn 也够：一轮里【用户消息最多一条】，且 kind=user 能排掉插件注入的 steer 提示
  //   （那些 source.kind !== 'user'）。
  // ★ 2026-10-16 实测：新版 Session 暴露的是 **log**（不是 events）。
  //   真机 dump 出来的键：log, surfaceManager, header, inheritedEventCount, firstLiveSeq,
  //   firstLifecycleSeq, eventsSnapshot… —— 没有 events。
  //   而 surface 是 getter（`get surface() { return this.surfaceManager }`），
  //   surfaceManager.nodes 也同名 ⇒ 只需换这一个词。
  //   （dsh-chat-thinking-editor 用的是旧 API session.events/session.surface，那是 0.1.x 的形状）
  const events = Array.isArray(session.log) ? session.log : session.events;
  if (!events || typeof events[Symbol.iterator] !== 'function') {
    return { ok: false, error: { code: 'bad-session-shape', message: '会话没有可迭代的 log/events' } };
  }
  let target;
  let anyMatch = false;
  for (const ev of events) {
    if (!isSurfaceOf(ev, 'user/message')) continue;
    // ★ 兼容两种事件形状：
    //   新版(0.2.x): ev.data = { id, role, content, source }        ← data 就是消息本身
    //   旧版(0.1.x): ev.data = { turn, step, message: { id, content, source } }
    const d = ev.data || {};
    const msg = d.message || d;
    const srcKind = msg.source && msg.source.kind;
    if (byTurn) {
      // 新版没有 turn ⇒ 用「turn 号 == 该消息所在事件的次序」不成立，改按 id 传（client 已改）
      if (d.turn !== turnNum) continue;
      if (srcKind !== undefined && srcKind !== 'user') continue;
    } else if (String(msg.id) !== String(messageId) && !String(msg.id).endsWith(String(messageId))) {
      continue;
    }
    anyMatch = true;
    if (!session.surface.nodes.includes(ev.seq)) continue;   // 被摘要扫走 ⇒ 不可编辑
    if (target === undefined || ev.seq > target.seq) target = ev;
  }
  if (target === undefined) {
    // ★ 诊断：把 log 的真实形状报出来（事件类型分布 / user 消息的 turn / source.kind / surfaceOp）
    const types = {};
    const umTurns = [];
    const kinds = {};
    const ops = {};
    for (const ev of events) {
      types[ev.type] = (types[ev.type] || 0) + 1;
      if (ev.type === 'user/message') {
        umTurns.push(ev.data?.turn);
        const k = (ev.data?.message || ev.data || {}).source?.kind;
        kinds[k] = (kinds[k] || 0) + 1;
        const o = ev.surfaceOp === undefined ? 'undefined' : String(ev.surfaceOp);
        ops[o] = (ops[o] || 0) + 1;
      }
    }
    // ★ 再看一条 user/message 的真实形状（turn 是 null、source 是 undefined ⇒ 必然有别的字段）
    const sample = events.find((e) => e.type === 'user/message');
    let sampleInfo = '\n(没有 user/message)';
    if (sample) {
      const d = sample.data || {};
      const m = d.message || d;
      sampleInfo = '\n样本 seq=' + sample.seq
        + ' surfaceOp=' + JSON.stringify(sample.surfaceOp)
        + '\n  data 键: ' + JSON.stringify(Object.keys(d))
        + '\n  message 键: ' + JSON.stringify(Object.keys(m))
        + '\n  message.id: ' + String(m.id)
        + '\n  message.role: ' + String(m.role)
        + '\n  d.turn=' + JSON.stringify(d.turn) + ' d.step=' + JSON.stringify(d.step)
        + '\n  其它顶层字段: ' + JSON.stringify(Object.keys(sample).filter((k) => !['type', 'seq', 'data', 'surfaceOp'].includes(k)));
    }
    const shape = sampleInfo + '\n事件类型: ' + JSON.stringify(types)
      + '\nuser 消息的 turn: ' + JSON.stringify(umTurns.slice(-10))
      + '\nsource.kind: ' + JSON.stringify(kinds)
      + '\nsurfaceOp: ' + JSON.stringify(ops)
      + '\n传入 turn=' + turnNum + ' anyMatch=' + anyMatch;
    return anyMatch
      ? { ok: false, error: { code: 'message-not-editable', message: '这条消息已被更新的 surface 节点取代，不能再改' + shape } }
      : { ok: false, error: { code: 'message-not-found', message: '没找到这条 user 消息' + shape } };
  }

  const data = target.data || {};
  const msg = data.message || data;
  const newContent = buildContent(msg.content || [], text);
  // 按事件原本的形状回写：新版直接写 data，旧版写 data.message
  const newData = data.message
    ? { ...data, message: { ...msg, content: newContent } }
    : { ...data, content: newContent };
  const appended = session.append(
    'user/message',
    newData,
    // ★ 字段名必须是 startSeq / endSeq —— 官方 isReplaceOp 要求恰好 {op,startSeq,endSeq} 三个键
    //   （dsh-session/lib/index.js:293）。旧版的 start/end 会被判 invalid replace surfaceOp。
    { surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq }, sourceEventSeqs: [target.seq] },
  );
  return { ok: true, seq: appended.seq };
}

export function apply(ctx) {
  const log = (m) => { try { ctx.logger?.info?.('[chat-user-edit] ' + m); } catch { /* ignore */ } };

  // ★ 挂到 DSH 自己的 webServer（可选依赖）。
  //   实测：页面在 dsh-app://app/，绝对地址 http://127.0.0.1:<port> 会被拦；
  //   挂 webServer 后 client 用相对路径，同源（与 hub-finder 的 /hub-finder/* 同一路子）。
  ctx.inject(['webServer'], (c) => {
    const ws = c.webServer;
    const disposes = [];

    disposes.push(ws.register({
      kind: 'exact',
      path: '/edit-user/ping',
      handler: (req, res) => sendJson(res, 200, { ok: true }),
    }));

    disposes.push(ws.register({
      kind: 'exact',
      path: '/edit-user',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'method', message: '仅接受 POST' } });
        let body;
        try { body = await readBody(req); }
        catch (e) { return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: String((e && e.message) || e) } }); }
        const out = editUser(body, ctx);
        log('edit-user ' + (out.ok ? 'OK seq=' + out.seq : 'FAIL ' + out.error.code));
        return sendJson(res, out.ok ? 200 : 400, out);
      },
    }));

    ctx.effect(() => () => { for (const d of disposes) { try { d?.(); } catch { /* ignore */ } } });
    log('已挂在 webServer 上：/edit-user');
  });
}

export const _internals = { buildContent, editUser, isSurfaceOf };
