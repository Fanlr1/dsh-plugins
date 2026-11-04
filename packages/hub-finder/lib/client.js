// dsh-plugin-hub-finder -- client 侧
//
// 入口：【设置 → 插件 → 添加插件】菜单里的一项（官方插槽 plugins.add.actions）；
//       插件【详情页标题旁】显示来源标签（plugins.detail.badge：官方 / 自研 / 第三方）。
//
// ★ 样式参照 dshplugin/dsh-plugin-hub（同为第三方插件）。学到的五条：
//   ① 颜色先包一层 --hub-* 语义别名 → var(--dsw-alias-*, 字面量) 兜底，
//      声明在 :root,body[data-ds-dark-theme] ⇒ 暗色主题自动跟随。
//      （官方真名：--dsw-alias-bg-layer-1 / -border-l1 / -state-business-primary；我最初猜的四个全错。）
//   ② 浮层用父层 flex 居中（不用 left/top+translate）；z-index 998/999；高度固定避免跳变。
//   ③ ★ CSS 注入不可靠：宿主 HMR 会摘掉插件 <style>，模块缓存还持有旧 factory ⇒ factory 不重跑。
//      ⇒ ensureCss() 必须【比对内容】，只比对标签存在会被旧 style 挡住（这坑踩过三轮）。
//   ④ 结果条目用【卡片】（描边 + 圆角 + 悬停 + 120ms 过渡），不是分隔线列表。
//   ⑤ 按钮一律用官方 ui.Button —— 手写 border 的野按钮一眼就不原生。

window.__ModuleLoader__.load({
    id: 'dsh-plugin-hub-finder',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        let react = require('react');
        let ui = null;
        try { ui = require('@deepseek-ai/dsh-client-ui-primitives'); } catch (e) { ui = null; }
        let reactDom = null;
        try { reactDom = require('react-dom/client'); } catch (e) { reactDom = null; }

        const NS = 'hf';
        const CSS_ID = NS + '-css';
        const API = '/hub-finder/search';
        const DEBOUNCE_MS = 250;
        const PAGE_SIZE = 20;

        const TOKENS = [
            ':root,body[data-ds-dark-theme]{',
            '--hub-text-primary:var(--dsw-alias-label-primary,#1f2328);',
            '--hub-text-secondary:var(--dsw-alias-label-secondary,#6b7280);',
            '--hub-text-tertiary:var(--dsw-alias-label-tertiary,#8b93a1);',
            '--hub-bg-1:var(--dsw-alias-bg-layer-1,#fff);',
            '--hub-bg-2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));',
            '--hub-bg-hover:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));',
            '--hub-bg-btn:rgba(128,128,128,.12);',
            '--hub-border-1:var(--dsw-alias-border-l1,#eceef1);',
            '--hub-border-2:var(--dsw-alias-border-l2,#e5e7eb);',
            '--hub-border-input:var(--dsw-alias-input-border,rgba(107,114,128,.25));',
            '--hub-brand:var(--dsw-alias-state-business-primary,#4f6ef7);',
            '}',
        ].join('');

        const CSS = [
            '.' + NS + '_overlay{position:fixed;inset:0;z-index:998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38)}',
            '.' + NS + '_modal{width:780px;max-width:calc(100vw - 32px);height:min(620px,calc(100vh - 96px));display:flex;flex-direction:column;border-radius:10px;background:var(--hub-bg-1);border:1px solid var(--hub-border-2);box-shadow:0 12px 40px rgba(0,0,0,.24);overflow:hidden;color:var(--hub-text-primary);animation:' + NS + 'Fade 160ms ease-out}',
            '.' + NS + '_head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--hub-border-1);flex-shrink:0}',
            '.' + NS + '_title{font-size:14px;font-weight:600;line-height:20px;white-space:nowrap}',
            '.' + NS + '_input{flex:1;box-sizing:border-box;height:32px;padding:0 10px;font:inherit;font-size:13px;color:inherit;background:0 0;border:1px solid var(--hub-border-input);border-radius:8px;outline:none}',
            '.' + NS + '_input:focus{border-color:var(--hub-brand)}',
            '.' + NS + '_x{width:28px;height:28px;flex-shrink:0;background:0 0;border:none;border-radius:6px;cursor:pointer;color:var(--hub-text-tertiary);font-size:15px;line-height:1}',
            '.' + NS + '_x:hover{background:var(--hub-bg-hover)}',
            '.' + NS + '_stat{padding:8px 16px;font-size:12px;line-height:18px;color:var(--hub-text-tertiary);border-bottom:1px solid var(--hub-border-1);flex-shrink:0}',
            '.' + NS + '_list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:8px 10px;animation:' + NS + 'Fade 160ms ease-out}',
            '.' + NS + '_item{border:1px solid var(--hub-border-2);border-radius:8px;padding:10px 12px;background:var(--hub-bg-1);transition:border-color 120ms ease,background 120ms ease}',
            '.' + NS + '_item:hover{background:var(--hub-bg-2)}',
            '.' + NS + '_row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
            '.' + NS + '_star{font-size:12px;color:#e6a23c;font-variant-numeric:tabular-nums}',
            '.' + NS + '_repo{font-size:13px;font-weight:600;color:var(--hub-brand);text-decoration:none;overflow-wrap:anywhere}',
            '.' + NS + '_repo:hover{text-decoration:underline}',
            '.' + NS + '_tag{font-size:11px;line-height:16px;padding:1px 6px;border-radius:999px;background:var(--hub-bg-btn);color:var(--hub-text-tertiary)}',
            '.' + NS + '_desc{margin-top:4px;font-size:13px;line-height:20px;color:var(--hub-text-secondary)}',
            '.' + NS + '_feats{margin-top:4px;font-size:12px;line-height:18px;color:var(--hub-text-tertiary)}',
            '.' + NS + '_inst{margin-top:8px;display:flex;align-items:center;gap:8px}',
            '.' + NS + '_code{flex:1;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:18px;padding:4px 8px;border-radius:6px;background:var(--hub-bg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.' + NS + '_copy{flex-shrink:0;height:26px;padding:0 10px;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--hub-border-2);border-radius:6px;background:0 0;color:var(--hub-text-secondary)}',
            '.' + NS + '_copy:hover{background:var(--hub-bg-hover)}',
            '.' + NS + '_gh{color:var(--hub-text-tertiary);font-size:12px}',
            // 链接行：与安装命令【同款灰底框】，这样两行视觉一致；标签定宽保证两行框起点对齐。
            // 两行各有一个【定宽】标签（安装命令 / 仓库地址，均 4 字）⇒ 框起点对齐
            '.' + NS + '_rowlabel{flex-shrink:0;width:52px;font-size:11px;color:var(--hub-text-tertiary)}',
            // 与上一行（_inst）同形：同样的 gap 与 margin-top ⇒ 两行的框左右上下都对齐
            '.' + NS + '_linkrow{display:flex;align-items:center;gap:8px;margin-top:8px}',
            '.' + NS + '_linkurl{flex:1;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:18px;padding:4px 8px;border-radius:6px;background:var(--hub-bg-2);color:var(--hub-text-secondary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.' + NS + '_linkurl:hover{color:var(--hub-brand)}',
            '.' + NS + '_pager{flex-shrink:0;border-top:1px solid var(--hub-border-1)}',
            // ★ 2026-10-15 用户反馈：整栏要【居中】。
            //   之前用 space-between + margin-left:auto 把页码和跳转拆到两端，看着偏一边。
            //   现在：整行 flex 居中；页码组与「跳到/共N条」之间用较大 gap 分组。
            '.' + NS + '_pagerHost{display:flex;align-items:center;justify-content:center;gap:18px;padding:8px 12px;flex-wrap:wrap}',
            '.' + NS + '_pages{display:flex;align-items:center;gap:4px}',
            '.' + NS + '_pagerHost button{min-width:34px;justify-content:center}',
            '.' + NS + '_total{font-variant-numeric:tabular-nums}',
            '.' + NS + '_ellipsis{padding:0 4px;color:var(--hub-text-tertiary);font-size:12px}',
            '.' + NS + '_jump{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--hub-text-tertiary)}',
            '.' + NS + '_jump input{width:54px;height:28px;box-sizing:border-box;padding:0 6px;font:inherit;font-size:12px;color:var(--hub-text-primary);background:0 0;border:1px solid var(--hub-border-input);border-radius:8px;outline:none;text-align:center}',
            '.' + NS + '_jump input:focus{border-color:var(--hub-brand)}',
            '.' + NS + '_total{font-size:12px;color:var(--hub-text-tertiary);font-variant-numeric:tabular-nums}',
            '.' + NS + '_empty{padding:28px 16px;text-align:center;color:var(--hub-text-tertiary);font-size:13px}',
            // ★ 添加插件菜单里那一行的排版（照官方 .addMenuItem / .addMenuDescription）
            //   ⚠️ 2026-10-15 教训：重写本文件时漏掉过这三条 ⇒ 菜单项又挤成一行。
            //   改这个文件后【必须 grep 验证 '_add{' 存在】，光跑 node --check 看不出缺 CSS。
            '.' + NS + '_add{display:flex;flex-direction:column;gap:2px;white-space:normal}',
            '.' + NS + '_addtitle{font-size:13px;line-height:20px;color:var(--hub-text-primary)}',
            '.' + NS + '_adddesc{display:-webkit-box;max-height:36px;overflow:hidden;overflow-wrap:anywhere;font-size:12px;line-height:18px;color:var(--hub-text-secondary);-webkit-box-orient:vertical;-webkit-line-clamp:2}',
            '.' + NS + '_addbtn{display:block;width:100%;box-sizing:border-box;min-height:72px;padding:10px 12px;text-align:left;background:0 0;border:none;border-radius:8px;cursor:pointer;color:inherit;font:inherit}',
            '.' + NS + '_addbtn:hover{background:var(--hub-bg-hover)}',
            '@keyframes ' + NS + 'Fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
        ].join('');

        /** 幂等自愈：保证 DOM 里的样式就是当前这份（HMR 后旧 style 还在 ⇒ 必须比内容）。 */
        function ensureCss() {
            if (typeof document === 'undefined') return;
            const full = TOKENS + CSS;
            let tag = document.getElementById(CSS_ID);
            if (!tag) {
                tag = document.createElement('style');
                tag.id = CSS_ID;
                tag.dataset.plugin = 'dsh-plugin-hub-finder';
                document.head.appendChild(tag);
            }
            if (tag.textContent !== full) tag.textContent = full;
        }

        let overlay = null;
        let timer = null;
        let pagerRoot = null;

        function el(tagName, className, text) {
            ensureCss();
            const n = document.createElement(tagName);
            if (className) n.className = className;
            if (text !== undefined && text !== null) n.textContent = String(text);
            return n;
        }

        function closePanel() {
            if (timer) { clearTimeout(timer); timer = null; }
            if (pagerRoot) { try { pagerRoot.unmount(); } catch (e) { /* 忽略 */ } pagerRoot = null; }
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
            overlay = null;
            document.removeEventListener('keydown', onEsc, true);
        }

        function onEsc(e) { if (e.key === 'Escape') closePanel(); }

        const view = { q: '', offset: 0, matched: 0, pageSize: PAGE_SIZE };

        function renderItems(listEl, statEl, data) {
            statEl.textContent = '匹配 ' + data.matched + ' 条（索引共 ' + data.total + ' 条 · 缓存 ' + data.ageMin + ' 分钟前）';
            listEl.textContent = '';
            listEl.style.animation = 'none';
            void listEl.offsetHeight;
            listEl.style.animation = '';
            if (!data.count) {
                const hint = data.githubFallback
                    ? ('索引未收录；GitHub 地址仍可拼出：' + data.githubFallback)
                    : '没找到。换个中文关键词试试（数据里的简介本身就是中文），或直接粘 owner/repo 精确反查。';
                listEl.appendChild(el('div', NS + '_empty', hint));
                return;
            }
            for (const it of data.items) {
                const box = el('div', NS + '_item');
                const row = el('div', NS + '_row');
                row.appendChild(el('span', NS + '_star', '★ ' + it.stars));
                const a = el('a', NS + '_repo', it.repo);
                a.href = it.url;
                a.target = '_blank';
                a.rel = 'noreferrer noopener';
                row.appendChild(a);
                if (it.category) row.appendChild(el('span', NS + '_tag', it.category));
                if (it.version) row.appendChild(el('span', NS + '_tag', it.version));
                if (it.updated) row.appendChild(el('span', NS + '_tag', it.updated));
                box.appendChild(row);
                if (it.desc) box.appendChild(el('div', NS + '_desc', it.desc));
                if (it.features && it.features.length) box.appendChild(el('div', NS + '_feats', it.features.join(' · ')));
                // 底部【两行】：
                //   第 1 行 安装命令 + 复制按钮
                //   第 2 行 GitHub 仓库地址（URL 明文，可看可选中可点）+ 复制按钮
                // ★ 2026-10-15 用户反馈：两个按钮挤同一行别扭 ⇒ 拆成两行，链接单独占一行并显示明文 URL。
                function mkCopy(label, text, title) {
                    const b = el('button', NS + '_copy', label);
                    b.type = 'button';
                    if (title) b.title = title;
                    b.addEventListener('click', () => {
                        const done = () => { b.textContent = '已复制'; setTimeout(() => { b.textContent = label; }, 1200); };
                        try {
                            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
                            else done();
                        } catch (e) { done(); }
                    });
                    return b;
                }
                if (it.install) {
                    const inst = el('div', NS + '_inst');
                    inst.appendChild(el('span', NS + '_rowlabel', '安装命令'));
                    inst.appendChild(el('code', NS + '_code', it.install));
                    inst.appendChild(mkCopy('复制', it.install, '复制安装命令\n' + it.install));
                    box.appendChild(inst);
                }
                if (it.url) {
                    // 两行各带一个【定宽】标签 —— 既说清哪行是什么，又保证两行的框起点对齐。
                    const row = el('div', NS + '_linkrow');
                    row.appendChild(el('span', NS + '_rowlabel', '仓库地址'));
                    const a2 = el('a', NS + '_linkurl', it.url);
                    a2.href = it.url;
                    a2.target = '_blank';
                    a2.rel = 'noreferrer noopener';
                    a2.title = it.url;   // 框内过长会被省略号截断，悬停看全
                    row.appendChild(a2);
                    row.appendChild(mkCopy('复制', it.url, '复制 GitHub 仓库地址'));
                    box.appendChild(row);
                }
                listEl.appendChild(box);
            }
        }

        function looksLikeRepo(q) {
            return /^[^\s]+\/[^\s]+$/.test(q) || /github\.com|dsh-plugin\.org/.test(q);
        }

        /**
         * 页码窗口：等距 size 个，跟着当前页滑动。
         * ★ 2026-10-15 用户定的规则：底部固定显示 5 个（当前页 ±2）；
         *   翻页后整体平移；【不钉住首页/末页】—— 直达首尾交给 « / » 两个按钮。
         *   ⇒ 没有省略号，页码永远等距，视觉上不会出现「1 … 4 5 [6] 7 8 … 38」那种跳跃。
         */
        function pageWindow(cur, total, size) {
            const n = Math.min(size, total);
            let start = Math.max(1, cur - Math.floor(n / 2));
            if (start + n - 1 > total) start = Math.max(1, total - n + 1);
            const out = [];
            for (let p = start; p <= start + n - 1; p++) out.push(p);
            return out;
        }

        function Pager(props) {
            const Button = ui && ui.Button;
            const pages = Math.max(1, Math.ceil(props.matched / props.pageSize));
            const cur = Math.floor(props.offset / props.pageSize) + 1;
            const [draft, setDraft] = react.useState('');
            const go = props.onGo;
            function mk(label, target, disabled, key, isCur) {
                if (Button) {
                    return react.createElement(Button, {
                        key: key, size: 'sm', variant: isCur ? 'primary' : 'ghost', disabled: disabled,
                        onClick: function () { go(target); },
                    }, label);
                }
                return react.createElement('button', {
                    key: key, type: 'button', className: NS + '_copy', disabled: disabled,
                    onClick: function () { go(target); },
                }, label);
            }
            const lastOff = Math.max(0, (pages - 1) * props.pageSize);
            const kids = [
                mk('«', 0, props.offset <= 0, 'first', false),
                mk('上一页', Math.max(0, props.offset - props.pageSize), props.offset <= 0, 'prev', false),
            ];
            // 等距 5 个（当前页居中，边界处整体平移；总数不足 5 页时自然少）
            pageWindow(cur, pages, 5).forEach(function (v) {
                kids.push(mk(String(v), (v - 1) * props.pageSize, false, 'p' + v, v === cur));
            });
            kids.push(mk('下一页', props.offset + props.pageSize, props.offset + props.pageSize >= props.matched, 'next', false));
            kids.push(mk('»', lastOff, props.offset >= lastOff, 'last', false));
            return react.createElement('div', { className: NS + '_pagerHost' },
                react.createElement('span', { className: NS + '_pages' }, kids),
                react.createElement('span', { className: NS + '_jump' }, '跳到',
                    react.createElement('input', {
                        value: draft,
                        inputMode: 'numeric',
                        placeholder: String(cur),
                        onChange: function (e) { setDraft(String(e.target.value).replace(/[^0-9]/g, '')); },
                        onKeyDown: function (e) {
                            if (e.key !== 'Enter') return;
                            const n = Math.min(pages, Math.max(1, Number(draft) || 1));
                            setDraft('');
                            go((n - 1) * props.pageSize);
                        },
                    }), '页'),
                react.createElement('span', { className: NS + '_total' }, '共 ' + props.matched + ' 条'));
        }

        async function runSearch(input, listEl, statEl, paint) {
            const q = (input ? input.value.trim() : view.q);
            if (!q) {
                statEl.textContent = '输入中文关键词开始搜索（例：图表 · 终端 · 余额 · 记忆）';
                listEl.textContent = '';
                view.q = ''; view.offset = 0; view.matched = 0;
                if (paint) paint();
                return;
            }
            if (q !== view.q) { view.q = q; view.offset = 0; }
            statEl.textContent = '搜索中…';
            try {
                const url = API + (looksLikeRepo(q)
                    ? ('?repo=' + encodeURIComponent(q))
                    : ('?q=' + encodeURIComponent(q) + '&limit=' + view.pageSize + '&offset=' + view.offset));
                const res = await fetch(url, { credentials: 'same-origin' });
                const data = await res.json();
                if (!data || !data.ok) { statEl.textContent = '查询失败：' + ((data && data.error) || res.status); return; }
                view.matched = Number(data.matched) || 0;
                renderItems(listEl, statEl, data);
                if (paint) paint();
            } catch (e) { statEl.textContent = '查询失败：' + ((e && e.message) || e); }
        }

        function openPanel() {
            ensureCss();
            if (overlay) { const i = overlay.querySelector('.' + NS + '_input'); if (i) i.focus(); return; }
            overlay = el('div', NS + '_overlay');
            const modal = el('div', NS + '_modal');
            const head = el('div', NS + '_head');
            head.appendChild(el('span', NS + '_title', '社区插件市场'));
            const input = el('input', NS + '_input');
            input.type = 'text';
            input.placeholder = '中文关键词，或 owner/repo、dsh-plugin.org 链接';
            const x = el('button', NS + '_x', '✕');
            x.type = 'button';
            x.title = '关闭（Esc）';
            head.appendChild(input);
            head.appendChild(x);
            const stat = el('div', NS + '_stat', '输入中文关键词开始搜索（例：图表 · 终端 · 余额 · 记忆）');
            const list = el('div', NS + '_list');
            const pagerWrap = el('div', NS + '_pager');
            const pagerHost = el('div', NS + '_pagerHost');
            pagerWrap.appendChild(pagerHost);
            pagerWrap.hidden = true;
            modal.appendChild(head);
            modal.appendChild(stat);
            modal.appendChild(list);
            modal.appendChild(pagerWrap);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            function paint() {
                pagerWrap.hidden = view.matched <= view.pageSize;
                if (!pagerRoot) return;
                pagerRoot.render(react.createElement(Pager, {
                    offset: view.offset, pageSize: view.pageSize, matched: view.matched,
                    onGo: (off) => {
                        view.offset = Math.max(0, off);
                        runSearch(input, list, stat, paint);
                        list.scrollTop = 0;
                    },
                }));
            }
            if (reactDom && reactDom.createRoot && ui && ui.Button) {
                pagerRoot = reactDom.createRoot(pagerHost);
                paint();
            } else {
                pagerWrap.hidden = true;
                console.warn('[hub-finder] 无 react-dom/Button，翻页条不显示');
            }

            x.addEventListener('click', closePanel);
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePanel(); });
            input.addEventListener('input', () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => { runSearch(input, list, stat, paint); }, DEBOUNCE_MS);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { if (timer) clearTimeout(timer); runSearch(input, list, stat, paint); }
            });
            document.addEventListener('keydown', onEsc, true);
            input.focus();
        }

        // ---------------- 来源标签（官方 / 自研 / 第三方） ----------------
        let selfNames = null;
        async function loadSelfNames() {
            if (selfNames) return selfNames;
            try {
                const r = await fetch('/hub-finder/self-plugins', { credentials: 'same-origin' });
                const j = await r.json();
                selfNames = new Set((j && Array.isArray(j.names)) ? j.names : []);
            } catch (e) { selfNames = new Set(); }
            return selfNames;
        }

        function TypeBadge(props) {
            const subj = props && props.subject;
            const pkg = (subj && subj.kind === 'bundle') ? subj.pkg : null;
            const name = (pkg && pkg.name) || '';
            const official = !!(pkg && pkg.official) || /^@deepseek-ai\//.test(name);
            const [state, setState] = react.useState(official ? 'official' : null);
            react.useEffect(() => {
                if (!name || official) return undefined;
                let alive = true;
                loadSelfNames().then(function (set) { if (alive) setState(set.has(name) ? 'self' : 'third'); });
                return function () { alive = false; };
            }, [name, official]);
            if (!state) return null;
            const label = state === 'official' ? '官方' : (state === 'self' ? '自研' : '第三方');
            const Tag = ui && ui.Tag;
            if (Tag) return react.createElement(Tag, { tone: state === 'official' ? 'info' : 'outline' }, label);
            return react.createElement('span', { className: NS + '_tag' }, label);
        }

        function HubMenuItem(props) {
            const onDismiss = (props && props.onDismiss) || function () {};
            const MenuItemButton = ui && ui.MenuItemButton;
            const Icon = ui && (ui.IconSearchOutlineRegular || ui.IconBrowseOutlineRegular || ui.IconBrowseOutlineMedium);
            const body = react.createElement('span', { className: NS + '_add' },
                react.createElement('span', { className: NS + '_addtitle' }, '搜索社区插件'),
                react.createElement('span', { className: NS + '_adddesc' }, '按中文关键词搜索，直达 GitHub 地址'));
            const go = () => { try { onDismiss(); } catch (e) { /* 忽略 */ } openPanel(); };
            if (MenuItemButton) {
                return react.createElement(MenuItemButton, {
                    icon: Icon ? react.createElement(Icon, { size: 14 }) : undefined,
                    onSelect: go,
                }, body);
            }
            return react.createElement('button', { type: 'button', className: NS + '_addbtn', onClick: go }, body);
        }

        function apply(ctx) {
            console.log('[hub-finder] client apply()');
            ensureCss();
            try {
                if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
                    ctx.slots.inject('plugins.add.actions', () => ctx.slots.register(
                        { name: 'plugins.add.actions', id: 'hub-finder.add', order: 85 }, HubMenuItem));
                    console.log('[hub-finder] ✅ 已注册到「添加插件」菜单');
                    ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register(
                        { name: 'plugins.detail.badge', id: 'hub-finder.type', order: 85 }, TypeBadge));
                    console.log('[hub-finder] ✅ 已注册来源标签（plugins.detail.badge）');
                }
            } catch (e) { console.error('[hub-finder] 注册失败: ' + ((e && e.message) || e)); }
            if (ctx && typeof ctx.effect === 'function') {
                ctx.effect(() => () => { closePanel(); console.log('[hub-finder] 已卸载'); });
            }
        }

        exports.apply = apply;
        exports.inject = ['slots'];
        return module.exports;
    },
});
