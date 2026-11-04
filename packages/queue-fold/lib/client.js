// dsh-plugin-queue-fold -- client 侧
//
// 给排队消息条（QueueDock）加三态：正常 / 展开全文 / 收起。
//
// 官方行为（读 dsh-client-ui-conversation 源码得知）：
//   · DOM: <div data-queue-dock=""><div class="…_panel">
//            <button class="…_header" aria-expanded>…</button>   ← 仅 rowCount>1
//            <div class="…_list">…每条一行…</div></div></div>
//   · 队列空 → 整个组件 return null（不渲染）
//   · 1 条  → 直接显示，无 header
//   · 多条  → 默认折叠成 header（点它切换）—— 官方已有「折成一行」的能力
//   · 每条消息的文本：class="…_preview" 是 white-space:nowrap + ellipsis ⇒ 只显示一行
//   · 列表 class="…_list" 是 max-height:180px + overflow-y:auto ⇒ 条数多了要滚
//
// 所以官方的「收起」只是折成一行 header（仍占位），而「展开」也看不到完整文字。
// 本插件补两件事：
//   ① 展开：preview 换行显示全文 + list 不限高（看全自己排了什么）
//   ② 收起：整个 dock 隐藏，只留一个极小浮标（点它恢复）
//
// 锚点用官方给的稳定属性 data-queue-dock；截断的类名用后缀匹配
// （hash 前缀会随构建变，`_preview` / `_list` 后缀不会）。
//
// ⚠️ 拖动排序做不到：QueueAction 只有 edit/remove/steer，客户端也没有入队 API。
//    调整执行优先级请用官方 steer（每行的「插话发送」/ 空输入框 Ctrl+Enter）。

window.__ModuleLoader__.load({
    id: 'dsh-plugin-queue-fold',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        const NS = 'qfold';
        const CSS_TAG_ID = 'dsh-plugin-queue-fold/client.css';
        const STATE_KEY = 'dsh-plugin-queue-fold:state';
        const BAR_ATTR = 'data-queue-dock';
        const BTN_ATTR = 'data-qfold-btn';
        const TIP_ATTR = 'data-qfold-tip';
        const TAB_ATTR = 'data-qfold-tab';

        const MODES = ['normal', 'expanded', 'collapsed'];

        const CSS = [
            // ── 展开态：每条显示全文 + 列表不限高 ──
            // 官方 ._7yHdaG_preview 是 nowrap+ellipsis，这里放开换行
            'html.' + NS + '-expanded [' + BAR_ATTR + '] [class*="_preview"]{',
            'white-space:normal;overflow:visible;text-overflow:clip;word-break:break-word}',
            // 官方 ._7yHdaG_list 是 max-height:180px + auto，这里放开
            'html.' + NS + '-expanded [' + BAR_ATTR + '] [class*="_list"]{',
            'max-height:none;overflow-y:visible}',
            // 行高随内容走
            'html.' + NS + '-expanded [' + BAR_ATTR + '] [class*="_row"]{',
            'align-items:flex-start;min-height:36px;height:auto;padding-top:8px;padding-bottom:8px}',

            // ── 收起态：整条隐藏（选择器够具体，无需 !important）──
            'html.' + NS + '-collapsed body [' + BAR_ATTR + ']{display:none}',

            // ── 收起后的小浮标 ──
            'body > [' + TAB_ATTR + ']{',
            'display:none;align-items:center;gap:6px;',
            'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:1080;',
            'padding:2px 10px;background:var(--dsw-alias-bg-base);',
            'border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;',
            'cursor:pointer;font:inherit;font-size:12px;line-height:18px;',
            'color:var(--dsw-alias-label-tertiary);',
            'box-shadow:var(--dsw-elevation-prominent,0 2px 8px rgba(0,0,0,.12))}',
            'html.' + NS + '-collapsed body > [' + TAB_ATTR + ']{display:inline-flex}',
            'body > [' + TAB_ATTR + ']:hover{color:var(--dsw-alias-label-primary)}',

            // ── 我插进 header 的两个按钮（照抄官方 ._7yHdaG_action 的尺寸/圆形）──
            '[' + BTN_ATTR + ']{',
            'box-sizing:border-box;corner-shape:round;',
            'width:28px;height:28px;padding:0;flex:none;',
            'color:var(--dsw-alias-label-tertiary);cursor:pointer;',
            'background:0 0;border:none;border-radius:999px;',
            'justify-content:center;align-items:center;display:inline-flex;',
            'font-size:11px;line-height:1}',
            '[' + BTN_ATTR + ']:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '[' + BTN_ATTR + ']:focus-visible{',
            'outline:var(--dsw-focus-ring-width) solid ' +
                'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
            'outline-offset:-2px}',

            // ── 悬浮提示（照抄官方 primitives 的 .bubble）──
            '[' + TIP_ATTR + ']{',
            'display:none;align-items:center;gap:8px;position:fixed;z-index:1200;',
            'width:max-content;max-width:50vw;padding:3px 7px;',
            'border-radius:var(--dsw-radius-sm);',
            'background:var(--dsw-alias-tooltip-bg,var(--dsw-static-neutral-bluish-850,#333));',
            'color:var(--dsw-static-neutral-bluish-00,#fff);',
            'font-size:13px;line-height:20px;white-space:pre-line;',
            'overflow-wrap:break-word;pointer-events:none}',
        ].join('');

        /** 照抄官方的注入方式：靠 data-plugin-css 去重。 */
        function injectCss() {
            if (typeof document === 'undefined') return;
            const sel = 'style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']';
            if (document.querySelector(sel) !== null) return;
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-plugin-queue-fold';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        // ── 模式状态 ──
        const listeners = new Set();
        let mode = 'normal';

        function readMode() {
            try {
                const v = localStorage.getItem(STATE_KEY);
                return MODES.indexOf(v) >= 0 ? v : 'normal';
            } catch (e) { return 'normal'; }
        }

        function setMode(next, persist) {
            if (MODES.indexOf(next) < 0) return;
            mode = next;
            if (persist !== false) {
                try { localStorage.setItem(STATE_KEY, next); } catch (e) { /* ignore */ }
            }
            const root = document.documentElement;
            for (const m of MODES) root.classList.remove(NS + '-' + m);
            root.classList.add(NS + '-' + next);
            for (const fn of listeners) {
                try { fn(next); } catch (e) { /* ignore */ }
            }
        }

        function subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        }

        // ── 图标 ──
        const CHEV = { normal: '⌄', expanded: '⌃', collapsed: '⌄' };
        const ICON_COLLAPSE =
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
            '<path d="M3.5 8h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

        /** 队列里有几条（用于浮标文案）。 */
        function queueCount() {
            const bar = document.querySelector('[' + BAR_ATTR + ']');
            if (!bar) return 0;
            const list = bar.querySelector('[class*="_list"]');
            if (list) return list.children.length;
            // 折叠态下 list 可能不在 DOM 里，退而数 header 的 aria-controls 目标
            return 1;
        }

        function syncButtons() {
            const t = document.querySelector('[' + BTN_ATTR + '="toggle"]');
            if (t) {
                t.textContent = CHEV[mode] || '⌄';
                const label = mode === 'expanded' ? '缩略排队消息' : '展开排队消息全文';
                t._qfoldLabel = label;
                t.setAttribute('aria-label', label);
                t.setAttribute('aria-expanded', mode === 'expanded' ? 'true' : 'false');
            }
            const tab = document.querySelector('body > [' + TAB_ATTR + ']');
            if (tab) {
                const n = queueCount();
                tab.textContent = '⇥ ' + (n > 0 ? n + ' 条排队已收起' : '排队消息已收起');
            }
        }

        // ── tooltip（照官方 .bubble 样式，500ms 延迟） ──
        const TIP_DELAY = 500;
        let tipEl = null;
        let tipTimer = null;

        function ensureTipEl() {
            if (tipEl && tipEl.isConnected) return tipEl;
            tipEl = document.createElement('div');
            tipEl.setAttribute(TIP_ATTR, '1');
            document.body.appendChild(tipEl);
            return tipEl;
        }

        function placeTip(target) {
            const el = ensureTipEl();
            const r = target.getBoundingClientRect();
            el.style.left = '0px';
            el.style.top = '0px';
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const M = 6;
            let left = r.left + r.width / 2 - w / 2;
            if (left < M) left = M;
            if (left + w > window.innerWidth - M) left = window.innerWidth - w - M;
            let top = r.bottom + 6;
            if (top + h > window.innerHeight - M) top = r.top - h - 6;
            if (top < M) top = M;
            el.style.left = Math.round(left) + 'px';
            el.style.top = Math.round(top) + 'px';
        }

        function showTip(target, label) {
            hideTip();
            if (!label) return;
            tipTimer = setTimeout(() => {
                tipTimer = null;
                const el = ensureTipEl();
                el.textContent = label;
                el.style.display = 'inline-flex';
                placeTip(target);
            }, TIP_DELAY);
        }

        function hideTip() {
            if (tipTimer !== null) { clearTimeout(tipTimer); tipTimer = null; }
            if (tipEl) tipEl.style.display = 'none';
        }

        function attachTip(btn, getLabel) {
            btn.addEventListener('mouseenter', () => showTip(btn, getLabel()));
            btn.addEventListener('mouseleave', hideTip);
            btn.addEventListener('focus', () => showTip(btn, getLabel()));
            btn.addEventListener('blur', hideTip);
            btn.addEventListener('click', hideTip);
        }

        /** 往 QueueDock 的 header 里插两个按钮。 */
        function decorate(bar) {
            if (!bar) return;
            if (bar.querySelector('[' + BTN_ATTR + ']')) return;

            // 官方在 rowCount>1 时才渲染 header；只有 1 条时没有 header，
            // 那种情况把按钮挂到 panel 上（或 row 上）作为退路。
            const panel = bar.querySelector('[class*="_panel"]') || bar;
            const header = panel.querySelector('[class*="_header"]');
            const host = header || panel.querySelector('[class*="_row"]') || panel;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.setAttribute(BTN_ATTR, 'toggle');
            toggle.addEventListener('click', (e) => {
                // 别触发官方 header 的折叠切换
                e.preventDefault();
                e.stopPropagation();
                setMode(mode === 'expanded' ? 'normal' : 'expanded');
            });
            attachTip(toggle, () => toggle._qfoldLabel || '展开排队消息全文');
            host.appendChild(toggle);

            const collapse = document.createElement('button');
            collapse.type = 'button';
            collapse.setAttribute(BTN_ATTR, 'collapse');
            collapse.innerHTML = ICON_COLLAPSE;
            collapse.setAttribute('aria-label', '收起排队消息条');
            collapse.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                setMode('collapsed');
            });
            attachTip(collapse, () => '收起排队消息条');
            host.appendChild(collapse);

            syncButtons();
        }

        /** 收起态下的小浮标（常驻，靠 CSS 控制显隐）。 */
        function ensureTab() {
            if (document.querySelector('body > [' + TAB_ATTR + ']')) return;
            const b = document.createElement('button');
            b.type = 'button';
            b.setAttribute(TAB_ATTR, '1');
            b.addEventListener('click', (e) => {
                e.preventDefault();
                setMode('normal');
            });
            document.body.appendChild(b);
        }

        function scan() {
            for (const bar of document.querySelectorAll('[' + BAR_ATTR + ']')) decorate(bar);
            ensureTab();
            syncButtons();
        }

        function apply(ctx) {
            console.log('[queue-fold] client apply()');
            injectCss();

            const start = () => {
                setMode(readMode(), false);
                scan();

                let queued = false;
                const mo = new MutationObserver(() => {
                    if (queued) return;
                    queued = true;
                    const run = () => { queued = false; scan(); };
                    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
                    else setTimeout(run, 50);
                });
                mo.observe(document.body, { childList: true, subtree: true });

                subscribe(() => syncButtons());
                console.log('[queue-fold] 就绪，模式: ' + mode);
            };

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', start);
            } else {
                start();
            }
        }

        exports.apply = apply;
        exports.inject = [];
        return module.exports;
    },
});
