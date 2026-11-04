// dsh-plugin-goal-fold -- client 侧
//
// 给会话目标条（GoalBar）加可选的显示模式：正常 / 展开全文 / 收起。
//
// 官方行为（读 dsh-client-ui-goal 源码得知）：
//   · GoalBar 注册在 conversation.input.dock，id='goal'
//   · DOM: <div data-goal-bar><div class="…_bar">
//            <span glyph/><span label/><span objective/><div class="…_actions"/></div></div>
//   · objective 的 CSS 是 nowrap + ellipsis —— 单行截断，官方既无展开也无收起。
//
// 本插件做三件事：
//   ① 往 actions 区插一个按钮；点击弹出【菜单】让用户自己选模式（不是盲点循环）
//   ② 以 <html> 上的 class 为开关，用注入的 CSS 实现两种附加模式
//   ③ 收起后，在【顶栏动作区】（conversation.session.header.actions slot）放一个恢复入口
//
// 展开态限高 + 内部滚动：composer 区固定在窗口底部，目标条变高会向上顶住消息，
// 这是 DSH 的布局架构，插件不该改；限高是唯一不越界的做法。
//
// 选择器只用 [data-goal-bar] 这个稳定属性，不依赖会变的 hash 类名；
// 不使用 !important。

window.__ModuleLoader__.load({
    id: 'dsh-plugin-goal-fold',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        // 只用到 react（侧边栏入口那个组件）；按钮是原生 DOM，不需要 react-dom
        let react = require('react');

        const NS = 'goalfold';
        const CSS_TAG_ID = 'dsh-plugin-goal-fold/client.css';
        const STATE_KEY = 'dsh-plugin-goal-fold:state';
        const BTN_ATTR = 'data-goalfold-btn';
        const TIP_ATTR = 'data-goalfold-tip';

        const MODES = ['normal', 'expanded', 'collapsed'];

        const CSS = [
            // ── 展开态：底边钉住，向上撑满 ──
            //
            // DOM 事实（读 dsh-client-ui-conversation 源码确认）：
            //   .wSkVaW_scrollBody            overflow-y:auto 的滚动容器
            //   └─ .wSkVaW_composerSeat       flex:none
            //      └─ .wSkVaW_composerStack   flex column, gap 6px
            //         ├─ [data-slot=conversation.input.dock]
            //         │  └─ div[data-goal-bar]        ← 目标条
            //         └─ inputBar                     ← 输入框（目标条的【兄弟】）
            //
            // 锚点就用目标条【自己】—— 它是自己的包含块，不必猜外部层级：
            //   · 目标条保持正常态那一行的高度占位（JS 写 inline height）→ 兄弟输入框不动
            //   · 内部那层 .bar 绝对定位、贴目标条底边（bottom:0）→ 只能向上生长
            //
            // 前几版用 bottom:100% / absolute+bottom:0 / fixed+视口坐标，都是在猜
            // 外部包含块是谁，全部跑偏。这一版锚点是它自己，行为可预测。
            // 高度锁用 CSS 变量，并给一个合理的默认值 ——
            // 这样即使 JS 没能量到高度（比如条还没渲染出来），占位也不会失控。
            // 变量由 JS 写在 :root 上，比 inline height 更不容易被后续重渲染冲掉。
            'html.' + NS + '-expanded [data-goal-bar]{',
            'position:relative;z-index:20;',
            'height:var(--dsh-goalfold-row-height,38px)}',
            'html.' + NS + '-expanded [data-goal-bar] > div{',
            // ★ top:auto 是关键，不能省。
            //   官方 CSS 给 .bar 设了 inset:0（它的 :before 要靠这个铺满背景），
            //   于是 top:0 与 bottom:0 同时存在 → 按 CSS 规则高度被【拉伸】填满
            //   包含块，正好等于 bar 的 36px —— 内容 205px 就被压扁在里面。
            //   实测证据：computed t=0px b=0px l=0px r=0px，scrollH=205 但 h=36。
            //   写 top:auto 解除纵向拉伸，高度才会由内容决定。
            'position:absolute;top:auto;bottom:0;left:0;right:0;',
            // ★ 2026-10-07 修：原为 'height:auto;max-height:none;' —— 与文件头 L16-17
            //   「展开态限高 + 内部滚动」的设计意图矛盾。实际表现：
            //     · 内容长时面板无限向上生长、冲出视口顶部
            //       ⇒ 顶部内容看不到，而且没有滚动条
            //     · 用户为了看内容要滚动页面
            //       ⇒ 目标条连同按钮一起跑出视口 ⇒ 也收不起来
            //   现在按设计意图限高，并让内容在面板内部滚动。
            //   上限取 50vh：composer 固定在窗口底部，留一半视口给消息区；
            //   面板到 50vh 就不再长，按钮始终留在可见范围内。
            //   overscroll-behavior:contain 防止滚到底后滚动穿透到页面。
            'height:auto;max-height:50vh;overflow-y:auto;overscroll-behavior:contain;',
            'background:var(--dsw-alias-bg-base);',
            'border:.5px solid var(--dsw-alias-border-l2);',
            'border-radius:var(--dsw-radius-md,8px);',
            'box-shadow:var(--dsw-elevation-prominent,0 4px 16px rgba(0,0,0,.16));',
            'padding:10px 12px;box-sizing:border-box;',
            'align-items:flex-start;flex-wrap:wrap}',
            'html.' + NS + '-expanded [data-goal-bar] > div > span:nth-of-type(3){',
            'white-space:normal;overflow:visible;text-overflow:clip;word-break:break-word;',
            'line-height:1.5}',
            'html.' + NS + '-expanded [data-goal-bar] > div > div{flex:none}',

            // ── 收起态：整条隐藏（选择器比官方 .nLMEza_dock 更具体，无需 !important）──
            'html.' + NS + '-collapsed body [data-goal-bar]{display:none}',

            // ── GoalBar 上的两个按钮 ──
            // 逐条照抄官方 GoalBar 的 .iconBtn：
            //   corner-shape:round · 28×28 · border-radius:999px（圆形）
            //   color:label-tertiary · background:0 0 · border:none · inline-flex 居中
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

            // ── 悬浮提示（自绘，替代浏览器原生 title）──
            // 逐条照抄官方 primitives 的 .bubble：
            //   fixed · z-index · width:max-content · max-width:50vw · padding:3px 7px
            //   background:--dsw-alias-tooltip-bg（= bluish-850 深色）· 白字 · 13px/20px
            //   pointer-events:none（不挡鼠标）
            '[' + TIP_ATTR + ']{',
            'display:none;align-items:center;gap:8px;position:fixed;z-index:1200;',
            'width:max-content;max-width:50vw;padding:3px 7px;',
            'border-radius:var(--dsw-radius-sm);',
            'background:var(--dsw-alias-tooltip-bg,var(--dsw-static-neutral-bluish-850,#333));',
            'color:var(--dsw-static-neutral-bluish-00,#fff);',
            'font-size:13px;line-height:20px;white-space:pre-line;',
            'overflow-wrap:break-word;pointer-events:none}',

            // ── 侧边栏底部的恢复入口 ──
            // ★ 2026-10-14：入口从侧边栏底部挪到【顶栏】，尺寸也要跟着换。
            //   原来逐条照抄的是官方【侧边栏行】的 .hHd-Xa_panelRow（min-height:36px / padding:7px 8px），
            //   那套放顶栏明显偏大（截图对比过）。现在改为照抄官方顶栏按钮 ——
            //   ui-primitives 的 Button：.button 基类 + .sm 紧凑尺寸 + .toolbar 语义背景。
            //   同样只换类名不换数值，也不依赖会变的 hash 类名。
            '.' + NS + '_side{',
            'box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;',
            'border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;',
            'font-size:12px;line-height:18px;height:28px;padding:0 10px;',
            // ★ 用 ghost 变体（透明背景、hover 才显色）—— 官方顶栏的「PTC 模式」就是这个观感；
            //   先前选的 .toolbar 变体带 background:--dsw-alias-button-tool-bar-fill，
            //   在本主题下是深灰块，放在顶栏像被选中（2026-10-14 截图对比后改）。
            // ★ 颜色用 tertiary（次要灰）而非 primary —— 顶栏那些官方件（「PTC 模式」等）
            //   都是 tertiary，用 primary 会明显比它们深（2026-10-14 截图对比后改）。
            'color:var(--dsw-alias-label-tertiary);background:0 0}',
            '.' + NS + '_side:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
            '.' + NS + '_side:focus-visible{',
            'outline:var(--dsw-focus-ring-width) solid ' +
                'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
            'outline-offset:-2px}',
            '.' + NS + '_side[data-hidden="1"]{display:none}',
            '.' + NS + '_sideGlyph{flex:none;justify-content:center;align-items:center;display:inline-flex}',
            '.' + NS + '_sideTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
        ].join('');

        /** 照抄官方的注入方式：靠 data-plugin-css 去重。 */
        function injectCss() {
            if (typeof document === 'undefined') return;
            const sel = 'style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']';
            if (document.querySelector(sel) !== null) return;
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-plugin-goal-fold';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        // ── 模式状态 ──
        //
        // ★ listeners 必须挂在 window 上，【不能】是模块级 Set：
        //   插件会被加载多份（HMR / 强刷，Console 里见过三份 client apply()），
        //   而每个模块实例各有一个 Set ⇒ 「调用 setMode 的实例」通知不到
        //   「渲染入口的实例」⇒ 收起后 class 变了、入口却收不到通知。
        //
        //   实测证据（2026-10-14）：收起态下 class=goalfold-collapsed，
        //   但入口元素 data-hidden=1（应为 0）—— 元素在、插槽在，只有状态是旧的。
        //
        //   ⚠️ 这是本机插件第三次栽在「模块级状态 + 多实例」上：
        //   chat-zoom 的监听器累积 · session-cleaner 的 Ctrl 状态读不到 · 这里。
        const G = window.__goalfoldState || (window.__goalfoldState = { listeners: new Set() });
        const listeners = G.listeners;
        let mode = 'normal';

        function readMode() {
            try {
                const v = localStorage.getItem(STATE_KEY);
                return MODES.indexOf(v) >= 0 ? v : 'normal';
            } catch (e) { return 'normal'; }
        }

        /**
         * 展开态的占位高度。
         *
         * 锚点就是目标条【自己】：展开时把它的高度锁在正常态那一行，
         * 于是它在 flex column 里占的地方不变 → 兄弟输入框纹丝不动；
         * 而它内部那层 .bar 是 absolute + bottom:0，贴着自己的底边向上撑开
         * （CSS 见 html.goalfold-expanded [data-goal-bar] > div）。
         *
         * 高度走 CSS 变量 --dsh-goalfold-row-height（写在 :root 上），
         * CSS 侧自带 38px 默认值 —— 即使 JS 没量到也不会失控。
         * 用变量而不是 inline height，是因为 React 重渲染会重建元素、
         * 抹掉 inline 样式；变量挂在 <html> 上则与元素生命周期无关。
         *
         * 不再猜任何外部包含块 —— 前几版就是这么跑偏的。
         */
        let lockedHeight = null;

        /** 目标条在正常布局下的高度。必须在它还处于正常态时调用。 */
        function measureBarHeight() {
            const bar = document.querySelector('[data-goal-bar]');
            if (!bar) return null;
            const h = bar.getBoundingClientRect().height;
            // 收起态下它是 display:none，量到 0 —— 那种情况交给 CSS 默认值
            return h > 0 ? Math.round(h) : null;
        }

        /** 写入高度变量（占位不变）。 */
        function applyHeightLock() {
            if (lockedHeight === null) return;
            document.documentElement.style.setProperty('--dsh-goalfold-row-height', lockedHeight + 'px');
        }

        /** 清掉高度变量。 */
        function clearHeightLock() {
            document.documentElement.style.removeProperty('--dsh-goalfold-row-height');
            const bar = document.querySelector('[data-goal-bar]');
            if (bar) bar.style.height = '';
        }

        /** 临时回到正常态量一次高度，再戴回展开态。 */
        function remeasureHeightLock() {
            const root = document.documentElement;
            const had = root.classList.contains(NS + '-expanded');
            if (had) root.classList.remove(NS + '-expanded');
            const saved = lockedHeight;
            lockedHeight = null;
            clearHeightLock();
            const h = measureBarHeight();
            lockedHeight = (h !== null) ? h : saved;
            if (had) root.classList.add(NS + '-expanded');
            applyHeightLock();
        }

        function setMode(next, persist) {
            if (MODES.indexOf(next) < 0) return;
            const wasExpanded = mode === 'expanded';

            // 进展开态前先在正常布局下量高度；离开时解除锁
            if (next === 'expanded' && !wasExpanded) lockedHeight = measureBarHeight();
            if (next !== 'expanded' && wasExpanded) { clearHeightLock(); lockedHeight = null; }

            mode = next;
            if (persist !== false) {
                try { localStorage.setItem(STATE_KEY, next); } catch (e) { /* ignore */ }
            }
            const root = document.documentElement;
            for (const m of MODES) root.classList.remove(NS + '-' + m);
            root.classList.add(NS + '-' + next);

            if (next === 'expanded') applyHeightLock();
            for (const fn of listeners) {
                try { fn(next); } catch (e) { /* ignore */ }
            }
        }

        function subscribe(fn) {
            listeners.add(fn);
            // ★ 必须返回【函数】。原写法 `() => listeners.delete(fn)` 返回的是 delete 的布尔结果，
            //   而 useEffect 的清理函数只能是函数 ⇒ React 报错 ⇒ 组件直接挂掉 ⇒
            //   表现就是「目标条」和「目标已收起」入口【一起消失】（2026-10-14 用户实测）。
            return () => { listeners.delete(fn); };
        }

        /** 侧边栏底部的恢复入口：仅在收起态可见。结构对齐官方 panelRow（glyph + title）。 */
        function SidebarEntry() {
            // ★ 不再依赖「订阅 + 模块状态」来同步显隐 —— 那条路实测不可靠：
            //   插件被加载多份，改状态的实例与渲染的实例可能不是同一个，
            //   结果 class=goalfold-collapsed 而入口 data-hidden=1（查了整整一轮才定位）。
            //
            //   现在改成读【唯一的权威来源】：<html> 上的 class（setMode 一定会改它，
            //   而且 Console 实测它一直是对的）。
            //   监听 class 变化即时重渲染；外加 500ms 轮询兜底（防观察器失效）。
            const [, forceRender] = react.useState(0);
            react.useEffect(() => {
                const bump = () => forceRender((n) => n + 1);
                let mo = null;
                try {
                    mo = new MutationObserver(bump);
                    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
                } catch (e) { /* 观察器不可用时靠轮询 */ }
                const id = setInterval(bump, 500);
                return () => {
                    if (mo) mo.disconnect();
                    clearInterval(id);
                };
            }, []);
            const collapsed = document.documentElement.classList.contains(NS + '-collapsed');
            // ★ 只有【确实有目标条可恢复】时才显示入口。
            //   为什么：mode 是全局的，而目标条是【每个会话各自】的 —— 切到没有 goal 的会话时，
            //   若仍显示入口，点了不会有任何效果，留下一个死按钮（2026-10-14 用户实测）。
            //   这也是 scan() 里那条自愈想解决的问题；用显示条件解决更安全（不动 mode）。
            const hasBar = document.querySelector('[data-goal-bar]') !== null;
            const show = collapsed && hasBar;
            return react.createElement('button', {
                type: 'button',
                className: NS + '_side',
                'data-hidden': show ? '0' : '1',
                'aria-label': '恢复显示会话目标条',
                onClick: () => setMode('normal'),
            },
                react.createElement('span', {
                    className: NS + '_sideGlyph',
                    'aria-hidden': true,
                    dangerouslySetInnerHTML: { __html: GLYPH_GOAL },
                }),
                react.createElement('span', { className: NS + '_sideTitle' }, '目标已收起')
            );
        }

        // ── 图标 ──
        // 展开/缩略共用一个钮（chevron 方向表示当前可做的动作）
        const CHEV = { normal: '⌄', expanded: '⌃', collapsed: '⌄' };
        // 收起：最小化语义（一条横线），与「删除」区分开 —— goal 还在，只是不显示
        const ICON_COLLAPSE =
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
            '<path d="M3.5 8h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
        // 侧边栏入口的目标图标（同心圆，和 GoalBar 上的语义一致）
        const GLYPH_GOAL =
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
            '<circle cx="8" cy="8" r="5.4" stroke="currentColor" stroke-width="1.3"/>' +
            '<circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>';

        /** 同步两个按钮的图标与提示文案（模式变化后调用）。 */
        function syncButtons() {
            const t = document.querySelector('[' + BTN_ATTR + '="toggle"]');
            if (t) {
                t.textContent = CHEV[mode] || '⌄';
                const label = mode === 'expanded' ? '缩略目标条' : '展开完整目标';
                t._gofoldLabel = label;   // 供 tooltip 读取（不用 title，避免原生浮层）
                t.setAttribute('aria-label', label);
                t.setAttribute('aria-expanded', mode === 'expanded' ? 'true' : 'false');
            }
        }

        // ── 自绘 tooltip ──
        // 官方用 primitives 的 Tooltip 组件（client 插件禁止跨包 import），
        // 这里按它的 .bubble 样式自己实现：500ms 延迟、深色圆角、跟随目标定位、下方不够则翻上方。
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

        /** 给按钮挂上 tooltip 行为（不用 title，避免系统默认白框浮层）。 */
        function attachTip(btn, getLabel) {
            btn.addEventListener('mouseenter', () => showTip(btn, getLabel()));
            btn.addEventListener('mouseleave', hideTip);
            btn.addEventListener('focus', () => showTip(btn, getLabel()));
            btn.addEventListener('blur', hideTip);
            // 点击后立刻收起，避免浮层滞留
            btn.addEventListener('click', hideTip);
        }

        function decorate(bar) {
            if (!bar) return;
            // 宿主容器打标记（用于锁定占位高度）
            const host = bar.parentElement;
            if (host && !host.hasAttribute('data-goalfold-host')) {
                host.setAttribute('data-goalfold-host', '1');
            }

            // 边界：刷新后若恢复的就是展开态，此刻目标条还没有高度锁，
            // 临时摘掉 expanded 回到正常布局量一次，再戴回去。
            if (mode === 'expanded' && lockedHeight === null) remeasureHeightLock();

            if (bar.querySelector('[' + BTN_ATTR + ']')) return;
            const actions = bar.querySelector('div > div') || bar;

            // ① 展开 / 缩略：同一个按钮来回切
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.setAttribute(BTN_ATTR, 'toggle');
            toggle.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                setMode(mode === 'expanded' ? 'normal' : 'expanded');
            });
            attachTip(toggle, () => toggle._gofoldLabel || '展开完整目标');
            actions.appendChild(toggle);

            // ② 收起：独立按钮
            const collapse = document.createElement('button');
            collapse.type = 'button';
            collapse.setAttribute(BTN_ATTR, 'collapse');
            collapse.innerHTML = ICON_COLLAPSE;
            collapse.setAttribute('aria-label', '收起目标条');
            collapse.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                setMode('collapsed');
            });
            attachTip(collapse, () => '收起目标条');
            actions.appendChild(collapse);

            syncButtons();
        }

        function scan() {
            const bars = document.querySelectorAll('[data-goal-bar]');
            for (const bar of bars) decorate(bar);
            // ★ 自愈（2026-10-14 用户实测）：处于收起态、但目标条已不在 DOM 时，
            //   把模式自动切回 normal。
            //   触发场景：goal 被清除、或切到了没有目标的会话 —— 此时官方 GoalBar 不渲染，
            //   而入口只看 mode ⇒ 会留下一个「点了没反应」的死按钮。
            //   （排查记录：Console 里 [data-goal-bar] 查询结果为空，class 与 CSS 均正常。）
            // ⚠️ 2026-10-14 暂时停用自愈：它的判据（bars.length === 0）在收起态下竟然成立，
            //   于是刚收起就被切回 normal ⇒ 入口一闪即没（用户实测）。
            //   在查清「收起时 [data-goal-bar] 为何为 0」之前，不能启用这条。
            // if (mode === 'collapsed' && bars.length === 0) setMode('normal', false);
            syncButtons();
        }

        function apply(ctx) {
            console.log('[goal-fold] client apply()');
            injectCss();

            let started = false;
            const start = () => {
                if (started) return;
                started = true;
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

                // 窗口尺寸变化 → 重新量锚点，保持底边钉在原位置
                window.addEventListener('resize', () => {
                    if (mode === 'expanded') remeasureHeightLock();
                });

                // 模式变化时同步两个按钮的图标与提示
                subscribe(() => syncButtons());
                console.log('[goal-fold] 就绪，模式: ' + mode);
            };

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', start, { once: true });
            } else {
                start();
            }
            // ★ 保险：某些加载时序下 DOMContentLoaded 可能已经错过（而 readyState 仍报 loading），
            //   此时 start 永远不会跑 —— 表现就是【目标条和入口一起消失，且不报任何错】
            //   （2026-10-14 用户实测）。300ms 后检查一次，没跑过就补跑。
            setTimeout(() => {
                if (!started) {
                    console.log('[goal-fold] DOMContentLoaded 未触发，补跑 start()');
                    start();
                }
            }, 300);

            // 入口：优先挂顶栏动作区（2026-10-14 从 sidebar.footer.action 挪来，
            // 那个位置被 goal-fold + 清理会话 + 会话缩放 三个挤满了）。
            // 插槽名来自 ui-conversation/src/client/contract/slots.ts 的 SlotMap。
            //
            // ★ 为什么要加兜底 —— ctx.slots.inject 是【声明感知】的：它等待插槽声明，
            //   若声明方尚未就绪，回调会一直不触发，而且【不报任何错】。
            //   实测症状（2026-10-14）：Console 里那句「已注册」照打 —— 因为它写在 inject 外面，
            //   只证明「请求了」，不证明回调跑过 —— 而入口根本不出现。
            //   ⇒ ① 日志移进【回调内】，才能真正证明插槽就绪；
            //     ② 5 秒后仍未就绪就退回侧边栏底部 —— 入口宁可换位置，也不能消失。
            let entryRegistered = false;
            const registerEntry = (slotName) => ctx.slots.inject(slotName, () => {
                entryRegistered = true;
                console.log('[goal-fold] ✅ 插槽就绪，入口已注册到 ' + slotName);
                return ctx.slots.register({ name: slotName, id: 'goal-fold' }, SidebarEntry);
            });
            try {
                registerEntry('conversation.session.header.actions');
                console.log('[goal-fold] 已请求注入顶栏插槽（是否就绪看有没有上一句式日志）');
            } catch (e) {
                console.error('[goal-fold] 顶栏 slot 注册请求失败: ' + (e && e.message));
            }
            setTimeout(() => {
                if (entryRegistered) return;
                console.log('[goal-fold] ⚠️ 顶栏插槽 5 秒仍未就绪，入口退回侧边栏底部');
                try { registerEntry('sidebar.footer.action'); }
                catch (e) { console.error('[goal-fold] 兜底注册也失败: ' + (e && e.message)); }
            }, 5000);
        }

        exports.apply = apply;
        exports.inject = ['slots'];
        return module.exports;
    },
});
