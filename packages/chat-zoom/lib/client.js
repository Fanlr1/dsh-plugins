// dsh-plugin-chat-zoom -- client 侧
//
// 需求（2026-10-14 用户提）：Ctrl + 滚轮缩放【对话区】，不要缩放整个界面。
//
// ★ 2026-10-14 二次修正（用户反馈：只是缩小范围、让空白区域变多）：
//   只把 zoom 加在容器上【不是浏览器语义】—— 那只是"等比缩小一整块"：
//     · 官方对话列宽是固定 px（--dsh-chat-content-width = clamp(680px, 列宽*0.64, 920px)，
//       原文：ui-conversation/src/client/skeleton/ConversationRoot.module.css L384-388）
//       ⇒ zoom 把它一起缩小 ⇒ 列变窄、两侧留白变多，而每行字数【不变】；
//     · zoom 还让容器【自身占位】变成 CSS 尺寸 x z ⇒ 四周留白。
//   浏览器整页缩放正好相反：可用 CSS 宽度变大、字号变小 ⇒ 每行字更多、同屏行数更多。
//   ⇒ 现在三件事一起做（见 applyZoom）：
//     ① 内容宽度轴【除以 z】 —— 列宽物理尺寸不变 ⇒ 字小了但列不窄 ⇒ 每行字数变多
//     ② zoom 本体            —— 字号/行高/间距等比缩小 ⇒ 同屏行数变多
//     ③ 容器宽高【除以 z】    —— 抵消占位缩水，对话区仍填满原区域（无留白）
//
// 历史做法（已废弃）：改 body 上的字号变量 —— 会连底栏一起变，且正文不消费它。
//
// ★ 为什么要 capture + passive:false：
//   wheel 默认是 passive 的，不 preventDefault 的话 Electron 可能先做整页缩放。

window.__ModuleLoader__.load({
    id: 'dsh-plugin-chat-zoom',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        let react = require('react');   // 宿主提供（用于侧边栏缩放控件）
        const NS = 'cz';

        const CSS = [
            // ★ 对齐官方顶栏按钮（ui-primitives 的 Button：.button 基类 + .sm 紧凑尺寸）：
            //   12px / line-height 18px / height 28px / padding 0 10px / radius-sm ——
            //   与旁边的「PTC 模式」等官方件同一尺寸（2026-10-14 按官方 CSS 逐条照抄）。
            '.' + NS + '_ctl{display:inline-flex;align-items:center;gap:2px}',
            '.' + NS + '_cbtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
            'background:0 0;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;',
            'font-size:12px;line-height:18px;height:28px;padding:0 8px;',
            'color:var(--dsw-alias-label-tertiary)}',
            '.' + NS + '_cbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
            '.' + NS + '_cpct{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
            'background:0 0;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;',
            'font-size:12px;line-height:18px;height:28px;padding:0 6px;',
            'color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
            '.' + NS + '_cpct:hover{color:var(--dsw-alias-label-secondary)}',
        ].join('\n');

        function injectCss() {
            const id = 'dsh-plugin-chat-zoom/client.css';
            if (document.getElementById(id)) return;
            const tag = document.createElement('style');
            tag.id = id;
            tag.setAttribute('data-plugin-css', id);
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        const KEY = 'dsh-plugin-chat-zoom:scale';
        const MIN = 0.6;
        const MAX = 2.0;
        const STEP = 0.05;
        // ★ 2026-10-14 追加：对话列【基础宽度】倍率（用户反馈"白边还是很多，会话栏改大点"）
        //   官方默认列宽 = clamp(680px, 列宽*0.64, 920px) ⇒ 窗口一宽，上限就卡在 920px，两侧全是白。
        //   官方自带的解法是【拖两侧 10px 宽的隐形手柄】（ConversationWidthControls.tsx）：
        //   它把偏好写进 localStorage['dsh.conversation.contentWidth']，上限是"列宽 - 176px"（比 920 宽得多）。
        //   这里用倍率直接放大官方那条轴的结果，和官方手柄【不冲突】——
        //   手柄设的 --dsh-chat-user-width 也在同一表达式里，会被同样乘上 W。
        //   ⚠️ 列宽最终仍受父容器宽度约束 ⇒ W 调大只会吃掉白边，不会横向溢出。
        const WKEY = 'dsh-plugin-chat-zoom:width';
        const WMIN = 1.0;
        const WMAX = 1.8;
        const WSTEP = 0.05;
        const WDEFAULT = 1.25;
        /**
         * ★ 官方内容宽度轴的【原式】（逐字抄自 ConversationRoot.module.css L384-388），
         *   只把【结果】除以 z、再乘宽度倍率 W —— 缩放时列宽物理尺寸不变，字却变小了（每行字数变多）；
         *   W 则直接放大基础列宽（吃白边）。
         *     --dsh-chat-content-width: var(--dsh-chat-user-width,
         *         clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px));
         *     --dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px);
         *   · 在【缩放目标元素上】重定义 ⇒ 只作用于对话区子树，不动侧栏/顶栏；
         *   · --dsh-conversation-column-width 由官方 JS 实时发布（列宽 px）⇒ 窗口变化自动跟随；
         *   · 用户若用官方宽度手柄设过 --dsh-chat-user-width，也在同一表达式里被除以 z。
         *   ⚠️ 这是与官方 CSS 的【唯一耦合点】：官方改这几个常数，这里要同步。
         *      （applyZoom 会先确认该变量确实存在才动手，不存在就整段跳过。）
         */
        const AXIS_TPL = 'calc(var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px)) / @Z@ * @W@)';
        // 32px 这个常数也要除以 z，否则 composer 卡宽 = (列宽/z + 32) * z = 列宽 + 32z，比原来窄
        const COMPOSER_TPL = 'calc(var(--dsh-chat-content-width) + 32px / @Z@)';

        function clamp(v) { return Math.min(MAX, Math.max(MIN, v)); }
        function readSaved() {
            try {
                const v = parseFloat(localStorage.getItem(KEY) || '1');
                return Number.isFinite(v) ? clamp(v) : 1;
            } catch (e) { return 1; }
        }
        let scale = readSaved();

        function readSavedW() {
            try {
                const v = parseFloat(localStorage.getItem(WKEY) || String(WDEFAULT));
                return Number.isFinite(v) ? Math.min(WMAX, Math.max(WMIN, v)) : WDEFAULT;
            } catch (e) { return WDEFAULT; }
        }
        let width = readSavedW();

        function textVolume(el) {
            // 用 textContent：innerText 会强制布局，全文档扫描时慢到不可用
            try { return ((el.textContent || '') + '').length; } catch (e) { return 0; }
        }

        /**
         * 找对话区容器。
         * ★ 前两版都栽在「相对锚定」上（以 composer 为锚往上找兄弟）：
         *   v1 取第一个命中 → 只罩住「思考」折叠块；
         *   v2 取最后一个命中 → 只罩住状态行「已完成 · 用时」，正文全没动。
         *   ⇒ 正文根本不在那条兄弟链上，相对锚定这条路是错的。
         * 现在改为【绝对判据】：全文扫描，取「文本量最大 + 可滚动 + 够宽」的容器。
         *   · 够宽（> 视口 40%）用来排除侧边栏（约 260px，占比很小）
         *   · 可滚动加权，因为消息列表一定是滚动容器
         *   · 排除宽高都接近视口的「整个 app 壳」
         *   · ★ 排除【包含输入框】的容器 —— 它们把 composer 与状态栏也圈在里面，
         *     会连底栏一起缩放。这条是最后的胜负手：scrollBody 与 centerCol 的
         *     评分只差几十，靠评分分不开，但「含不含 composer」是硬判据。
         * 全程不看类名（CSS Modules 哈希会变）。
         */
        // ★ 缓存必须和正常返回值【同类型】：曾经这里存的是元素、正常路径返的是对象，
        //   于是缓存命中后 hit.root 是 undefined ⇒ target.style 抛错 ⇒ 滚轮整个失效。
        let cachedInfo = null;
        let cachedAt = 0;

        function findChatRoot(force) {
            const now = Date.now();
            if (!force && cachedInfo && cachedInfo.root && cachedInfo.root.isConnected && now - cachedAt < 5000) return cachedInfo;
            const vw = window.innerWidth, vh = window.innerHeight;
            // 输入框（官方唯一的 contenteditable）—— 用来判定「这个容器是不是太大了」
            const composerEd = document.querySelector('[contenteditable="true"]');
            let best = null, bestScore = 0;
            const tops = [];
            const all = document.querySelectorAll('div,main,section,article');
            for (const el of all) {
                const vol = textVolume(el);
                if (vol < 500) continue;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (r.width < vw * 0.4 || r.height < vh * 0.2) continue;              // 太窄/太矮（侧边栏等）
                if (r.width > vw * 0.95 && r.height > vh * 0.95) continue;            // 整个 app 壳
                const scrollable = el.scrollHeight > el.clientHeight + 20;
                // 2026-10-17（DSH rc.2）：原来这条是「含输入框就排除」，新版把 composer
                // 移进了滚动容器 —— 实测 centerCol / root / body / scrollBody 全都 contains
                // 输入框，于是唯一正确的目标被一并排掉，findChatRoot 返回 null、退回全局缩放。
                // 改为：含输入框【且不可滚动】才排除（那才是把底栏圈进来的壳）。
                if (composerEd && el.contains(composerEd) && !scrollable) continue;
                const score = vol * (scrollable ? 2 : 1);
                tops.push({ el: el, vol: vol, w: Math.round(r.width), h: Math.round(r.height), sc: scrollable, score: score });
                if (score > bestScore) { bestScore = score; best = el; }
            }
            tops.sort((a, b) => b.score - a.score);
            cachedAt = now;
            if (!best) { cachedInfo = null; return null; }
            const br = best.getBoundingClientRect();
            cachedInfo = {
                root: best,
                vol: textVolume(best),
                w: Math.round(br.width),
                h: Math.round(br.height),
                scrollable: best.scrollHeight > best.clientHeight + 20,
                cls: typeof best.className === 'string' ? best.className : '(非字符串)',
                top: tops.slice(0, 3).map((t) => t.vol + '字 ' + t.w + 'x' + t.h + (t.sc ? ' 可滚' : '')),
            };
            return cachedInfo;
        }

        let probed = null;

        // 上一次的缩放目标：换目标时要把旧的还原
        let lastTarget = null;
        // 上一次落地的补偿态势（诊断用）：如 "wh,axis"
        let lastMode = '';

        /** 去掉目标上的【全部】内联覆盖（换目标、复位、以及测量自然尺寸前都要清干净）。 */
        function clearZoom(root) {
            if (!root) return;
            try {
                root.style.removeProperty('--dsh-chat-content-width');
                root.style.removeProperty('--dsh-composer-card-max-width');
                root.style.zoom = '';
                root.style.width = '';
                root.style.height = '';
                root.style.flexBasis = '';
                root.style.flexGrow = '';
                root.style.flexShrink = '';
                delete root.dataset.czApplied;   // 同步让 ensureApplied 的判据失效
            } catch (e) { /* 忽略 */ }
        }

        /**
         * ★ 缩放本体 = 浏览器缩放的等价物，并且只作用于对话区子树。
         *   顺序很重要：先清干净 → 测自然尺寸 → 再逐项落地。
         *   （清-测-写全在同一帧内同步完成，浏览器不会画出中间态。）
         */
        function applyZoom(root, z) {
            if (!root) return 0;
            clearZoom(root);                                   // 归零，才能测到 zoom=1 的自然尺寸
            const zs = String(z);
            const ws = String(width);
            // ★ 只调宽度（z=1）时也要落地 —— 这正是"白边很多、会话栏想改大"的那个诉求
            if (z === 1 && width === 1) { lastMode = ''; return 1; }

            // ① 官方宽度轴是否在位（不在位就整段跳过，绝不凭空造变量）
            let hasAxis = false;
            try {
                hasAxis = !!(getComputedStyle(root).getPropertyValue('--dsh-chat-content-width') || '').trim();
            } catch (e) { /* 忽略 */ }

            // ② 自然尺寸 + 父容器尺寸（给 ④ 的补偿量用）
            let nat = null;
            try {
                const r = root.getBoundingClientRect();
                nat = { w: r.width, h: r.height, parent: root.parentElement };
            } catch (e) { /* 忽略 */ }

            if (hasAxis) {
                try {
                    // /z 保列宽物理不变；* W 放大基础列宽（吃白边）
                    root.style.setProperty('--dsh-chat-content-width', AXIS_TPL.split('@Z@').join(zs).split('@W@').join(ws));
                    root.style.setProperty('--dsh-composer-card-max-width', COMPOSER_TPL.split('@Z@').join(zs));
                } catch (e) { /* 忽略 */ }
            }

            // ③ zoom 本体（字号 / 行高 / 间距等比缩小）—— 纯宽度调节时不动它
            if (z !== 1) {
                try { root.style.zoom = zs; } catch (e) { return 0; }
            }

            // ④ 几何补偿：zoom 会让元素【物理占位】变成 CSS 尺寸 x z ⇒ 不补就是四周留白。
            //    只在"原本就填满父容器"时补偿（差 4px 内视为填满，容 margin / 滚动条误差）；
            //    用百分比表达式而不是 px 定值 ⇒ 窗口缩放时自动跟随。
            //    ⚠️ 只有 z≠1 才需要补 —— 纯宽度调节不改变容器占位。
            let mode = (width !== 1) ? ('W' + Math.round(width * 100)) : '';
            if (z !== 1 && nat && nat.parent) {
                try {
                    // ★ 参照物：沿父链找【第一个真有尺寸】的祖先 —— Console 实测对话区的直接父
                    //   可能是 0x0 的包装层（父=0x0），拿它当基准会把补偿算错。
                    let ref = nat.parent, pr = ref.getBoundingClientRect(), hops = 0;
                    while ((pr.width < 8 || pr.height < 8) && ref.parentElement && hops < 4) {
                        ref = ref.parentElement; pr = ref.getBoundingClientRect(); hops++;
                    }
                    // 参照物是不是 flex 容器、主轴朝哪 —— 决定用 width/height 还是 flex-basis
                    let pcs = null;
                    try { pcs = getComputedStyle(ref); } catch (e) { /* 忽略 */ }
                    const dir = (pcs && /flex/.test(pcs.display)) ? (pcs.flexDirection || 'row') : '';
                    const fix = (natural, parentLen) => {
                        const slack = Math.max(0, parentLen - natural);   // 原本的 margin / 间隙
                        return 'calc(100% / ' + zs + ' - ' + (Math.round((slack / z) * 100) / 100) + 'px)';
                    };
                    // ★ flex item 的主轴尺寸由 flex-grow/shrink 重新分配，光写 width/height 会被无视
                    //   （.scrollBody 就是 flex:1 的列滚动容器）⇒ 主轴必须连 flex-basis 一起钉死。
                    const pin = (expr) => {
                        root.style.flexBasis = expr;
                        root.style.flexGrow = '0';
                        root.style.flexShrink = '0';
                    };
                    // ★★ 判据必须是"原本就【接近】父容器尺寸"，绝不能用 大于等于 ！
                    //   实测教训（2026-10-14 用户："缩放超过 100% 后输入框会消失 / 跑到下面"）：
                    //   锚定到的是 UkRYvG_viewArea，它的高度是【内容自然高度】(7564px)，远大于
                    //   滚动容器(751px)。拿"元素高 大于等于 父高"去判"填满父容器"必然误判成立，
                    //   于是给它硬设 height: calc(100%/z) ⇒ 内容区被压成父高 ⇒ 内容溢出、
                    //   把底部的输入框挤走。宽度那侧恰好同宽(1177 vs 1181)所以一直是对的。
                    //   容差 = max(8px, 父尺寸的 2%)，覆盖 margin / 滚动条 / 亚像素误差。
                    const near = (natural, parentLen) => Math.abs(natural - parentLen) <= Math.max(8, parentLen * 0.02);
                    if (near(nat.w, pr.width)) {
                        const w = fix(nat.w, pr.width);
                        root.style.width = w;
                        if (dir === 'row' || dir === 'row-reverse') pin(w);
                        mode += 'w';
                    }
                    if (near(nat.h, pr.height)) {
                        const h = fix(nat.h, pr.height);
                        root.style.height = h;
                        if (dir === 'column' || dir === 'column-reverse') pin(h);
                        mode += 'h';
                    }
                    // 复测：补过头（比父还大）就撤销该轴，宁可留白也不许横向/纵向溢出
                    const rr2 = root.getBoundingClientRect();
                    if (rr2.width > pr.width + 2) { root.style.width = ''; root.style.flexBasis = ''; root.style.flexGrow = ''; root.style.flexShrink = ''; mode = mode.replace('w', ''); }
                    if (rr2.height > pr.height + 2) { root.style.height = ''; mode = mode.replace('h', ''); }
                } catch (e) { /* 忽略 */ }
            }
            lastMode = (mode || '无几何补偿') + (hasAxis ? ',axis' : '');
            try { root.dataset.czApplied = zs + '/' + ws; } catch (e) { /* 忽略 */ }
            return 1;
        }

        /**
         * ★ 机制：`zoom` —— 浏览器原生缩放，**同步渲染、零遍历** ⇒ 实时跟手。
         *
         *   演进过程（都实测过）：
         *   ① CSS 变量（body 上）      → 底栏一起变
         *   ② CSS 变量（对话容器上）   → 正文根本不消费它，只有次要文本变
         *   ③ zoom（锚点错时）         → 选中含 composer 的容器 ⇒ 整页变大
         *   ④ 逐元素 font-size         → 能对，但每格遍历 6000+ 元素 + 逐个 getComputedStyle
         *                                （强制样式重算）⇒ 必须 80ms 节流 ⇒ 表现是【一跳一跳】
         *   ⑤ **zoom（锚点修正后）**   → ✅ 回到它，这次只圈对话区，且同步渲染
         *
         *   ③ 失败的原因是【锚点】而不是 zoom 本身 —— 那时靠评分选容器，会漂到含
         *   composer 的 centerCol。现在有硬判据（el.contains(输入框) 直接跳过）⇒ 可以放心用。
         */
        function applyFonts() {
            const hit = findChatRoot();
            probed = hit;
            const root = (hit && hit.root) ? hit.root : null;
            // 探不到就什么都不做（绝不用 body 兜底 —— 那等于把整页拉进来）
            if (!root) return 0;
            if (lastTarget && lastTarget !== root) clearZoom(lastTarget);
            lastTarget = root;
            return applyZoom(root, scale);
        }

        /** zoom 是同步的，不需要节流 —— 直接调，保证跟手（曾经 80ms 节流导致"一跳一跳"）。 */
        function applyScale() {
            applyFonts();
        }

        /**
         * ★ 为什么需要它：会话切换后缩放会失效（2026-10-14 用户发现「只在当前会话生效」）。
         *   原因：DSH 会【重建】对话区 DOM ⇒ 我加 zoom 的那个元素被换掉，新元素没有 zoom。
         *
         *   性能取舍：MutationObserver 在长对话里触发极频繁，所以回调先做最廉价的判断 ——
         *   目标仍在文档且 zoom 值正确就直接返回；只有真的失效才重跑全文扫描。
         *   再加 200ms 防抖，避免会话切换那一瞬被触发多次。
         */
        let domTimer = null;
        let observer = null;

        function ensureApplied() {
            // 判据用 dataset 记的"已应用组合"(缩放/宽度) —— 比盯内联 zoom 可靠：
            // 复位时 zoom 是空串、纯宽度调节时压根不写 zoom，旧判据两种情况都会误判"失效"。
            if (lastTarget && lastTarget.isConnected
                && lastTarget.dataset.czApplied === (String(scale) + '/' + String(width))) return;
            applyFonts();
        }

        function observeDom() {
            if (observer || typeof MutationObserver !== 'function') return () => { /* 无需清理 */ };
            observer = new MutationObserver(() => {
                if (domTimer) return;
                domTimer = setTimeout(() => { domTimer = null; ensureApplied(); }, 200);
            });
            observer.observe(document.body, { childList: true, subtree: true });
            return () => {
                if (observer) { observer.disconnect(); observer = null; }
                if (domTimer) { clearTimeout(domTimer); domTimer = null; }
            };
        }

        // ★ 曾经这里接管 Ctrl+0 做「恢复 100%」—— 那是个错误，已删除。
        //   Ctrl+0 是 Electron 内建的【整页缩放复位】，被 preventDefault 拦掉之后：
        //   ① 用户按 Ctrl+0 复位不了整页缩放；
        //   ② 页面长期停在放大状态，连点控件都像是「整体变大」。
        //   恢复 100% 改由【顶栏控件的百分比按钮】承担（点它即可），或 Ctrl+Alt+0。

        // ★ 滚轮手感参数：同一"滚轮动作"内的连发事件合并成一档（时间阈值，毫秒）。
        //   ⚠️ 曾经试过"累积 delta 到 100 才走一档"，结果把两个快捷键【都搞失灵了】——
        //      设备的 delta 差异太大（标准鼠标 100、系统设成小步 33、触控板 1~4），
        //      固定阈值必然踩雷（2026-10-14 用户反馈）⇒ 改成按【时间】合并，不看 delta 大小。
        const WHEEL_MIN_GAP = 40;
        let lastWheelAt = 0;
        let lastWheelLog = 0;        // 滚轮诊断日志节流（1 秒最多一行）
        let wheelHits = 0;           // 事件到达计数：前 5 次必打日志（确认事件到底有没有到）
        let wheelErrLogged = false;  // 异常只报一次，别刷屏

        /**
         * ★ 把对话区的滚动位置【钉住】。
         *   虽然我们在 window 捕获阶段就 preventDefault + stopImmediatePropagation，
         *   但 DSH 内部还有多处 wheel 监听（官方源码里 5 处）与程序化 scrollBy —— 拦不干净，
         *   索性在调节的那几帧里把相关滚动容器的位置锁死。
         *   只作用于我们吃掉的 Ctrl+Alt(+Shift)+滚轮，其它滚轮一概不碰。
         */
        let pinning = false;
        function pinScroll() {
            if (pinning) return;   // 连续调节只跑一个钉住循环，否则快速滚动会堆积大量 rAF 回调
            const els = [];
            const push = (el) => {
                try {
                    if (el && el.scrollHeight > el.clientHeight + 1 && els.indexOf(el) < 0) els.push(el);
                } catch (e) { /* 忽略 */ }
            };
            push(lastTarget);
            let p = lastTarget ? lastTarget.parentElement : null;
            while (p) { push(p); p = p.parentElement; }
            try { push(document.scrollingElement); } catch (e) { /* 忽略 */ }
            if (!els.length) return;
            pinning = true;
            const saved = els.map((el) => ({ el: el, top: el.scrollTop, left: el.scrollLeft, sb: el.style.scrollBehavior }));
            for (const s of saved) { try { s.el.style.scrollBehavior = 'auto'; } catch (e) { /* 忽略 */ } }
            let n = 0;
            const fix = () => {
                for (const s of saved) {
                    try {
                        if (s.el.scrollTop !== s.top) s.el.scrollTop = s.top;
                        if (s.el.scrollLeft !== s.left) s.el.scrollLeft = s.left;
                    } catch (e) { /* 忽略 */ }
                }
                if (++n < 4) requestAnimationFrame(fix);
                else {
                    for (const s of saved) { try { s.el.style.scrollBehavior = s.sb || ''; } catch (e) { /* 忽略 */ } }
                    pinning = false;
                }
            };
            requestAnimationFrame(fix);
        }

        function onWheel(e) {
            // ★ 只认【Ctrl+Alt+滚轮】：
            //   · 纯 Ctrl+滚轮  = Chromium 内建整页缩放（DOM 事件之前处理，拦不住）⇒ 让给系统
            //   · 纯 Alt+滚轮   = 实测不顺手 ⇒ 去掉
            //   · Ctrl+Alt+滚轮 = 无人占用 ⇒ 归我们
            //   ⚠️ 之前写的是 `!ctrlKey && !altKey`（「或」），纯 Ctrl 也会进这个函数，
            //   于是和 Electron 的整页缩放【同时发生】—— 看起来就是「整体变大」。
            if (!e.ctrlKey || !e.altKey) return;
            e.preventDefault();
            // stopImmediatePropagation 比 stopPropagation 更强：同一元素上的其它监听也停住，
            // 避免有别的监听先把事件处理掉（滚动容器就挂在这条链上）。
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            else if (e.stopPropagation) e.stopPropagation();
            // ★ 键位与方向：
            //   ① Ctrl+Alt+Shift+滚轮 = 调【列宽】，Ctrl+Alt+滚轮 = 调【缩放】；
            //   ② ⚠️ Shift+滚轮在 Chromium 里会被当成【水平滚动】⇒ deltaY 可能是 0，
            //      用 deltaX 兜底，否则方向恒为"收窄"；
            //   ③ 【立刻】响应：每个 wheel 事件就走一档，只把同一动作内（间隔 < WHEEL_MIN_GAP）
            //      的连发事件合并掉 —— 既防"一跳好几档"，又不会"滚半天没反应"。
            try {
                const d = (e.deltaY !== 0) ? e.deltaY : e.deltaX;
                if (d !== 0) {
                    const now = (window.performance && performance.now) ? performance.now() : Date.now();
                    // 诊断：前 5 次【必定】各打一行（用来确认事件到底有没有到达这里），之后 1 秒最多一行
                    wheelHits++;
                    if (wheelHits <= 5 || now - lastWheelLog > 1000) {
                        lastWheelLog = now;
                        console.log('[chat-zoom] 滚轮: delta=' + d + ' · shift=' + (!!e.shiftKey)
                            + ' · 距上次=' + Math.round(now - lastWheelAt) + 'ms');
                    }
                    if (now - lastWheelAt >= WHEEL_MIN_GAP) {
                        lastWheelAt = now;
                        const dir = d < 0 ? 1 : -1;
                        if (e.shiftKey) bumpWidth(dir); else bumpScale(dir);
                    }
                }
            } catch (err) {
                // 绝不静默失效：异常只报一次，且不影响后续事件
                if (!wheelErrLogged) {
                    wheelErrLogged = true;
                    console.error('[chat-zoom] 滚轮处理异常: ' + ((err && err.message) || err));
                }
            }
            pinScroll();                          // 顺手把滚动位置钉住（DSH 自己也会响应滚轮）
        }

        /** 控件订阅它来刷新百分比显示（键鼠两条路都会触发）。 */
        let scaleListener = null;

        function bumpScale(dir) {
            scale = clamp(Number((scale + dir * STEP).toFixed(3)));
            try { localStorage.setItem(KEY, String(scale)); } catch (e) { /* 忽略 */ }
            applyFonts();
            if (scaleListener) scaleListener();
        }

        function resetScale() {
            scale = 1;
            try { localStorage.setItem(KEY, '1'); } catch (e) { /* 忽略 */ }
            applyFonts();
            if (scaleListener) scaleListener();
        }

        /** 对话列宽度倍率（吃白边用）。与缩放相互独立，互不覆盖。 */
        function bumpWidth(dir) {
            width = Math.min(WMAX, Math.max(WMIN, Number((width + dir * WSTEP).toFixed(3))));
            try { localStorage.setItem(WKEY, String(width)); } catch (e) { /* 忽略 */ }
            applyFonts();
            if (scaleListener) scaleListener();
        }

        function resetWidth() {
            width = WDEFAULT;
            try { localStorage.setItem(WKEY, String(width)); } catch (e) { /* 忽略 */ }
            applyFonts();
            if (scaleListener) scaleListener();
        }

        /**
         * 键盘快捷键：Ctrl+Alt+ = / - / 0。
         * ★ 为什么带 Alt：Ctrl+0 是 Electron 的【整页缩放复位】不能抢；
         *   Ctrl+Alt+0 无人占用，抢了也没有副作用。
         */
        function onKey(e) {
            if (!e.ctrlKey || !e.altKey) return;
            const k = e.key, c = e.code;
            const wide = e.shiftKey;   // ★ Ctrl+Alt+Shift 系列 = 调列宽（与缩放对称）
            if (k === '=' || k === '+' || c === 'Equal' || c === 'NumpadAdd') {
                e.preventDefault(); if (wide) bumpWidth(1); else bumpScale(1);
            } else if (k === '-' || k === '_' || c === 'Minus' || c === 'NumpadSubtract') {
                e.preventDefault(); if (wide) bumpWidth(-1); else bumpScale(-1);
            } else if (k === '0' || c === 'Digit0' || c === 'Numpad0') {
                e.preventDefault(); if (wide) resetWidth(); else resetScale();
            }
        }

        /** 顶栏的缩放控件：纯点击，不依赖滚轮、不依赖任何修饰键。 */
        function ZoomControl() {
            const [pct, setPct] = react.useState(Math.round(scale * 100));
            const [wpct, setWpct] = react.useState(Math.round(width * 100));
            react.useEffect(() => {
                scaleListener = () => { setPct(Math.round(scale * 100)); setWpct(Math.round(width * 100)); };
                return () => { scaleListener = null; };
            }, []);
            return react.createElement('div', { className: NS + '_ctl', title: '对话区显示 —— 缩放：Ctrl+Alt+滚轮（或 = / - / 0）；列宽：Ctrl+Alt+Shift+滚轮（或 = / - / 0）。点数字复位' },
                react.createElement('button', { type: 'button', className: NS + '_cbtn', onClick: () => bumpScale(-1), title: '缩小字号（Ctrl+Alt+-）' }, 'A−'),
                react.createElement('button', { type: 'button', className: NS + '_cpct', onClick: resetScale, title: '点此恢复 100% 字号' }, pct + '%'),
                react.createElement('button', { type: 'button', className: NS + '_cbtn', onClick: () => bumpScale(1), title: '放大字号（Ctrl+Alt+=）' }, 'A+'),
                react.createElement('button', { type: 'button', className: NS + '_cpct', onClick: resetWidth, title: '对话列宽度：Ctrl+Alt+Shift+滚轮 调节 · 点此恢复默认 ' + Math.round(WDEFAULT * 100) + '%' }, '↔' + wpct + '%')
            );
        }

        function apply(ctx) {
            console.log('[chat-zoom] client apply()');
            injectCss();
            // 确定性入口：侧边栏底部的 A− / A+ / 百分比
            try {
                if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
                    // ★ 顶栏「对话 / 轨迹」那一行的动作区（官方插槽）。
                    //   插槽名来自 ui-conversation/src/client/contract/slots.ts 的 SlotMap。
                    //   之前放在 sidebar.footer.action，与「清理会话」挤在一起，且那里还有 goal-fold。
                    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
                        { name: 'conversation.session.header.actions', id: 'chat-zoom.control', order: 80 },
                        ZoomControl
                    ));
                    console.log('[chat-zoom] ✅ 缩放控件已注册到 conversation.session.header.actions（顶栏）');
                }
            } catch (e) {
                console.error('[chat-zoom] 控件注册失败: ' + ((e && e.message) || e));
            }
            // ★ 单例守卫：实测插件会被加载【多份】（模块图里有多个条目），
            //   每个实例各自 addEventListener + 各自持有 scale ⇒ 互相覆盖、档位乱跳。
            //   用 window 上的标记保证全局只有一份监听在跑。
            const g = window.__dshChatZoom || (window.__dshChatZoom = { on: false });
            if (g.on) {
                console.log('[chat-zoom] 已有实例在运行，跳过重复安装');
                return;
            }
            g.on = true;
            applyScale();
            // capture 阶段先拿到事件；passive:false 才能 preventDefault
            window.addEventListener('wheel', onWheel, { passive: false, capture: true });
            console.log('[chat-zoom] ✅ 监听已注册: window wheel(capture, passive:false) + keydown —— 按 Ctrl+Alt+滚轮 应出现「[chat-zoom] 滚轮」日志');
            // 会话切换后 DOM 会被重建 ⇒ 监听变化并自动重新应用
            if (ctx && typeof ctx.effect === 'function') ctx.effect(observeDom);
            else observeDom();
            window.addEventListener('keydown', onKey, true);
            // keydown 只认 Ctrl+Alt 组合（= / - / 0）—— 与 Electron 的 Ctrl+0 不重叠，抢了也无副作用
            // 卸载时撤掉监听并交还标记（交给 Cordis 的生命周期管理）
            if (ctx && typeof ctx.effect === 'function') {
                ctx.effect(() => () => {
                    window.removeEventListener('wheel', onWheel, true);
                    window.removeEventListener('keydown', onKey, true);
                    clearZoom(lastTarget);   // 内联覆盖（zoom / 宽高 / 宽度轴）一并撤掉
                    g.on = false;
                    console.log('[chat-zoom] 已卸载监听');
                });
            }
            // 官方可能稍后才写 body 的行内变量 ⇒ 再补一次（幂等）
            setTimeout(applyScale, 800);
            setTimeout(() => {
                const h = probed;
                try {
                    const t = (h && h.root) ? h.root : document.body;
                    const kid = t.firstElementChild || t;
                    // 定性用：如果 dpr / visualViewport.scale 变了，或 body 字号变了，
                    // 那就是【整页缩放】（Electron 干的），不是我们改的 font-size。
                    console.log('[chat-zoom] 页面缩放指标: dpr=' + window.devicePixelRatio
                        + ' · visualViewport.scale=' + (window.visualViewport ? window.visualViewport.scale : 'n/a')
                        + ' · body字号=' + window.getComputedStyle(document.body).fontSize
                        + ' · 对话区字号=' + window.getComputedStyle(t).fontSize);
                    console.log('[chat-zoom] 目标: <' + t.tagName.toLowerCase() + ' .'
                        + (typeof t.className === 'string' ? t.className.split(/\s+/)[0] : '')
                        + '>  子树元素=' + t.querySelectorAll('*').length
                        + '  首个子元素字号=' + window.getComputedStyle(kid).fontSize);
                } catch (e) { /* 忽略 */ }
                if (h) {
                    console.log('[chat-zoom] ✅ 对话区已锚定: <' + h.root.tagName.toLowerCase() + '> ' + h.vol + '字 · '
                        + h.w + 'x' + h.h + ' · 可滚动=' + h.scrollable + ' · class="' + h.cls + '"');
                    // ★ 缩放态势：出问题时先看这一行 —— 补偿项 / 宽度轴 / 物理尺寸是否填满父容器
                    try {
                        const cs2 = window.getComputedStyle(h.root);
                        const par = h.root.parentElement;
                        const rr = h.root.getBoundingClientRect();
                        const pb = par ? par.getBoundingClientRect() : null;
                        console.log('[chat-zoom] 缩放态势: z=' + scale + ' · 宽度=' + Math.round(width * 100) + '% · 补偿=' + (lastMode || '无')
                            + ' · 自身物理=' + Math.round(rr.width) + 'x' + Math.round(rr.height)
                            + (pb ? (' · 父=' + Math.round(pb.width) + 'x' + Math.round(pb.height)) : '')
                            + ' · 宽度轴=' + ((cs2.getPropertyValue('--dsh-chat-content-width') || '(无)') + '').slice(0, 90));
                    } catch (e) { /* 忽略 */ }
                    console.log('[chat-zoom] 候选前三（文本量 尺寸 可滚动）: ' + (h.top || []).join(' ｜ '));
                    // ★ 结构诊断：把「含大量文本的容器」按文本量排名打出来。
                //   连着三版都锚错（思考块 / 状态行 / 下方显示），说明对 DOM 的判断从头就错——
                //   与其再猜一层，不如把结构摊开看。
                try {
                    const cands = [];
                    document.querySelectorAll('div,main,section,article').forEach((el) => {
                        const t = (el.textContent || '').length;
                        if (t < 1000) return;
                        const r = el.getBoundingClientRect();
                        cands.push({ t: t, w: Math.round(r.width), h: Math.round(r.height), sc: el.scrollHeight > el.clientHeight + 20, el: el });
                    });
                    cands.sort((a, b) => b.t - a.t);
                    console.log('[chat-zoom] ── 大文本容器排名（文本量 / 尺寸 / 可否滚动）──');
                    cands.slice(0, 12).forEach((c, i) => {
                        const cls = typeof c.el.className === 'string' ? c.el.className.split(/\s+/)[0] : '';
                        const role = c.el.getAttribute('role') || '';
                        console.log('  #' + (i + 1) + ' <' + c.el.tagName.toLowerCase()
                            + (cls ? ' .' + cls.slice(0, 26) : '')
                            + (role ? ' [role=' + role + ']' : '') + '>  '
                            + c.t + '字  ' + c.w + 'x' + c.h + (c.sc ? '  可滚动' : ''));
                    });
                } catch (e) { /* 诊断失败不影响功能 */ }
                } else {
                    console.log('[chat-zoom] ⚠️ 没探到对话区，退回全局缩放（底栏也会跟着变）');
                }
            }, 900);
            console.log('[chat-zoom] ✅ Ctrl+Alt+滚轮（或顶栏控件）缩放对话区（当前 ' + Math.round(scale * 100) + '%）；Ctrl+Alt+0 恢复');
        }

        exports.apply = apply;
        exports.inject = ['slots'];   // 需要 slots 才能注册侧边栏控件
        return module.exports;
    },
});
