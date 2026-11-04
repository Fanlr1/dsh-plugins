// dsh-plugin-chat-user-edit -- client 侧【正式版】
//
// 给每条【自己发出的】消息挂一根小铅笔，点开就能改（不用重打一遍）。
//
// 锚点全部来自官方语义属性（不是 hash 类名）—— 2026-10-16 真机探得：
//   [data-slot="conversation.chat.flow"]   消息流容器
//   [data-chat-flow-kind="user"]           ★ 用户消息（其余 assistant-step / turn-tail / turn-process）
//   [data-chat-turn="108"]                 turn 号（干净数字，用它而不是 anchor-key）
//   [data-slot="conversation.chat.node"]   每条消息下的纯锚点（display:contents）
//
// ★ 不用 data-chat-anchor-key 里的 uuid：第一段只有 7 位 hex（非规范 UUID），像内部 id；
//   而 turn 号语义化，host 侧按「turn + kind=user」定位更稳。
//
// sessionId：URL 是光秃秃的 dsh-app://app/（无 search/hash），所以注册一个【隐形】的
//   conversation.chat.node 插槽条目，从 props 里读 sessionId（session-cleaner 验证过这条路）。

window.__ModuleLoader__.load({
    id: 'dsh-plugin-chat-user-edit',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        // ★ 相对路径：走 DSH 自己的 webServer（同源）。绝对地址在 dsh-app:// 下会被拦。
        const HOST = '';
        const STYLE_ID = 'dsh-plugin-chat-user-edit/client.css';
        const BTN_ATTR = 'data-useredit-btn';
        const MODAL_ID = 'dsh-useredit-modal';
        const USER_SEL = '[data-slot="conversation.chat.flow"] [data-chat-flow-kind="user"]';

        let sessionId = null;      // 缓存，仅用于显示/日志
        let liveCtx = null;        // apply 时存下，供现取
        const log = (...a) => { try { console.log('%c[user-edit]', 'color:#0aa', ...a); } catch (e) { /* ignore */ } };

        /**
         * 当前会话 id —— **现取**，不依赖任何 slot。
         *
         * 2026-10-16 真机探得（控制台逐层剥）：
         *   ctx.get('uiWorkspace').mainReference = ClientSessionReference {
         *     sessionId: 'session-c86a7da4-9a33-45fc-b6d9-9e3385381705', … }
         * ⇒ 这才是「用户当前正在看的会话」。userspace.selection 是个可订阅对象（getSnapshot/
         *   subscribe/set），mainReference 直接给现成的 id。
         * ★ 之前往 conversation.chat.node 注册 slot 去读 props.sessionId 是错的（那是注册点，
         *   不是普通 Entry），而且拆掉后仍然崩 ⇒ 崩溃与它无关（真凶是 wallpaper-lite）。
         */
        function currentSessionId() {
            try {
                const ws = liveCtx && typeof liveCtx.get === 'function' ? liveCtx.get('uiWorkspace') : null;
                const id = ws && ws.mainReference && ws.mainReference.sessionId;
                return typeof id === 'string' && id.length > 0 ? id : null;
            } catch (e) { return null; }
        }

        const CSS = [
            // 与官方操作条里的"复制"按钮并排：只加极小的差异，其余交给官方样式
            '[' + BTN_ATTR + ']{cursor:pointer;background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;',
            'opacity:.75;line-height:1;display:inline-flex;align-items:center}',
            '[' + BTN_ATTR + ']:hover{opacity:1}',
            '[' + BTN_ATTR + '][data-edited]{opacity:1;color:#16a34a}',
            '[' + BTN_ATTR + '][data-edited]::before{content:"\\2713 ";font-size:11px}',
            '[' + BTN_ATTR + '][data-edited]:hover::after{content:"已编辑"}',
            '[' + BTN_ATTR + ']{position:relative}',
            // 黑底白字 tooltip（自己画）：官方那个气泡是它的组件，克隆继承不到 ⇒ 伪元素复刻观感
            // 与官方「复制」气泡逐项对齐（截图目测；三次动态抓取都没抓到那个 hover 才渲染的组件，
            // 不值得再为几个像素来回。关键项：深灰底 / 白字 / 12px / 圆角 8 / padding 4·8 / 无阴影 / 距按钮 6px）
            '[' + BTN_ATTR + ']:hover::after{content:"编辑这条消息";position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);',
            'background:#2b2b2b;color:#fff;font-size:12px;font-weight:400;line-height:1.4;padding:4px 8px;border-radius:8px;',
            'letter-spacing:0;white-space:nowrap;pointer-events:none;z-index:1000;box-shadow:none}',
            '[' + BTN_ATTR + '][data-useredit-float]{position:absolute;top:2px;right:2px;z-index:5;opacity:0}',
            '[data-chat-flow-kind="user"]:hover [' + BTN_ATTR + '][data-useredit-float]{opacity:.75}',
            // ★ 2026-10-16 修「不原生」：原先用 Canvas/CanvasText 这类【浏览器默认色】，
            //   在 DSH 的深色主题下就是一块刺眼的白板。改用 DSH 自己的主题变量
            //   （--dsw-alias-*，与 session-cleaner 的弹窗同一套），于是自动跟随主题。
            // 颜色包一层自己的语义别名（浅色一套、暗色一套）—— 2026-10-16 读
            // handbooks\dsh-plugin\02-样式对齐.md「读官方 Modal.module.css 学到的」四条：
            //   ① 层级用官方量级（遮罩 998 / 弹窗 999），别压过系统级弹窗
            //   ② 面板高度用 calc(100vh - 64px)，不用 80vh
            //   ③ 颜色先包语义别名，声明在 :root 与 body[data-ds-dark-theme] ⇒ 暗色自动跟随
            ':root{--ue-bg:var(--dsw-alias-bg-base,#fff);--ue-fg:var(--dsw-alias-label-primary,#111827);',
            '--ue-dim:var(--dsw-alias-label-tertiary,rgba(17,24,39,.6));--ue-line:var(--dsw-alias-border-secondary,rgba(17,24,39,.14))}',
            'body[data-ds-dark-theme]{--ue-bg:var(--dsw-alias-bg-base,#1b1b1f);--ue-fg:var(--dsw-alias-label-primary,#e8e8ea);',
            '--ue-dim:var(--dsw-alias-label-tertiary,rgba(232,232,234,.6));--ue-line:var(--dsw-alias-border-secondary,rgba(255,255,255,.14))}',
            '#' + MODAL_ID + '{position:fixed;inset:0;z-index:998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);',
            'animation:ue-fade .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}',
            '@keyframes ue-fade{from{opacity:0}to{opacity:1}}',
            // ★ 不再用 min()：那张全屏截图里弹窗横贯约 1330px，说明 min(720px,86vw)
            //   这条声明被整条丢弃了（解析器不支持时不会只忽略函数，而是丢弃整条声明）。
            //   拆成 width + max-width 更兼容。
            '#' + MODAL_ID + ' .ue-box{width:720px;max-width:calc(100vw - 48px);max-height:calc(100vh - 64px);display:flex;flex-direction:column;gap:16px;',
            'z-index:999;position:relative;',
            'padding:20px;border-radius:16px;font:inherit;',
            'background:var(--ue-bg);color:var(--ue-fg);border:1px solid var(--ue-line);box-shadow:0 12px 40px rgba(0,0,0,.35)}',
            // 结构与配色对齐官方面板：标题区 / 正文区 / 底部动作区，各带一条分隔线
            // （--dsw-alias-input-border 与 --dsw-alias-button-primary-fill/-hover 都取自
            //   knowledge-base\resources\dsh-plugin\官方CSS参数.md，是官方的专用变量）
            // 与官方「添加插件」弹窗并排比对后的修正：官方【没有】分隔线（平坦布局）、圆角更大、内边距更宽松
            '#' + MODAL_ID + ' .ue-title{font-size:16px;font-weight:600;letter-spacing:.2px}',
            // ★ box-sizing:border-box 必须有：默认 content-box 时 width:100% 再加上 padding/border，
            //   总宽会超出父容器 ⇒ 左边看似有白边、右边被裁掉（2026-10-16 使用者指出）。
            '#' + MODAL_ID + ' *{box-sizing:border-box}',
            '#' + MODAL_ID + ' textarea{display:block;width:100%;min-height:8em;max-height:52vh;resize:vertical;font:inherit;padding:10px;',
            'border-radius:8px;color:var(--ue-fg);background:var(--ue-bg);',
            'border:1px solid var(--dsw-alias-input-border,var(--ue-line));outline:none}',
            // 焦点不换色：使用者要求"有输入线就够了"（2026-10-16）
            '#' + MODAL_ID + ' textarea:focus{outline:none}',
            '#' + MODAL_ID + ' .ue-row{display:flex;gap:8px;justify-content:flex-end;align-items:center}',
            '#' + MODAL_ID + ' button{font:inherit;padding:6px 16px;border-radius:8px;cursor:pointer;font-weight:500;',
            'color:var(--ue-fg);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));border:1px solid var(--ue-line)}',
            '#' + MODAL_ID + ' button:hover{background:var(--dsw-alias-border-secondary,rgba(127,127,127,.2))}',
            '#' + MODAL_ID + ' button.ue-save{color:#fff;border:0;',
            'background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-state-business-primary,#4f6ef7))}',
            '#' + MODAL_ID + ' button.ue-save:hover{background:var(--dsw-alias-button-primary-hover,#3d5ce0)}',
            '#' + MODAL_ID + ' .ue-hint{margin-right:auto;color:var(--ue-dim);font-size:12px}',
            '#' + MODAL_ID + ' .ue-x{position:absolute;top:18px;right:20px;padding:2px 6px;border:0;background:0 0;',
            'font-size:16px;line-height:1;color:var(--ue-dim);border-radius:6px;cursor:pointer}',
            '#' + MODAL_ID + ' .ue-x:hover{color:var(--ue-fg);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
        ].join('\n');

        function injectCss() {
            if (document.getElementById(STYLE_ID)) return;
            const tag = document.createElement('style');
            tag.id = STYLE_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        /**
         * 取这条 user 消息的【正文】，用于编辑框预填。
         *
         * 2026-10-16 使用者指出：「复制我发出的会话时，把时间也复制进去了」——
         * 因为原来取的是整条 [data-chat-flow-kind=user] 的 innerText，而那一层里
         * 除正文外还挂着时间戳（19:29）等附属信息。
         * ⇒ 只取 conversation.chat.node 这个正文锚点（真机实测：它的文本就是正文本身），
         *   再兜底剥掉"行尾的 HH:MM"与时间行。
         */
        function textOf(node) {
            const body = node.querySelector('[data-slot="conversation.chat.node"]') || node;
            const clone = body.cloneNode(true);
            clone.querySelectorAll('[' + BTN_ATTR + ']').forEach((b) => b.remove());
            return (clone.innerText || '')
                .replace(/[ \t]*\d{1,2}:\d{2}(:\d{2})?[ \t]*$/gm, '')   // 行尾时间
                .replace(/\n{3,}/g, '\n\n')
                .replace(/\s+$/, '');
        }

        function openEditor(node, messageId) {
            // ★ 全清：id 重复时 getElementById 只拿到第一个，其余会残留在页面上
            for (const el of Array.from(document.querySelectorAll('#' + MODAL_ID))) el.remove();
            const modal = document.createElement('div');
            modal.id = MODAL_ID;
            modal.innerHTML = '<div class="ue-box">'
                + '<div class="ue-title">编辑你发出的消息</div>'
                + '<button class="ue-x" data-act="cancel" aria-label="关闭">\u2715</button>'
                + '<textarea></textarea>'
                + '<div class="ue-row">'
                + '<span class="ue-hint">保存后这个会话只认新版本（旧副本被遮蔽，不删历史）</span>'
                + '<button data-act="cancel">取消</button><button class="ue-save" data-act="save">保存</button>'
                + '</div></div>';
            const ta = modal.querySelector('textarea');
            ta.value = textOf(node);
            const close = () => modal.remove();
            modal.addEventListener('click', async (e) => {
                const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
                if (e.target === modal || act === 'cancel') return close();
                if (act !== 'save') return;
                const sid = sessionId || currentSessionId();
                if (!sid) {
                    console.log('[user-edit] 取不到 sessionId（uiWorkspace.mainReference 为空？）');
                    return alert('取不到当前会话 id —— 控制台跑 __userEditProbe() 看看 uiWorkspace.mainReference。');
                }
                try {
                    const r = await fetch(HOST + '/edit-user', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ sessionId: sid, messageId: messageId, text: ta.value }),
                    });
                    const j = await r.json();
                    if (!j.ok) { alert('改失败：' + (j.error && j.error.code) + '\n' + (j.error && j.error.message)); return; }
                    close();
                    log('已提交 id=' + messageId + ' seq=' + j.seq);
                    // ★ 反馈（学 dsh-chat-thinking-editor 的 justEdited）：
                    //   否则"保存后弹窗关掉、界面毫无变化"，用户不知道成没成。
                    //   （界面文本本身不会变 —— 那由官方 transcript 决定，见文件头注释）
                    try {
                        const b = node.querySelector('[' + BTN_ATTR + ']');
                        if (b) {
                            b.setAttribute('data-edited', '');
                            b.setAttribute('title', '已编辑');
                            b.setAttribute('aria-label', '已编辑');
                            setTimeout(() => {
                                b.removeAttribute('data-edited');
                                b.setAttribute('title', '编辑这条消息');
                                b.setAttribute('aria-label', '编辑这条消息');
                            }, 2500);
                        }
                    } catch (e) { /* ignore */ }
                } catch (err) {
                    alert('请求失败：' + (err && err.message) + '\n（host 的 /edit-user 路由没挂上？看 host 日志里有没有 [chat-user-edit] 已挂在 webServer 上）');
                }
            });
            modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
            document.body.appendChild(modal);
            ta.focus();
        }

        /** 铅笔图标（Material "edit" 的 path，24×24 viewBox，跟官方图标同规格）。 */
        const PENCIL_D = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';

        /**
         * 造一个 ✎ —— **克隆官方那个「复制」按钮**，只把图标 path 换掉。
         *
         * ★ 为什么不自己 createElement：2026-10-16 使用者指出"不够原生" ——
         *   官方的按钮带一整套类名（尺寸、内边距、hover 底色、**黑底 tooltip**），
         *   自己拼一个 <button> 只能得到"一个能点的字符"。克隆则连 tooltip 机制一起继承。
         *   ⇒ 图标风格/大小/间距/hover 反馈全部与官方一致，只有画的图形不同。
         */
        function makeEditButtonLike(copy, onClick) {
            const btn = copy.cloneNode(true);
            btn.setAttribute(BTN_ATTR, '');
            btn.removeAttribute('data-useredit-float');
            // ★ 2026-10-16：**不要设 title** —— 原生 title 会画出「白底黑框」的系统提示，
            //   而官方那个「复制」用的是自己的 tooltip 组件（黑底白字气泡）。设了 title 反倒更不原生。
            //   官方按钮只有 aria-label，克隆它时一并改掉即可（tooltip 文案多半取自 aria-label）。
            btn.removeAttribute('title');
            btn.setAttribute('aria-label', '编辑这条消息');
            // 换图标：优先改 SVG 的 path，拿不到就退化成字符
            const svg = btn.querySelector('svg');
            // ★ 2026-10-16 修「铅笔被截断」：克隆来的 svg 用的是官方"复制"图标的坐标系
            //   （多半不是 24×24），而我塞进去的是 Material 24×24 的 path ⇒ 超出 viewBox 就被裁。
            //   ⇒ 换 path 的同时必须把 viewBox 也改成同一坐标系。宽高交给官方样式（它会自适应）。
            if (svg) {
                svg.setAttribute('viewBox', '0 0 24 24');
                for (const extra of Array.from(svg.querySelectorAll('path, circle, rect, line, polyline, polygon'))) extra.remove();
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', PENCIL_D);
                path.setAttribute('fill', 'currentColor');
                svg.appendChild(path);
            } else {
                btn.textContent = '\u270E';
            }
            btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
            return btn;
        }

        /** 官方操作条里的"复制"按钮（真机上 user 消息也有它，见 2026-10-16 实测的祖先链）。 */
        function findCopyButton(node) {
            return node.querySelector('button[aria-label="复制"]')
                || node.querySelector('button[aria-label="Copy"]')
                || node.querySelector('button[title="复制"]')
                || null;
        }

        /**
         * 给一条 user 消息挂 ✎。返回是否挂上。
         *
         * 2026-10-16 修：官方那个「复制」按钮**只在 hover 时才进 DOM**（静态扫描时查不到），
         * 所以这里改为【hover 时现挂】（见 bindHover），并且：
         *   优先插在「复制」旁边（跟官方一致）；
         *   万一还是找不到，就挂到 conversation.chat.node 的右上角兜底（绝对定位），
         *   免得"什么都不出现"让人以为插件没生效。
         */
        function attach(node) {
            if (node.querySelector('[' + BTN_ATTR + ']')) return true;
            // ★ 2026-10-16 实测改法：新版会话日志的 user/message 里【没有 turn】
            //   （data 直接是 { id, role, content, source }）⇒ 改用消息 id 定位。
            //   id 来源：DOM 的 data-chat-anchor-key，形如 "13:input-message<uuid>"。
            const anchor = node.getAttribute('data-chat-anchor-key') || '';
            const mm = /input-message\s*([0-9a-fA-F-]{8,})/.exec(anchor);
            const messageId = mm ? mm[1] : null;
            if (!messageId) return false;
            const copy = findCopyButton(node);
            if (copy && copy.parentElement) {
                // ★ 原生观感：直接克隆官方按钮，只换图标
                copy.parentElement.insertBefore(makeEditButtonLike(copy, () => openEditor(node, messageId)), copy.nextSibling);
                return true;
            }
            // 兜底：官方按钮还没渲染出来时，自己拼一个贴到消息节点右上角
            const btn = document.createElement('button');
            btn.setAttribute(BTN_ATTR, '');
            btn.setAttribute('aria-label', '编辑这条消息');
            btn.textContent = '\u270E';
            btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openEditor(node, messageId); });
            const host = node.querySelector('[data-slot="conversation.chat.node"]') || node;
            const box = host.firstElementChild || host;
            try {
                if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
                btn.setAttribute('data-useredit-float', '');
                box.appendChild(btn);
                return true;
            } catch (e) { return false; }
        }

        function scan() {
            const nodes = document.querySelectorAll(USER_SEL);
            let n = 0;
            nodes.forEach((el) => { if (attach(el)) n++; });
            return n;
        }

        /**
         * hover 委托：官方操作条是 hover 才渲染的，所以【指针进入某条 user 消息时现挂】。
         * 只监听 pointerover（冒泡），不做每帧轮询。
         */
        function bindHover() {
            document.addEventListener('pointerover', (e) => {
                try {
                    const t = e.target;
                    if (!t || typeof t.closest !== 'function') return;
                    if (t.closest('[' + BTN_ATTR + ']')) return;          // 已经在本插件按钮上
                    const node = t.closest('[data-chat-flow-kind="user"]');
                    if (node) attach(node);
                } catch (err) { /* ignore */ }
            }, true);
        }

        function apply(ctx) {
            injectCss();
            const start = () => {
                const n = scan();
                log('扫描到 ' + n + ' 条 user 消息');
                const flow = document.querySelector('[data-slot="conversation.chat.flow"]');
                if (flow && typeof MutationObserver === 'function') {
                    const mo = new MutationObserver(() => { try { scan(); } catch (e) { /* ignore */ } });
                    mo.observe(flow, { childList: true, subtree: true });
                }
            };
            bindHover();
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
            else start();

            // ★ 2026-10-16 撤回：原先往 conversation.chat.node 注册一个返回 null 的组件来读
            //   props.sessionId —— 但官方 README 说 .node 是「节点注册」（Assistant 节点注册），
            //   很可能不是普通 Entry；页面出现过每 ~20s 一次的渲染进程崩溃（host 日志里
            //   runtime-log detached/attached 成对出现、host 侧零报错），首要嫌疑就是这段。
            //   ⇒ 先完全【不注册任何 slot】，把 ctx 暴露出来探测 sessionId 的合法来源。
            liveCtx = ctx;
            sessionId = currentSessionId();
            log(sessionId ? ('当前会话 = ' + sessionId) : '⚠️ 取不到当前会话（mainReference 为空）');
            window.__userEditCtx = ctx;
            window.__userEdit = {
                scan: scan,
                attach: attach,
                openEditor: openEditor,
                session: () => sessionId,
                setSession: (id) => { sessionId = id; log('手动设定 sessionId =', id); },
                currentSessionId: currentSessionId,
            };

            // 探测：把可能的 sessionId 来源都列出来（重启后在控制台跑 __userEditProbe()）
            window.__userEditProbe = () => {
                const out = { note: '看哪个来源能给出 24 位左右的会话 id' };
                try {
                    const ws = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
                    out.uiWorkspace = ws
                        ? { keys: Object.keys(ws).slice(0, 40), hasActive: typeof ws.activeSession === 'function' }
                        : null;
                } catch (e) { out.uiWorkspace = '查不到: ' + (e && e.message); }
                try {
                    const sess = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null;
                    out.sessions = sess ? Object.keys(sess).slice(0, 30) : null;
                } catch (e) { out.sessions = '查不到: ' + (e && e.message); }
                try {
                    out.ctxServices = ctx && typeof ctx.get === 'function'
                        ? ['uiWorkspace', 'sessions', 'connection', 'clientConnection'].map((k) => {
                            try { return k + '=' + (ctx.get(k) ? '有' : '无'); } catch { return k + '=抛错'; }
                        })
                        : 'ctx.get 不可用';
                } catch (e) { out.ctxServices = String(e && e.message); }
                console.log('[user-edit 探测]', out);
                return out;
            };

            log('已就绪（本版【不注册任何 slot】；sessionId 待定，先跑 __userEditProbe()）');
        }

        exports.apply = apply;
        exports.inject = [];
        return module.exports;
    },
});
