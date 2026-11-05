// dsh-plugin-session-tidy -- client 侧
//
// 入口：侧边栏底部动作区（sidebar.footer.action）
// 能力：列出会话（按工作区分组）→ 勾选 → 二次确认 → 移到回收目录 → 可再清空
//
// 样式照抄官方：只用 --dsw-* 变量，全程不用 !important，类名带 sc_ 前缀。
// 不 require 任何 Harness Client 包（官方明令）。

window.__ModuleLoader__.load({
    id: 'dsh-plugin-session-tidy',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        let react = require('react');
        let reactDom = require('react-dom');

        // 官方 primitive：MenuItemButton 自带宿主菜单项样式（图标位、缩进、hover、快捷键槽）。
        // 据 dsh-client-ui-workspace README：Module Loader 包可经 loader 的 require 解析它，
        // 但【不要打包副本、不要列为运行时依赖】。取不到就降级自绘，绝不让菜单崩。
        // 快捷键（全局）与面板之间的桥：由侧边栏入口在挂载时登记
        let openPanelBridge = null;

        let MenuItemButton = null;
        try {
            const prim = require('@deepseek-ai/dsh-client-ui-primitives');
            if (prim && typeof prim.MenuItemButton === 'function') {
                MenuItemButton = prim.MenuItemButton;
                console.log('[session-tidy] ✅ 官方 primitive 就绪：菜单项用 MenuItemButton（官方样式）');
            } else {
                console.log('[session-tidy] primitives 能加载但没有 MenuItemButton，降级自绘');
            }
        } catch (e) {
            console.log('[session-tidy] MenuItemButton 取不到，降级自绘: ' + ((e && e.message) || e));
        }

        const NS = 'sc';
        const SHORTCUT_ID = 'session-tidy.open';
        const CSS_TAG_ID = 'dsh-plugin-session-tidy/client.css';

        const CSS = [
            '.' + NS + '_btn{',
            'box-sizing:border-box;color:var(--dsw-alias-label-tertiary);font:inherit;',
            'background:0 0;border:none;border-radius:8px;cursor:pointer;',
            'align-items:center;gap:6px;padding:4px 8px;display:inline-flex;width:100%;text-align:left}',
            '.' + NS + '_btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
            '.' + NS + '_mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9000}',
            '.' + NS + '_panel{',
            'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9001;',
            'width:min(760px,92vw);max-height:82vh;display:flex;flex-direction:column;',
            'background:var(--dsw-alias-bg-base,#1b1b1f);color:var(--dsw-alias-label-primary,#e8e8ea);',
            'border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.12));border-radius:12px;',
            'box-shadow:0 12px 40px rgba(0,0,0,.5);font-size:13px;line-height:20px;overflow:hidden}',
            '.' + NS + '_head{padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.1))}',
            '.' + NS + '_title{font-size:15px;font-weight:600;display:flex;justify-content:space-between;align-items:center}',
            '.' + NS + '_sub{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:4px}',
            '.' + NS + '_body{overflow:auto;padding:8px 16px;flex:1;min-height:80px}',
            '.' + NS + '_ws{margin:10px 0 4px;color:var(--dsw-alias-label-secondary);font-weight:600}',
            '.' + NS + '_wsPath{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:12px;margin-left:6px}',
            '.' + NS + '_row{display:flex;align-items:center;gap:8px;padding:3px 0}',
            '.' + NS + '_row label{display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer}',
            '.' + NS + '_row input{cursor:pointer}',
            '.' + NS + '_id{font-family:ui-monospace,Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.' + NS + '_size{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
            '.' + NS + '_tag{font-size:11px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.15));color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
            '.' + NS + '_lock{color:var(--dsw-alias-state-warning-primary,#d97706);font-size:11px;white-space:nowrap}',
            '.' + NS + '_foot{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.1));display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}',
            '.' + NS + '_act{box-sizing:border-box;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit;border:1px solid transparent}',
            '.' + NS + '_ghost{background:0 0;border-color:var(--dsw-alias-border-secondary,rgba(255,255,255,.18));color:var(--dsw-alias-label-secondary)}',
            '.' + NS + '_ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '.' + NS + '_danger{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff}',
            '.' + NS + '_danger:disabled{opacity:.45;cursor:not-allowed}',
            '.' + NS + '_confirm{background:var(--dsw-alias-state-warning-primary,#d97706);color:#fff}',
            '.' + NS + '_msg{color:var(--dsw-alias-label-tertiary);font-size:12px}',
            '.' + NS + '_err{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px}',
            // 会话行菜单里的条目：照官方菜单项的样子（整行可点、hover 高亮、不用 !important）
            '.' + NS + '_mi{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;background:0 0;border:none;color:var(--dsw-alias-label-primary,#e8e8ea);font:inherit;text-align:left;padding:6px 10px;border-radius:6px;cursor:pointer}',
            '.' + NS + '_mi:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '.' + NS + '_miIcon{flex:0 0 auto;opacity:.75}',
            // 仅在拿不到官方 MenuItemButton 时的兜底（danger 行的等价外观）
            '.' + NS + '_miDanger{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        ].join('\n');

        function injectCss() {
            if (document.getElementById(CSS_TAG_ID)) return;
            const tag = document.createElement('style');
            tag.id = CSS_TAG_ID;
            tag.setAttribute('data-plugin-css', CSS_TAG_ID);
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        function fmtBytes(n) {
            if (!n) return '0 B';
            if (n < 1024) return n + ' B';
            if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
            if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
            return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        }
        function fmtTime(ms) {
            try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return ''; }
        }
        const LOCK_TEXT = { active: '运行中', pinned: '已置顶', recent: '刚用过' };

        async function api(path, body) {
            const opt = body === undefined
                ? { method: 'GET' }
                : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
            const r = await fetch(path, opt);
            let j = null;
            try { j = await r.json(); } catch { /* 非 JSON */ }
            if (!r.ok) throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
            return j;
        }

        function Panel(props) {
            const onClose = props.onClose;
            const initialPick = props.initialPick || '';
            const initialConfirming = !!props.initialConfirming;
            const [loading, setLoading] = react.useState(true);
            const [err, setErr] = react.useState('');
            const [data, setData] = react.useState(null);
            const [picked, setPicked] = react.useState({});   // id -> true
            const [confirming, setConfirming] = react.useState(false);
            const [busy, setBusy] = react.useState(false);
            const [note, setNote] = react.useState('');

            const load = react.useCallback(() => {
                setLoading(true); setErr('');
                api('/session-tidy/list')
                    .then((d) => {
                        setData(d);
                        setPicked(initialPick ? { [initialPick]: true } : {});
                        setConfirming(initialConfirming);
                    })
                    .catch((e) => setErr(String(e.message || e)))
                    .finally(() => setLoading(false));
            }, []);
            react.useEffect(() => { load(); }, [load]);

            const sessions = (data && data.sessions) || [];
            const pickedList = sessions.filter((s) => picked[s.id]);
            const pickedBytes = pickedList.reduce((n, s) => n + s.bytes, 0);

            const toggle = (id) => setPicked((p) => { const q = Object.assign({}, p); if (q[id]) delete q[id]; else q[id] = true; return q; });

            const groups = react.useMemo(() => {
                const m = new Map();
                for (const s of sessions) {
                    if (!m.has(s.workspace)) m.set(s.workspace, { workspace: s.workspace, path: s.workspacePath, items: [] });
                    m.get(s.workspace).items.push(s);
                }
                return Array.from(m.values());
            }, [sessions]);

            const pickGroup = (g, on) => setPicked((p) => {
                const q = Object.assign({}, p);
                for (const s of g.items) { if (on && !s.lockedBy) q[s.id] = true; else if (!on) delete q[s.id]; }
                return q;
            });
            const pickAll = () => setPicked(() => {
                const q = {};
                for (const s of sessions) if (!s.lockedBy) q[s.id] = true;
                return q;
            });

            const doDelete = async () => {
                setBusy(true); setErr('');
                try {
                    const r = await api('/session-tidy/delete', {
                        ids: pickedList.map((s) => ({ id: s.id, workspace: s.workspace })),
                    });
                    const moved = (r.moved || []).length;
                    const refused = (r.failed || []).length;
                    setNote('已移动 ' + moved + ' 个会话到回收目录' + (refused ? '，' + refused + ' 个被拒绝' : ''));
                    setConfirming(false);
                    load();
                } catch (e) { setErr(String(e.message || e)); }
                finally { setBusy(false); }
            };

            const doEmpty = async () => {
                setBusy(true); setErr('');
                try {
                    const r = await api('/session-tidy/empty-trash', {});
                    setNote('已彻底删除 ' + r.count + ' 个会话 / ' + fmtBytes(r.bytes));
                    load();
                } catch (e) { setErr(String(e.message || e)); }
                finally { setBusy(false); }
            };

            const rows = [];
            for (const g of groups) {
                rows.push(react.createElement('div', { className: NS + '_ws', key: 'ws-' + g.workspace },
                    g.path || g.workspace,
                    react.createElement('span', { className: NS + '_wsPath' }, '(' + g.items.length + ')'),
                    react.createElement('button', {
                        className: NS + '_act ' + NS + '_ghost',
                        style: { marginLeft: 8, padding: '1px 6px', fontSize: 11 },
                        onClick: () => pickGroup(g, true),
                    }, '选可清理的'),
                    react.createElement('button', {
                        className: NS + '_act ' + NS + '_ghost',
                        style: { marginLeft: 4, padding: '1px 6px', fontSize: 11 },
                        onClick: () => pickGroup(g, false),
                    }, '清空勾选')
                ));
                for (const s of g.items) {
                    const locked = !!s.lockedBy;
                    rows.push(react.createElement('div', { className: NS + '_row', key: s.id },
                        react.createElement('label', null,
                            react.createElement('input', {
                                type: 'checkbox', disabled: locked, checked: !!picked[s.id],
                                onChange: () => toggle(s.id),
                            }),
                            react.createElement('span', { className: NS + '_id' }, s.id),
                            s.title ? react.createElement('span', { className: NS + '_tag' }, s.title) : null,
                            s.archived ? react.createElement('span', { className: NS + '_tag' }, '已归档') : null
                        ),
                        locked ? react.createElement('span', { className: NS + '_lock' }, LOCK_TEXT[s.lockedBy] || '禁选') : null,
                        react.createElement('span', { className: NS + '_size' }, fmtBytes(s.bytes)),
                        react.createElement('span', { className: NS + '_tag' }, fmtTime(s.mtime))
                    ));
                }
            }

            const trash = (data && data.trash) || { count: 0, bytes: 0 };

            return reactDom.createPortal(
                react.createElement(react.Fragment, null,
                    react.createElement('div', { className: NS + '_mask', onClick: onClose }),
                    react.createElement('div', { className: NS + '_panel', role: 'dialog', 'aria-label': '清理会话文件' },
                        react.createElement('div', { className: NS + '_head' },
                            react.createElement('div', { className: NS + '_title' },
                                react.createElement('span', null, '清理会话文件'),
                                react.createElement('button', { className: NS + '_act ' + NS + '_ghost', onClick: onClose }, '关闭')
                            ),
                            react.createElement('div', { className: NS + '_sub' },
                                loading ? '读取中…'
                                    : data
                                        ? '共 ' + sessions.length + ' 个会话 / ' + fmtBytes(data.totalBytes)
                                          + ' · 可清理 ' + fmtBytes(data.deletableBytes)
                                          + ' · 置顶 ' + (data.counts ? data.counts.pinned : 0)
                                          + ' · 运行中 ' + (data.counts ? data.counts.active : 0)
                                        : ''
                            )
                        ),
                        react.createElement('div', { className: NS + '_body' },
                            err ? react.createElement('div', { className: NS + '_err' }, '出错：' + err) : null,
                            note ? react.createElement('div', { className: NS + '_msg' }, note) : null,
                            !loading && !sessions.length ? react.createElement('div', { className: NS + '_msg' }, '没有可显示的会话。') : null,
                            rows
                        ),
                        react.createElement('div', { className: NS + '_foot' },
                            react.createElement('div', null,
                                react.createElement('div', { className: NS + '_msg' }, '已选 ' + pickedList.length + ' 个 / ' + fmtBytes(pickedBytes)),
                                react.createElement('div', { className: NS + '_msg' },
                                    '回收目录：' + trash.count + ' 个 / ' + fmtBytes(trash.bytes)
                                    + (trash.count ? '（可彻底删除）' : ''))
                            ),
                            react.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                                react.createElement('button', { className: NS + '_act ' + NS + '_ghost', onClick: pickAll, disabled: busy }, '全选可清理'),
                                trash.count
                                    ? react.createElement('button', { className: NS + '_act ' + NS + '_ghost', onClick: doEmpty, disabled: busy }, '清空回收目录')
                                    : null,
                                confirming
                                    ? react.createElement(react.Fragment, null,
                                        react.createElement('button', { className: NS + '_act ' + NS + '_confirm', onClick: doDelete, disabled: busy },
                                            busy ? '处理中…' : '确认清理 ' + pickedList.length + ' 个'),
                                        react.createElement('button', { className: NS + '_act ' + NS + '_ghost', onClick: () => setConfirming(false), disabled: busy }, '取消')
                                      )
                                    : react.createElement('button', {
                                        className: NS + '_act ' + NS + '_danger',
                                        disabled: busy || !pickedList.length,
                                        onClick: () => setConfirming(true),
                                      }, '清理选中')
                            )
                        )
                    )
                ),
                document.body
            );
        }

        function EntryButton() {
            const [open, setOpen] = react.useState(false);
            // 面板状态住在【常驻】的侧边栏入口里；菜单项与全局快捷键都经这座桥来开它。
            // ⚠️ 菜单项自己渲染面板是错的：菜单一关组件就卸载、state 丢失 ⇒ 点了没反应。
            const [pick, setPick] = react.useState('');
            react.useEffect(() => {
                openPanelBridge = (id) => { setPick(id || ''); setOpen(true); };
                return () => { if (openPanelBridge) openPanelBridge = null; };
            }, []);
            return react.createElement(react.Fragment, null,
                react.createElement('button', {
                    className: NS + '_btn',
                    type: 'button',
                    title: '清理会话文件（移到回收目录，可恢复）',
                    onClick: () => { setPick(''); setOpen(true); },
                }, '清理会话'),
                open ? react.createElement(Panel, {
                    onClose: () => { setOpen(false); setPick(''); },
                    initialPick: pick,
                    initialConfirming: !!pick,
                }) : null
            );
        }

        /** 垃圾桶图标（自己画，不依赖官方 primitive）。 */
        function TrashIcon() {
            return react.createElement('svg', {
                className: NS + '_miIcon', width: 14, height: 14, viewBox: '0 0 16 16',
                fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
                strokeLinecap: 'round', strokeLinejoin: 'round',
            }, react.createElement('path', { d: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.8 7v3.2M9.2 7v3.2' }));
        }

        /**
         * 会话行菜单里的条目（插槽 sidebar.workspaces.session.menu.item）。
         * props 由插槽给：{ sessionId, displayTitle, useMenuOpenState }。
         * ⚠️ useMenuOpenState 可能因官方版本差异而缺失 —— 用恒定的 fallback 保证【无条件调用】，
         *    否则违反 hooks 规则会直接崩掉整个菜单。
         */
        // ★ 官方 MenuItemButton 的 onSelect 是 `() => void`，【不带事件对象】
        //   ⇒ 拿不到 e.ctrlKey。所以自己跟踪修饰键状态（按住 Ctrl 点击 = 跳过二次确认）。
        //
        //   ⚠️ 状态必须挂在 window 上，【不能】用模块级变量：
        //   插件可能被加载多份（HMR / 强刷，Console 里见过三份 client apply()），
        //   而「注册监听的实例」与「渲染菜单项的实例」可能不是同一个 ——
        //   模块级变量各是各的 ⇒ 按 Ctrl 那边置了位，这边读到的还是 false（实测就是这个症状）。
        //   失焦时复位，否则 Alt+Tab 切走再回来状态会永远卡在按下。
        function ctrlIsDown() { return window.__scCtrlDown === true; }
        function trackModifiers() {
            // ★ 最可靠的一路：按下鼠标那一刻的 e.ctrlKey
            //   （2026-10-14 修 bug：用户"按住 Ctrl 点击仍要二次确认"）
            const mark = (e) => { window.__scCtrlDown = !!(e && e.ctrlKey); };
            const down = (e) => { if (e.key === 'Control') window.__scCtrlDown = true; };
            const up = (e) => { if (e.key === 'Control') window.__scCtrlDown = false; };
            const winBlur = () => { window.__scCtrlDown = false; };
            document.addEventListener('mousedown', mark, true);
            document.addEventListener('pointerdown', mark, true);
            window.addEventListener('keydown', down, true);
            window.addEventListener('keyup', up, true);
            //  ⚠️ window 上的 blur 监听【绝不能加 capture】：
            //     blur 不冒泡，但在【捕获阶段】会从 window 向下传到目标元素 ——
            //     加 capture 等于在监听"任何元素失焦"；而点击菜单项会让输入框失焦，
            //     于是刚置上的 Ctrl 状态被立刻清成 false ⇒ 永远走二次确认（实测症状）。
            //     不加 capture ⇒ 只接 window 自身的失焦，这才是我们要的语义。
            window.addEventListener('blur', winBlur);
            return () => {
                document.removeEventListener('mousedown', mark, true);
                document.removeEventListener('pointerdown', mark, true);
                window.removeEventListener('keydown', down, true);
                window.removeEventListener('keyup', up, true);
                window.removeEventListener('blur', winBlur);
            };
        }

        function MenuDeleteItem(props) {
            const sessionId = props.sessionId;
            // 一次性诊断：确认插槽到底给了哪些 props（尤其 useShortcuts 在不在）
            if (!MenuDeleteItem.logged) {
                MenuDeleteItem.logged = true;
                console.log('[session-tidy] 菜单项 props: ' + Object.keys(props).join(', '));
            }
            const useMenuOpen = react.useMemo(
                () => (typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState : () => [false, () => {}]),
                [props.useMenuOpenState]
            );
            const [, setMenuOpen] = useMenuOpen();
            // 官方做法：shortcut 由插槽 props 的 useShortcuts 取【用户实际绑定】的键位。
            // useMemo 固定引用 + 无条件调用 —— 条件调用 hook 会崩掉整个菜单。
            const useSc = react.useMemo(
                () => (typeof props.useShortcuts === 'function' ? props.useShortcuts : () => undefined),
                [props.useShortcuts]
            );
            const shortcut = useSc((rows) => (rows || []).find((r) => r.id === SHORTCUT_ID));
            // 一键移入回收目录 —— 不弹面板、不再要确认。
            // 分层原则：移入回收目录【可恢复】⇒ 一键；彻底删除（清空回收目录）才要确认。
            const [phase, setPhase] = react.useState('idle');   // idle | busy | done | failed
            const [errMsg, setErrMsg] = react.useState('');
            const [already, setAlready] = react.useState(false);
            const onClick = async () => {
                if (phase === 'busy' || phase === 'done') return;   // 忽略重复点击
                // 二次确认：鼠标直接点要确认（易误点）；
                // ★ 按住 Ctrl 再点 = 跳过确认，直接移入回收目录（2026-10-14 用户要求）。
                //   删除本身是可恢复的（移到 sessions-trash 而非 unlink），所以这个捷径是安全的。
                if (!ctrlIsDown() && (phase === 'idle' || phase === 'failed')) {
                    setErrMsg(''); setPhase('confirm'); return;
                }
                setPhase('busy');
                try {
                    const r = await api('/session-tidy/delete-one', { id: sessionId });
                    if (r && r.ok) {
                        if (r.already) setAlready(true);   // 文件本就不在（多半已删过）
                        // ★ 2026-10-14 追加：文件已移走 ⇒ 再走【官方归档】，让 host 状态立即更新。
                        //   动机（用户实测："怎么还在啊"）：删了文件但 host 内存状态不变 ⇒ 侧边栏照样
                        //   显示该会话，要重启 DSH 才干净。官方通道 uiWorkspace.archiveSession 会把
                        //   它移出活跃列表 ⇒ 列表【立刻】消失（host 侧随后还会把 archivedSessionIds 摘掉）。
                        //   顺序讲究：**先删文件、成功后才归档** —— 删除失败时不归档，会话仍留在列表里。
                        try {
                            if (typeof window.__scArchive === 'function') await window.__scArchive(sessionId);
                        } catch (e) {
                            console.warn('[session-tidy] 官方归档未成功（文件已删，列表要重启才更新）: ' + ((e && e.message) || e));
                        }
                        // ★ 2026-11-06：官方归档会把 id 塞回 archivedSessionIds（host 内存 + 磁盘写回），
                        //   再调一次 host 的 unregister 把归档里的该 id 摘掉 —— 否则归档列表留幽灵记录。
                        try { await api('/session-tidy/unregister', { id: sessionId }); } catch (e) { /* 非致命 */ }
                        setPhase('done');
                        setTimeout(() => { try { setMenuOpen(false); } catch (e) { /* 忽略 */ } }, 900);
                        // 不再自动刷新页面：那会打断用户正在进行的对话。
                        // 列表要等下次刷新才更新（会话列表来自 host 状态，删文件不会改它）。
                    } else {
                        setErrMsg((r && r.error) || '未移动');
                        setPhase('failed');
                    }
                } catch (e) {
                    setErrMsg((e && e.message) || String(e));
                    setPhase('failed');
                }
            };
            let label = '删除会话';
            if (phase === 'confirm') label = '确认删除？（' + (props.displayTitle || '此会话') + '）';
            else if (phase === 'busy') label = '删除中…';
            else if (phase === 'done') label = already ? '该会话已清理过 ✓' : '已移入回收目录 ✓';
            else if (phase === 'failed') label = '失败：' + errMsg;
            const tip = '移到回收目录（可恢复；置顶与运行中的会话会被拒绝）—— 按住 Ctrl 点击可跳过二次确认';
            return MenuItemButton
                ? react.createElement(MenuItemButton, {
                    danger: phase !== 'done',      // 官方危险行：error 色文字/图标 + danger hover 填充
                    icon: react.createElement(TrashIcon),
                    shortcut: shortcut,
                    onSelect: onClick,
                }, label)
                : react.createElement('button', {
                    type: 'button',
                    role: 'menuitem',
                    className: NS + '_mi ' + NS + '_miDanger',
                    title: tip,
                    onClick: onClick,
                }, react.createElement(TrashIcon), label);
        }

        function apply(ctx) {
            console.log('[session-tidy] client apply()');
            // 修饰键跟踪（Ctrl+点击跳过确认用）
            if (ctx && typeof ctx.effect === 'function') ctx.effect(trackModifiers);
            else trackModifiers();
            injectCss();
            // ★ 把官方归档动作挂到 window —— 插槽组件的 props 里没有 ctx，拿不到服务。
            //   uiWorkspace.archiveSession(id) 更新 host 状态 ⇒ 侧边栏立即移除该会话。
            //   能力检测：服务不在就置 null，调用方自动退化为"只删文件"。
            try {
                const ws = (ctx && typeof ctx.get === 'function') ? ctx.get('uiWorkspace') : null;
                window.__scArchive = (ws && typeof ws.archiveSession === 'function')
                    ? function (id) { return ws.archiveSession(id); }
                    : null;
                console.log('[session-tidy] 官方归档通道: ' + (window.__scArchive ? '✅ uiWorkspace.archiveSession 可用' : '⚠️ 不可用（删完列表要重启才更新）'));
            } catch (e) {
                window.__scArchive = null;
                console.log('[session-tidy] 官方归档通道探测失败: ' + ((e && e.message) || e));
            }

            // 快捷键注册已移除（2026-10-13）。
            // 原因：它删的是"主视图当前会话"——那正是用户正在对话的那个，方向完全错了；
            // 且 'shortcuts' 服务在客户端未必可用，声明 inject 会让整个插件去等它。
            // ⇒ 宁可不做，也不能删掉用户正在用的会话。
            // ① 会话行的 "..." 菜单（官方 slot；插件项排在 archive(400) 之后）
            try {
                ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
                    { name: 'sidebar.workspaces.session.menu.item', id: 'session-tidy.delete', order: 500 },
                    MenuDeleteItem
                ));
                console.log('[session-tidy] ✅ 菜单项已注册到 sidebar.workspaces.session.menu.item');
            } catch (e) {
                console.error('[session-tidy] 菜单项注册失败: ' + ((e && e.message) || e));
            }
            // ② 侧边栏底部的批量入口
            try {
                ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
                    { name: 'sidebar.footer.action', id: 'dsh-plugin-session-tidy', order: 90 },
                    EntryButton
                ));
                console.log('[session-tidy] ✅ 入口已注册到 sidebar.footer.action');
            } catch (e) {
                console.error('[session-tidy] 入口注册失败: ' + ((e && e.message) || e));
            }
        }

        exports.apply = apply;
        // 只声明 slots。曾经加过 'shortcuts'（为了注册快捷键），那会让插件去等一个
        // 未必存在的客户端服务 —— 风险大于收益，已回滚（2026-10-13）。
        exports.inject = ['slots'];
        return module.exports;
    },
});
