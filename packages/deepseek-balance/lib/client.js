// dsh-plugin-balance -- client 侧（A 方案：读投影 + 点击展开 + hover 高亮）
//
// 样式与交互严格对照官方：
//   · pill  : dsh-client-ui-chat 的 bOPqQW_pill 全部规则（含 :hover 与 [aria-expanded=true]）
//   · 弹层  : stat_dialog 的 bRhRbq_panel 规则
//   · 注入  : 照抄官方的 <style data-plugin-css=...> 去重写入方式
//
// 为什么改成注入 CSS 而不是 inline style：
//   inline style 无法表达 :hover 伪类 —— 而官方的"预选中指引"正是 :hover 背景。
//
// 全程不使用 !important。

window.__ModuleLoader__.load({
    id: 'dsh-plugin-balance',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        let react = require('react');
        let reactDom = require('react-dom');

        const NS = 'bal';
        const CSS_TAG_ID = 'dsh-plugin-balance/client.css';
        const TIP_ATTR = 'data-bal-tip';

        // 用量页与充值页（URL 取自 DSH 内部实现：new URL('/xxx', platformOrigin)）
        const USAGE_URL = 'https://platform.deepseek.com/usage';
        const TOP_UP_URL = 'https://platform.deepseek.com/top_up';

        // 样式全部走类名，好让 :hover 生效。
        // 规则值逐条对照官方 bOPqQW_* / bRhRbq_*。
        const CSS = [
            '.' + NS + '_root{',
            'box-sizing:border-box;min-width:0;max-width:100%;',
            'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
            'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
            'justify-content:center;gap:12px;display:flex}',
            '.' + NS + '_anchor{min-width:0;display:inline-flex}',
            '.' + NS + '_pill{',
            'box-sizing:border-box;corner-shape:round;max-width:100%;',
            'color:var(--dsw-alias-label-tertiary);font:inherit;',
            'font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;',
            'background:0 0;border:none;border-radius:999px;',
            'align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
            // ★ 官方的高亮规则：hover 与展开态共用
            '.' + NS + '_pill:hover,button.' + NS + '_pill[aria-expanded="true"]{',
            'background:var(--dsw-alias-interactive-bg-hover);',
            'color:var(--dsw-alias-label-secondary)}',
            // ★ 余额阈值配色：< 5 元标黄（偏低）· < 1 元标红（告急）
            //   特异性说明：上面那条 hover 规则的 button.xxx_pill[aria-expanded] 是 1+10+10=21，
            //   所以这里也必须带 button. 前缀凑到 21，并【放在后面】—— 同权重时后写的赢。
            //   只覆盖 color，hover 的背景色仍然生效。（全程不用 !important）
            // ★ 2026-10-04：两档跳变 → 低于 5 元起【连续渐变】。
            //   --bal-heat=0% ⇒ 纯警告橙（刚跌破 5 元）；=100% ⇒ 纯错误红（余额归零）。
            //   余额 >5 元时不加此 class ⇒ 保持默认灰（正常状态不动，变色本身即信号）。
            //   color-mix 是官方自用特性；颜色全部取自 --dsw-alias-state-*，不引入自定义色值。
            //   ⚠️ 变量名用 --bal-heat 而非 --hw-heat，避免与 hw-monitor 在同页面冲突。
            'button.' + NS + '_pill.' + NS + '_heat{',
            'color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) var(--bal-heat),var(--dsw-alias-state-warning-primary,#d97706))}',
            // 弹层面板（对照 bRhRbq_panel）
            '.' + NS + '_panel{',
            'z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);',
            'background:var(--dsw-specific-menu);width:max-content;',
            'min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));',
            'backdrop-filter:var(--dsw-menu-backdrop-filter);',
            'box-shadow:var(--dsw-elevation-prominent);',
            'color:var(--dsw-alias-label-secondary);cursor:default;border:0;',
            'padding:16px;font-size:12px;line-height:18px;position:fixed}',
            '.' + NS + '_title{',
            'color:var(--dsw-alias-label-primary);justify-content:space-between;',
            'gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
            '.' + NS + '_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
            '.' + NS + '_num{font-variant-numeric:tabular-nums}',
            '.' + NS + '_details{',
            'color:var(--dsw-alias-label-tertiary);',
            'grid-template-columns:minmax(76px,auto) minmax(0,1fr);',
            'gap:6px 16px;margin:0;display:grid}',
            // 底部操作区（分隔线 + 查询用量 + 充值）
            '.' + NS + '_foot{',
            'border-top:.5px solid var(--dsw-alias-border-l2);',
            'margin-top:10px;padding-top:12px;display:flex;',
            'justify-content:flex-end;gap:8px}',
            // 次要按钮（白底描边）—— 对照平台账户卡片的「查询用量」
            '.' + NS + '_btn{',
            'box-sizing:border-box;border-radius:var(--dsw-radius-md,8px);',
            'font:inherit;font-size:12px;line-height:18px;cursor:pointer;',
            'padding:5px 14px;text-decoration:none;display:inline-flex;',
            'align-items:center;gap:4px;white-space:nowrap}',
            '.' + NS + '_btnGhost{',
            'color:var(--dsw-alias-label-primary);',
            'background:var(--dsw-alias-bg-layer-1);',
            'border:.5px solid var(--dsw-alias-border-l2)}',
            '.' + NS + '_btnGhost:hover{',
            'background:var(--dsw-alias-interactive-bg-hover)}',
            // 主要按钮（黑色实心）—— 对照平台账户卡片的「充值」
            '.' + NS + '_btnPrimary{',
            'color:var(--dsw-alias-bg-layer-1);',
            'background:var(--dsw-alias-label-primary);',
            'border:.5px solid var(--dsw-alias-label-primary)}',
            '.' + NS + '_btnPrimary:hover{opacity:.88}',
            // 平台页容器：自己画壳（顶部返回栏 + 下方留给原生 WebContentsView 的空白区）
            // ★ top 让开 Windows 自绘标题栏/菜单栏 —— DSH 用的是同一个变量
            //   （见 dsh-client-ui-layout：padding-top: var(--dsh-windows-titlebar-height)）
            '.' + NS + '_overlay{',
            'position:fixed;left:0;right:0;bottom:0;z-index:1200;',
            'top:var(--dsh-windows-titlebar-height,0px);',
            'display:flex;flex-direction:column;',
            'background:var(--dsw-alias-bg-layer-1)}',
            '.' + NS + '_bar{',
            'flex:none;display:flex;align-items:center;gap:8px;',
            'height:40px;padding:0 12px;',
            'border-bottom:.5px solid var(--dsw-alias-border-l2);',
            'background:var(--dsw-alias-bg-layer-1)}',
            '.' + NS + '_back{',
            'display:inline-flex;align-items:center;gap:6px;',
            'background:0 0;border:none;cursor:pointer;font:inherit;font-size:13px;',
            'color:var(--dsw-alias-label-secondary);',
            'border-radius:var(--dsw-radius-sm);padding:4px 10px}',
            '.' + NS + '_back:hover{',
            'background:var(--dsw-alias-interactive-bg-hover);',
            'color:var(--dsw-alias-label-primary)}',
            // 给原生视图留的位置；视图浮在它上面，所以自身保持空白
            '.' + NS + '_host{flex:1;min-height:0}',

            // ── 悬浮提示（自绘，替代浏览器原生 title）──
            // 逐条照抄官方 primitives 的 .bubble：
            //   fixed · width:max-content · max-width:50vw · padding:3px 7px
            //   background:--dsw-alias-tooltip-bg（bluish-850 深色）· 白字 · 13px/20px
            //   pointer-events:none（不挡鼠标）
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
            tag.dataset.plugin = 'dsh-plugin-balance';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        function pad2(n) { return n < 10 ? '0' + n : '' + n; }
        function fmtTime(ms) {
            if (!ms) return '—';
            const d = new Date(ms);
            return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
        }

        // ── 自绘 tooltip ──
        // 官方用 primitives 的 Tooltip 组件（client 插件禁止跨包 import），
        // 这里按它的 .bubble 样式自己实现：500ms 延迟、深色圆角、居中跟随、下方不够翻上方。
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

        /** 触发一次 tooltip 定位刷新（余额数字变化时用）。 */
        function tipLabel(target) {
            return target ? (target._baltipLabel || '') : '';
        }

        /** 明细一行：<dt>标签</dt><dd>值</dd> */
        function row(label, value, key) {
            return [
                react.createElement('dt', { key: key + '-t' }, label),
                react.createElement('dd', { key: key + '-d', className: NS + '_num' }, value),
            ];
        }

        // ── 用量格式化 ──
        function fmtTok(n) {
            if (n === null || n === undefined || Number.isNaN(n)) return '—';
            if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
            return String(n);
        }

        function fmtCost(n) {
            if (n === null || n === undefined || Number.isNaN(n)) return '—';
            if (n >= 100) return '约 ¥' + Math.round(n);
            return '约 ¥' + n.toFixed(2);
        }

        // ── 日用量：本地基线做差 ──
        // 官方 Platform 接口只给【累计消费】（total_costs），页面上的按日数据
        // 走的是另一个接口，路径没找到（试过给它加 start_date/date/start_time
        // 等参数，服务端一律忽略）。所以日用量只能在本地每天记一次基线做差。
        // 首次装上那天没有基线，按用户要求显示 "—"，次日开始才是真实值。
        const DAILY_KEY = 'dsh-plugin-balance-mvp:daily:v1';

        /** 本地日期 YYYY-MM-DD（不用 toISOString，那是 UTC）。 */
        function localDate() {
            try {
                return new Date().toLocaleDateString('sv-SE');
            } catch (e) {
                return new Date().toISOString().slice(0, 10);
            }
        }

        /** 读当天基线记录 { date, cost, tokens }。 */
        function readDaily() {
            try {
                const v = JSON.parse(localStorage.getItem(DAILY_KEY) || 'null');
                return v && typeof v === 'object' ? v : null;
            } catch (e) { return null; }
        }

        function writeDaily(v) {
            try { localStorage.setItem(DAILY_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
        }

        /**
         * 计算今日增量。当天第一次调用会建立基线，并标记 fresh。
         * @returns {{ cost: number|null, tokens: number|null, fresh: boolean }}
         */
        function dailyDelta(costNum, tokensNum) {
            const today = localDate();
            let rec = readDaily();
            if (!rec || rec.date !== today) {
                rec = { date: today, cost: costNum, tokens: tokensNum };
                writeDaily(rec);
                return { cost: null, tokens: null, fresh: true };
            }
            // 基线里缺某项时补齐（比如先有余额、后装上 token 扫描）
            let touched = false;
            if (typeof rec.cost !== 'number' && typeof costNum === 'number') {
                rec.cost = costNum; touched = true;
            }
            if (typeof rec.tokens !== 'number' && typeof tokensNum === 'number') {
                rec.tokens = tokensNum; touched = true;
            }
            if (touched) writeDaily(rec);

            const dc = (typeof rec.cost === 'number' && typeof costNum === 'number')
                ? Math.max(0, costNum - rec.cost) : null;
            const dt = (typeof rec.tokens === 'number' && typeof tokensNum === 'number')
                ? Math.max(0, tokensNum - rec.tokens) : null;
            return { cost: dc, tokens: dt, fresh: false };
        }

        /**
         * DSH 内置平台页（用量 / 充值）的能力入口。
         *
         * desktop 专属：preload 用 contextBridge 暴露了
         *   window.dshPlatform.open(page, bounds) / setBounds / close
         * → ipcRenderer.invoke('dsh-platform:open', page, bounds)
         * 主进程侧只接受 page === 'usage' | 'top-up'，且要求调用方是主窗口的
         * mainFrame（url 以 dsh-app://app/ 开头）—— web profile 下这个对象
         * 不存在，必须降级到系统浏览器。
         *
         * 注意：它只创建【原生视图】本身，不含任何外层 UI。返回栏与容器由
         * 调用方（PlatformHost）自己画 —— 这也是官方账号面板的做法。
         *
         * @returns dshPlatform 对象，或 undefined（能力不可用）
         */
        function platformBridge() {
            const plat = (typeof window !== 'undefined') ? window.dshPlatform : undefined;
            if (!plat || typeof plat.open !== 'function') return undefined;
            return plat;
        }

        /** 量出原生视图该占的矩形（除返回栏以外的整个内容区）。 */
        function measureHostRect() {
            const host = document.getElementById(HOST_ID);
            const r = host ? host.getBoundingClientRect() : { left: 0, top: 40, width: window.innerWidth, height: window.innerHeight - 40 };
            return {
                x: Math.max(0, Math.floor(r.left)),
                y: Math.max(0, Math.floor(r.top)),
                width: Math.max(1, Math.floor(r.width)),
                height: Math.max(1, Math.floor(r.height)),
            };
        }

        const HOST_ID = 'bal-platform-host';

        /**
         * 内嵌平台页的宿主：自己画返回栏，下方留白给原生视图。
         * 关闭时调 dshPlatform.close()，并随窗口尺寸变化同步 setBounds。
         */
        function PlatformHost(props) {
            const page = props.page;
            const onClose = props.onClose;
            const [err, setErr] = react.useState(null);
            const hostRef = react.useRef(null);

            // 打开：把 bounds 指到宿主区
            react.useEffect(() => {
                const plat = platformBridge();
                if (!plat) return;
                let alive = true;
                const rect = (() => {
                    const el = document.getElementById(HOST_ID);
                    const r = el ? el.getBoundingClientRect() : { left: 0, top: 40, width: window.innerWidth, height: window.innerHeight - 40 };
                    return {
                        x: Math.max(0, Math.floor(r.left)),
                        y: Math.max(0, Math.floor(r.top)),
                        width: Math.max(1, Math.floor(r.width)),
                        height: Math.max(1, Math.floor(r.height)),
                    };
                })();
                try {
                    const p = plat.open(page, rect);
                    if (p && typeof p.catch === 'function') {
                        p.catch((e) => { if (alive) setErr(String(e && e.message || e)); });
                    }
                } catch (e) {
                    setErr(String(e && e.message || e));
                }
                return () => {
                    alive = false;
                    try { if (typeof plat.close === 'function') plat.close(); } catch (e) { /* ignore */ }
                };
            }, [page]);

            // 尺寸变化 → 同步 bounds
            react.useEffect(() => {
                const plat = platformBridge();
                if (!plat) return;
                const sync = () => {
                    try { plat.setBounds(measureHostRect()); } catch (e) { /* ignore */ }
                };
                window.addEventListener('resize', sync);
                const t = setTimeout(sync, 50);
                return () => { window.removeEventListener('resize', sync); clearTimeout(t); };
            }, []);

            // Esc 关闭
            react.useEffect(() => {
                const onKey = (e) => { if (e.key === 'Escape') onClose(); };
                document.addEventListener('keydown', onKey);
                return () => document.removeEventListener('keydown', onKey);
            }, [onClose]);

            return react.createElement('div', { className: NS + '_overlay', role: 'dialog', 'aria-label': page === 'top-up' ? '充值' : '查询用量' },
                react.createElement('div', { className: NS + '_bar' },
                    react.createElement('button', {
                        type: 'button',
                        className: NS + '_back',
                        onClick: onClose,
                    }, '← 返回 DeepSeek Harness'),
                    err ? react.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, '加载失败: ' + err) : null
                ),
                react.createElement('div', { id: HOST_ID, ref: hostRef, className: NS + '_host' })
            );
        }

        /**
         * 外链/平台页点击处理。
         * ① 优先 DSH 内置平台页（desktop）—— 由调用方渲染容器后再打开；
         * ② 其次 openExternalLink（若该 slot 提供了它）；
         * ③ 最后退回 <a target="_blank"> 的默认行为（系统浏览器）。
         *
         * @param onOpenPlatform - 收到 'usage' | 'top-up' 时由组件打开容器
         */
        function makeLinkHandler(props, platformPage, fallbackUrl, onOpenPlatform) {
            return (e) => {
                // ① 内置平台页（仅当 dshPlatform 能力存在）
                if (platformBridge() && typeof onOpenPlatform === 'function') {
                    e.preventDefault();
                    onOpenPlatform(platformPage);
                    return;
                }

                // ② openExternalLink（若提供）
                const open = props && props.openExternalLink;
                if (typeof open === 'function') {
                    e.preventDefault();
                    try {
                        open(fallbackUrl);
                        return;
                    } catch (err) {
                        console.error('[balance] openExternalLink 失败:', err);
                    }
                }

                // ③ 让 <a target="_blank"> 走默认行为
            };
        }

        function BalancePill(props) {
            const useProjection = props.useProjection;
            const value = useProjection ? useProjection('deepseekBalance') : undefined;

            const [open, setOpen] = react.useState(false);
            const [pos, setPos] = react.useState(null);
            const [platformPage, setPlatformPage] = react.useState(null);   // 'usage' | 'top-up' | null
            const rootRef = react.useRef(null);
            const panelRef = react.useRef(null);
            const pillRef = react.useRef(null);

            // 余额 pill 的悬浮提示（自绘，替代浏览器原生 title）
            react.useEffect(() => {
                const el = pillRef.current;
                if (!el) return;
                const label = '点击查看余额明细';
                el._baltipLabel = label;
                const onEnter = () => showTip(el, label);
                const onFocus = () => showTip(el, label);
                const onLeave = () => hideTip();
                el.addEventListener('mouseenter', onEnter);
                el.addEventListener('mouseleave', onLeave);
                el.addEventListener('focus', onFocus);
                el.addEventListener('blur', onLeave);
                el.addEventListener('click', onLeave);
                return () => {
                    el.removeEventListener('mouseenter', onEnter);
                    el.removeEventListener('mouseleave', onLeave);
                    el.removeEventListener('focus', onFocus);
                    el.removeEventListener('blur', onLeave);
                    el.removeEventListener('click', onLeave);
                };
            }, []);

            // 定位：左边缘对齐，溢出右边界才左移，上方不足则翻到下方
            react.useEffect(() => {
                if (!open || !rootRef.current) return;
                const r = rootRef.current.getBoundingClientRect();
                const W = 300;
                const M = 12;
                let left = r.left;
                if (left + W > window.innerWidth - M) left = window.innerWidth - W - M;
                if (left < M) left = M;
                const flip = r.top < 180;
                setPos(flip
                    ? { left: left, top: r.bottom + 8 }
                    : { left: left, top: r.top - 8, transform: 'translateY(-100%)' });
            }, [open]);

            // 点击外部 / Esc 关闭
            react.useEffect(() => {
                if (!open) return;
                const onDown = (e) => {
                    const inRoot = rootRef.current && rootRef.current.contains(e.target);
                    const inPanel = panelRef.current && panelRef.current.contains(e.target);
                    if (!inRoot && !inPanel) setOpen(false);
                };
                const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
                document.addEventListener('mousedown', onDown);
                document.addEventListener('keydown', onKey);
                return () => {
                    document.removeEventListener('mousedown', onDown);
                    document.removeEventListener('keydown', onKey);
                };
            }, [open]);

            if (!useProjection || !value) {
                const hint = !useProjection ? '余额 —' : '余额 …';
                return react.createElement('span', { className: NS + '_root' },
                    react.createElement('span', { className: NS + '_anchor' },
                        react.createElement('span', { className: NS + '_pill' }, hint)));
            }

            const cur = value.currency === 'CNY' ? '¥' : (value.currency + ' ');
            const text = cur + value.total;

            // 累计消费（官方接口给的字符串，转数字用于做差）
            const costNum = (value.totalCost === null || value.totalCost === undefined)
                ? null : Number(value.totalCost);
            const costOk = typeof costNum === 'number' && !Number.isNaN(costNum);
            const tokensNum = (typeof value.totalTokens === 'number') ? value.totalTokens : null;
            const delta = dailyDelta(costOk ? costNum : null, tokensNum);

            const costCur = value.costCurrency === 'CNY' ? '¥' : ((value.costCurrency || 'CNY') + ' ');
            const fmtMoney = (n) => costCur + (n >= 100 ? n.toFixed(2) : n.toFixed(2));

            // 今日那行：基线刚建立时按用户要求显示 "—"
            const todayCostText = delta.fresh ? '—'
                : (delta.cost === null ? '—' : fmtMoney(delta.cost));
            const todayTokText = delta.fresh ? '—'
                : (delta.tokens === null ? '—' : fmtTok(delta.tokens));

            const rows = [
                row('充值余额', cur + value.toppedUp, 'topped'),
                row('赠送余额', cur + value.granted, 'granted'),
                row('可用状态', value.error ? '异常' : '正常', 'avail'),
                row('今日消费', value.costError ? '取数失败' : todayCostText, 'costday'),
                row('累计消费', costOk ? fmtMoney(costNum) : '—', 'costtotal'),
                row('今日 Tokens', todayTokText, 'tokday'),
                row('累计 Tokens', fmtTok(tokensNum), 'toktotal'),
                row('更新于', fmtTime(value.updatedAt), 'time'),
            ];
            if (value.error) rows.push(row('余额错误', value.error, 'err'));
            if (value.costError) rows.push(row('消费错误', value.costError, 'costerr'));
            if (value.tokenError) rows.push(row('Tokens 错误', value.tokenError, 'tokerr'));

            const panel = open && pos && reactDom.createPortal(
                react.createElement('div', {
                    ref: panelRef,
                    className: NS + '_panel',
                    style: pos,
                    role: 'dialog',
                    'aria-label': 'DeepSeek 余额',
                    'data-balance-panel': value.error ? 'err' : 'ok',
                },
                    react.createElement('div', { className: NS + '_title' },
                        react.createElement('span', null, 'DeepSeek 余额'),
                        react.createElement('span', { className: NS + '_num' }, text)
                    ),
                    react.createElement('div', { className: NS + '_titleRule', 'aria-hidden': true }),
                    react.createElement('dl', { className: NS + '_details' }, rows),
                    react.createElement('div', { className: NS + '_foot' },
                        react.createElement('a', {
                            className: NS + '_btn ' + NS + '_btnGhost',
                            href: USAGE_URL,
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            onClick: makeLinkHandler(props, 'usage', USAGE_URL, setPlatformPage),
                        }, '查询用量'),
                        react.createElement('a', {
                            className: NS + '_btn ' + NS + '_btnPrimary',
                            href: TOP_UP_URL,
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            onClick: makeLinkHandler(props, 'top-up', TOP_UP_URL, setPlatformPage),
                        }, '充值')
                    )
                ),
                document.body
            );

            // 内嵌平台页（自带返回栏；仅 desktop 提供 dshPlatform 时才会被打开）
            const platform = platformPage && reactDom.createPortal(
                react.createElement(PlatformHost, {
                    page: platformPage,
                    onClose: () => setPlatformPage(null),
                }),
                document.body
            );

            // ★ 2026-10-04：阈值从【两档跳变】改为【低于 5 元起连续渐变】（橙 → 红）。
            //   >5 元不返回东西 ⇒ 保持默认灰（正常状态不动，变色本身即信号）。
            //   heat 0% ⇒ 纯警告橙（刚跌破 5 元）；100% ⇒ 纯错误红（余额归零或欠费）。
            //   保留原有两处严谨：只在 CNY 下判（别币种不套人民币阈值）、解析失败不标色。
            const PILL_WARN_AT = 5;                       // 元：渐变起点
            const pillNum = Number(value.total);
            const pillHeat = (value.currency === 'CNY' && !Number.isNaN(pillNum) && pillNum < PILL_WARN_AT)
                ? { '--bal-heat': (Math.max(0, Math.min(1, (PILL_WARN_AT - pillNum) / PILL_WARN_AT)) * 100).toFixed(1) + '%' }
                : null;
            // 无障碍文案仍按原来的两档措辞 —— 读屏需要的是语言，不是颜色
            const pillWarn = pillHeat
                ? (pillNum < 1 ? '，余额告急' : '，余额偏低')
                : '';

            return react.createElement('span', { ref: rootRef, className: NS + '_root' },
                react.createElement('span', { className: NS + '_anchor' },
                    react.createElement('button', {
                        ref: pillRef,
                        type: 'button',
                        className: NS + '_pill' + (pillHeat ? ' ' + NS + '_heat' : ''),
                        style: pillHeat || undefined,
                        'aria-haspopup': 'dialog',
                        'aria-expanded': open,
                        'aria-label': 'DeepSeek 余额 ' + text + pillWarn + '，点击查看明细',
                        onClick: () => setOpen(!open),
                    }, text)),
                panel,
                platform
            );
        }

        const inject = ['slots'];

        function apply(ctx) {
            console.log('[balance] client apply()');
            injectCss();
            console.log('[balance] CSS 已注入');
            ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
                {
                    name: 'conversation.composer.dock',
                    id: 'balance',
                    order: 10,
                },
                BalancePill,
            ));
            console.log('[balance] composer.dock 已注册（含 hover 高亮）');
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
