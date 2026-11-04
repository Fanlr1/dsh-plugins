// dsh-plugin-hw-monitor -- client 侧
//
// 两处显示（用户选定）：
//   ① composer 条上：极简一行，与官方 StatsPills 并排
//   ② 鼠标悬停：只高亮；**点击**：弹出完整面板（五项指标 + 进度条 + 附加信息）
//
//   ★ 2026-10-04 改：原来"悬停即展开 + 移开 160ms 收起"与其它三个插件
//     （balance-mvp / goal-fold / queue-fold）的"悬停高亮 + 按下查看详情"不一致，
//     用户指出后统一为此模式。改动点：cursor default→pointer、加 :hover/aria-expanded
//     共用高亮规则、onMouseEnter/Leave 换成 onClick + aria-expanded、
//     新增点击外部与 Esc 关闭。
//
// 数据来自 host 侧的 hwMonitor 投影（2.5s 更新，CPU 频率 10s）。
// 样式对照官方：pill 用 dsh-client-ui-chat 的 pill 规则值，面板用 stat_dialog 的 panel 规则值。
// 全程不使用 !important（用选择器特异性解决）。

window.__ModuleLoader__.load({
    id: 'dsh-plugin-hw-monitor',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        let react = require('react');
        let reactDom = require('react-dom');

        const NS = 'hwmon';
        const CSS_TAG_ID = 'dsh-plugin-hw-monitor/client.css';
        const PANEL_ATTR = 'data-hwmon-panel';

        // ★ 定位常量 —— 与官方 stat-dialog.js 同值（从 app.asar 原文抄出，非估算）：
        //     const PANEL_MARGIN = 12;  // Viewport margin the placement clamp keeps
        //     const PANEL_GAP    = 8;   // Distance between the trigger's top edge and the panel's bottom
        const PANEL_GAP = 8;
        const PANEL_MARGIN = 12;

        const CSS = [
            // ── 简版 pill（放在 composer 行的最左边）──
            // 逐条对齐官方 StatsPills（dsh-client-ui-chat 的 bOPqQW_*）：
            //   root : font-size/line-height/gap 与官方同值，多一个 margin-right:auto 靠左
            //   pill : font:inherit + tabular-nums（官方数字等宽的关键）
            //   sep  : 用 --dsw-alias-separator-primary，不用 opacity
            //
            // ★ 2026-10-04：胶囊与高亮都移到【容器 root】上。
            //   原来把 background/border-radius 放在 _pill 上，而 DOM 里有两个 _pill
            //   （显存段、内存段）→ 悬停时两个胶囊各亮各的，与官方"整块一个胶囊"不符。
            //   官方的 517轮/3112步/292tok/s 就是一个胶囊包住所有段。
            '.' + NS + '_root{',
            'box-sizing:border-box;min-width:0;max-width:100%;margin-right:auto;order:-1;',
            'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
            'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
            'gap:6px;align-items:center;display:inline-flex;',
            'color:var(--dsw-alias-label-tertiary);cursor:pointer;user-select:none;',
            // 胶囊本体（整块只有一个）
            'background:0 0;border:none;border-radius:999px;padding:1px 8px;',
            'transition:background .12s var(--ds-ease-in-out,ease)}',
            // ★ 官方的高亮规则：hover 与展开态共用同一个背景，且作用于【整个胶囊】
            '.' + NS + '_root:hover,',
            '.' + NS + '_root[aria-expanded="true"]{',
            'background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
            '.' + NS + '_pill{',
            'box-sizing:border-box;max-width:100%;',
            'color:var(--dsw-alias-label-tertiary);',
            'font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;',
            'white-space:nowrap;',
            'align-items:center;gap:6px;display:inline-flex}',
            '.' + NS + '_sep{',
            'color:var(--dsw-alias-separator-primary);margin:0 6px}',
            // ★ 2026-10-04：三档跳变 → 连续渐变。--hw-heat=0% 取纯橙，=100% 取纯红，中间插值。
            //   color-mix 是官方自用特性（本机 Code Cache 里能找到），无需降级分支。
            //   <70% 时 heatStyle 返回 null ⇒ 不加此 class ⇒ 保持上面的默认 tertiary 灰。
            '.' + NS + '_pill.' + NS + '_heat{color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) var(--hw-heat),var(--dsw-alias-state-warning-primary,#d97706))}',

            // ── 悬浮面板 ──
            // ★ 2026-10-04：逐条对齐官方 stat_dialog 的 .Xt1eiG_panel（从 app.asar 挖出的原文）：
            //   z-index:1100 / box-sizing:border-box / border-radius:var(--dsw-radius-lg)
            //   background:var(--dsw-specific-menu) / width:max-content
            //   min-width:min(300px,100vw - 24px) / max-width:min(440px,100vw - 24px)
            //   backdrop-filter:var(--dsw-menu-backdrop-filter)
            //   --dsw-elevation-stroke-color:var(--dsw-alias-border-l1)
            //   box-shadow:var(--dsw-elevation-prominent) / color:label-secondary
            //   cursor:default / border:0 / padding:16px / line-height:18px
            // 原实现是自己编的：padding 10px 12px、自加 .5px 边框、自写 box-shadow、
            // z-index 1080、写死 min/max-width、line-height 1.5 —— 全部与官方不符。
            '[' + PANEL_ATTR + ']{',
            'position:fixed;z-index:1100;box-sizing:border-box;',
            'width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);',
            'padding:16px;',
            'background:var(--dsw-specific-menu);',
            'border:0;',
            'border-radius:var(--dsw-radius-lg,12px);',
            'backdrop-filter:var(--dsw-menu-backdrop-filter);',
            '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
            'box-shadow:var(--dsw-elevation-prominent);',
            'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);',
            'cursor:default;',
            'display:flex;flex-direction:column;gap:6px}',
            '.' + NS + '_pTitle{',
            'font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;',
            'color:var(--dsw-alias-label-tertiary);margin-bottom:2px}',
            '.' + NS + '_row{display:flex;flex-direction:column;gap:3px}',
            '.' + NS + '_rowTop{',
            'display:flex;align-items:baseline;justify-content:space-between;gap:10px}',
            '.' + NS + '_label{color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary))}',
            '.' + NS + '_val{',
            'font-variant-numeric:tabular-nums;font-weight:600;',
            'color:var(--dsw-alias-label-primary)}',
            '.' + NS + '_unit{font-weight:400;color:var(--dsw-alias-label-tertiary);margin-left:2px}',
            '.' + NS + '_bar{',
            'height:4px;border-radius:2px;overflow:hidden;',
            'background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
            '.' + NS + '_fill{height:100%;border-radius:2px;transition:width .3s var(--ds-ease-in-out,ease)}',
            '.' + NS + '_foot{',
            'display:flex;flex-wrap:wrap;gap:4px 12px;padding-top:6px;',
            'border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));',
            'color:var(--dsw-alias-label-tertiary);font-size:11px}',
            '.' + NS + '_foot span{white-space:nowrap}',
            '.' + NS + '_err{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:11px}',
        ].join('');

        function injectCss() {
            if (typeof document === 'undefined') return;
            const sel = 'style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']';
            if (document.querySelector(sel) !== null) return;
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-plugin-hw-monitor';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        // ── 数值格式化 ──
        function fmtInt(v) { return v === null || v === undefined ? '—' : String(Math.round(v)); }
        function fmt1(v) { return v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toFixed(1); }
        /** GB 数值：>=0.1G 保留一位小数；更小则显示 <0.1G（避免 26 MiB 被显示成 0.0G）。 */
        function fmtGB(gb) {
            if (gb === null || gb === undefined) return '—';
            if (gb < 0.1) return '<0.1G';
            return gb.toFixed(1) + 'G';
        }
        function pctOf(used, total) {
            if (!used || !total) return null;
            return Math.max(0, Math.min(100, (used / total) * 100));
        }
        /** 三档色：<70 绿 / 70~90 黄 / >90 红 */
        function barColor(p) {
            if (p === null) return 'var(--dsw-alias-label-quaternary,#c9ccd1)';
            if (p >= 90) return 'var(--dsw-alias-state-error-primary,#dc2626)';
            if (p >= 70) return 'var(--dsw-alias-state-warning-primary,#d97706)';
            return 'var(--dsw-alias-state-success-primary,#16a34a)';
        }
        // ★ 2026-10-04：由三档跳变改为【连续渐变】。
        //   <70% 不返回任何东西 ⇒ 保持默认灰（正常状态不动 —— 变色本身就是信号）。
        //   ≥70% 返回 CSS 变量 --hw-heat（0% ⇒ 纯警告橙；100% ⇒ 纯错误红），
        //   由 CSS 的 color-mix() 在【两个官方语义色之间】插值，不引入任何自定义色值。
        function heatStyle(p) {
            if (p === null || p < 70) return null;
            const h = Math.max(0, Math.min(100, ((p - 70) / 30) * 100));
            return { '--hw-heat': h.toFixed(1) + '%' };
        }

        // ── 单项（标签 + 值 + 进度条）──
        function Row(props) {
            const { label, value, unit, pct } = props;
            return react.createElement('div', { className: NS + '_row' },
                react.createElement('div', { className: NS + '_rowTop' },
                    react.createElement('span', { className: NS + '_label' }, label),
                    react.createElement('span', { className: NS + '_val' },
                        value,
                        unit ? react.createElement('span', { className: NS + '_unit' }, unit) : null,
                    ),
                ),
                pct !== null && pct !== undefined
                    ? react.createElement('div', { className: NS + '_bar' },
                        react.createElement('div', {
                            className: NS + '_fill',
                            style: { width: Math.round(pct) + '%', background: barColor(pct) },
                        }),
                    )
                    : null,
            );
        }

        // ── 完整面板 ──
        function Panel(props) {
            const { v, updatedText } = props;
            const vramPct = pctOf(v.vramUsed, v.vramTotal);
            const memPct = pctOf(v.memUsedGB, v.memTotalGB);

            return react.createElement('div', null,
                react.createElement('div', { className: NS + '_pTitle' }, '硬件状态'),

                react.createElement(Row, {
                    label: '显存',
                    value: v.vramUsed === null ? '—' : fmtInt(v.vramUsed) + ' / ' + fmtInt(v.vramTotal) + ' MiB',
                    unit: vramPct === null ? null : '  ' + Math.round(vramPct) + '%',
                    pct: vramPct,
                }),
                react.createElement(Row, {
                    label: '内存',
                    value: v.memUsedGB === null ? '—' : fmt1(v.memUsedGB) + ' / ' + fmt1(v.memTotalGB) + ' GB',
                    unit: memPct === null ? null : '  ' + Math.round(memPct) + '%',
                    pct: memPct,
                }),
                react.createElement(Row, {
                    label: 'GPU 占用',
                    value: v.gpuPct === null ? '—' : fmtInt(v.gpuPct),
                    unit: '%',
                    pct: v.gpuPct,
                }),
                react.createElement(Row, {
                    label: 'CPU 占用',
                    value: v.cpuPct === null ? '—' : fmt1(v.cpuPct),
                    unit: v.cpuCores ? '%  (' + v.cpuCores + ' 线程)' : '%',
                    pct: v.cpuPct,
                }),
                react.createElement(Row, {
                    label: 'CPU 频率',
                    value: v.cpuMHz === null ? '—' : fmtInt(v.cpuMHz),
                    unit: v.cpuMHz === null ? null : ' MHz',
                    pct: null,
                }),

                react.createElement('div', { className: NS + '_foot' },
                    v.gpuTempC !== null ? react.createElement('span', null, 'GPU 温度 ' + fmtInt(v.gpuTempC) + '°C') : null,
                    v.gpuWatt !== null ? react.createElement('span', null, '功耗 ' + fmt1(v.gpuWatt) + ' W') : null,
                    v.gpuMHz !== null ? react.createElement('span', null, 'GPU 频率 ' + fmtInt(v.gpuMHz) + ' MHz') : null,
                    updatedText ? react.createElement('span', null, updatedText) : null,
                ),
                v.error ? react.createElement('div', { className: NS + '_err' }, 'GPU 读取失败: ' + v.error) : null,
            );
        }

        // ── 简版 pill（带 hover 面板）──
        function HwPill(props) {
            const useProjection = props.useProjection;
            const v = (useProjection ? useProjection('hwMonitor') : undefined) || {};

            const [open, setOpen] = react.useState(false);
            const [pos, setPos] = react.useState(null);
            const rootRef = react.useRef(null);
            const panelRef = react.useRef(null);   // ★ 新增：用于测量面板真实尺寸（官方做法）

            // ★ 2026-10-04：定位逻辑重写，对齐官方 useAnchoredPosition（stat-dialog.js）。
            //
            // 官方常量（从 app.asar 原文抄出，非估算）：
            //   const PANEL_MARGIN = 12;  // 视口边缘保留的边距
            //   const PANEL_GAP    = 8;   // 触发元素顶边 ↔ 面板底边的距离
            //
            // 原实现的两处硬伤：
            //   ① 用【硬编码 300x210】当面板尺寸 —— 而实际高度随内容变化（有无 GPU/CPU
            //      数据、有无错误行都不同）⇒ top 必然算偏，面板会压住触发元素。
            //      官方是 panel.offsetHeight，必须真实测量。
            //   ② 完全没有 scroll / resize / ResizeObserver 监听 ⇒ 滚动或改窗后位置不跟随。
            //
            // 未定位时（pos 为 null）面板仍要渲染，但用 visibility:hidden 让它先参与布局，
            // 才能测到真实尺寸 —— 这就是官方 MEASURE_STYLE 的作用。
            react.useLayoutEffect(() => {
                if (!open) { setPos(null); return undefined; }

                const place = () => {
                    const el = rootRef.current;
                    if (!el) return;
                    const r = el.getBoundingClientRect();
                    const panel = panelRef.current;
                    const W = panel ? panel.offsetWidth : 0;
                    const H = panel ? panel.offsetHeight : 0;

                    let left = r.left;
                    let top = r.top - PANEL_GAP - H;      // 默认向上弹（composer 在下方）

                    // 视口 clamp —— 与官方逐字一致的公式
                    if (W > 0) left = Math.min(Math.max(left, PANEL_MARGIN), window.innerWidth - W - PANEL_MARGIN);
                    if (H > 0) top = Math.min(Math.max(top, PANEL_MARGIN), window.innerHeight - H - PANEL_MARGIN);

                    setPos({ left: Math.round(left), top: Math.round(top) });
                };

                place();
                window.addEventListener('scroll', place, true);
                window.addEventListener('resize', place);

                const panel = panelRef.current;
                let observer = null;
                if (typeof ResizeObserver !== 'undefined' && panel !== null) {
                    observer = new ResizeObserver(place);
                    observer.observe(panel);
                }
                return () => {
                    if (observer) observer.disconnect();
                    window.removeEventListener('scroll', place, true);
                    window.removeEventListener('resize', place);
                };
            }, [open]);

            // 点击外部 / 按 Esc 关闭
            // ★★ 2026-10-04 修复：这个 hook 【必须在任何提前 return 之前】。
            //    原来它写在 `if (!hasAny) return null` 之后，而当天新加的 useLayoutEffect
            //    却在 return 之前 ⇒ 有数据时跑 2 个 hook、无数据时只跑 1 个
            //    ⇒ React error #310（hook 数量不一致）⇒ slot entry crashed
            //    ⇒ 探针整段消失。这也解释了"时有时无"：投影无数据的瞬间就会崩。
            react.useEffect(() => {
                if (!open) return undefined;
                const onDoc = (e) => {
                    const t = e.target;
                    if (rootRef.current && t && rootRef.current.contains(t)) return;
                    if (t && t.closest && t.closest('[' + PANEL_ATTR + ']')) return;
                    setOpen(false);
                };
                const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
                document.addEventListener('pointerdown', onDoc, true);
                document.addEventListener('keydown', onKey);
                return () => {
                    document.removeEventListener('pointerdown', onDoc, true);
                    document.removeEventListener('keydown', onKey);
                };
            }, [open]);

            // 无数据时不占位（简版只画这两项，所以只按它们判断）
            // ⚠️ 这个 return 必须【在所有 hook 之后】，否则 hook 数量会随数据有无而变化。
            const hasAny = (v.vramUsed !== null && v.vramUsed !== undefined)
                || (v.memUsedGB !== null && v.memUsedGB !== undefined);
            if (!hasAny) return null;

            // ★ 2026-10-04：由"悬停展开"改为"点击展开"（与 balance-mvp / goal-fold / queue-fold 一致）
            // 定位已交给上面的 useLayoutEffect，这里只翻转开关。
            function toggle() {
                setOpen(!open);
            }

            // 简版只显示两项：显存占用 / 内存占用（用户要求）
            // GPU 占用、CPU 占用、CPU 频率一律收进悬浮面板
            const segs = [];
            if (v.vramUsed !== null && v.vramUsed !== undefined) {
                const gp = pctOf(v.vramUsed, v.vramTotal);
                segs.push({
                    key: 'vram',
                    label: '显存',
                    // 小值不再四舍五入成 "0.0G"：<0.1G 时显示 <0.1G
                    val: fmtGB(v.vramUsed / 1024),
                    heat: heatStyle(gp),
                });
            }
            if (v.memUsedGB !== null && v.memUsedGB !== undefined) {
                const mp = pctOf(v.memUsedGB, v.memTotalGB);
                segs.push({
                    key: 'mem',
                    label: '内存',
                    val: fmtGB(v.memUsedGB),
                    heat: heatStyle(mp),
                });
            }

            let updatedText = null;
            if (v.updatedAt) {
                const d = new Date(v.updatedAt);
                const p2 = (n) => String(n).padStart(2, '0');
                updatedText = '更新于 ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
            }

            const children = [];
            segs.forEach((s, i) => {
                if (i > 0) children.push(react.createElement('span', { key: 'sep' + i, className: NS + '_sep' }, '·'));
                children.push(react.createElement('span', {
                    key: s.key,
                    className: NS + '_pill' + (s.heat ? ' ' + NS + '_heat' : ''),
                    // --hw-heat 通过内联 style 下发；React 会原样输出自定义属性
                    style: s.heat || undefined,
                },
                    s.label ? s.label + ' ' : null,
                    // 官方不加粗数值（原本这里用了 <b>，是字体看起来不同的主因）
                    s.val,
                ));
            });

            return react.createElement('div', {
                ref: rootRef,
                className: NS + '_root',
                'data-hwmon-pill': '1',
                role: 'button',
                tabIndex: 0,
                'aria-expanded': open ? 'true' : 'false',
                onClick: toggle,
                onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                },
            },
                children,
                open
                    ? reactDom.createPortal(
                        react.createElement('div', {
                            ref: panelRef,   // ★ 定位需要读它的 offsetWidth/offsetHeight
                            'data-hwmon-panel': '1',
                            // 未定位时仍要渲染，但隐藏 —— 让它先参与布局才能测到真实尺寸。
                            // 这就是官方 MEASURE_STYLE = { visibility:'hidden', left:0, top:0 } 的作用。
                            style: pos
                                ? { left: pos.left + 'px', top: pos.top + 'px' }
                                : { visibility: 'hidden', left: 0, top: 0 },
                        }, react.createElement(Panel, { v, updatedText })),
                        document.body,
                    )
                    : null,
            );
        }

        function apply(ctx) {
            console.log('[hw-monitor] client apply()');
            injectCss();
            ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
                {
                    name: 'conversation.composer.dock',
                    id: 'hw-monitor',
                    // order 取负值 + CSS margin-right:auto，双保险放最左
                    // （余额插件 balance-mvp 的 order 是 10）
                    order: -100,
                },
                HwPill,
            ));
            console.log('[hw-monitor] composer.dock 已注册（最左，只显示显存/内存）');
        }

        const inject = ['slots'];
        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
