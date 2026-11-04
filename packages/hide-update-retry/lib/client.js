// dsh-plugin-hide-update-retry -- client 侧
//
// 目的：隐藏桌面端的「重试更新」提示。
//
// 背景：
//   自建构建是 --unsigned，没有 resources\app-update.yml
//   ⇒ update-coordinator.ts L54 的 enabled() 返回 false
//   ⇒ 每隔 DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS（默认 10 分钟）自动检查一次，
//      每次都抛 "this application has no packaged update source"
//   ⇒ 侧边栏一直挂着「重试更新」按钮 + 小红点
//
// 做法：
//   官方组件 DesktopUpdateIndicator.tsx 给按钮和红点都写了稳定的 aria-label，
//   而它的 className 是 CSS Modules（哈希，不可依赖）。
//   ⇒ 用【属性选择器】按 aria-label 命中，注入一条 display:none。
//
// ★ 不使用 !important：
//   官方选择器是哈希类名（权重 10），属性选择器同为 10，
//   而插件 CSS 在官方之后插入 ⇒ 同权重后者胜。
//   若将来失效，先考虑提高选择器特异性，不要加 !important。
//
// ★ 只隐藏"失败/重试"态（error / failed）。
//   checking / available / downloading 等瞬时态保留 —— 那是有用的反馈。

window.__ModuleLoader__.load({
    id: 'dsh-plugin-hide-update-retry',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        const STYLE_ID = 'dsh-plugin-hide-update-retry/client.css';

        // aria-label 的取值来自官方 locale（desktop.update.retry）：
        //   zh: 重试更新
        //   en: Retry Update
        // 用 *= 子串匹配，顺带覆盖将来可能的措辞微调。
        const CSS = [
            // 侧边栏底部那个「重试更新」按钮（DesktopUpdateIndicator）
            'button[aria-label*="重试更新"]{display:none}',
            'button[aria-label*="Retry Update"]{display:none}',
            // 侧边栏展开按钮上的小红点（DesktopUpdateBadge）
            'span[role="img"][aria-label*="重试更新"]{display:none}',
            'span[role="img"][aria-label*="Retry Update"]{display:none}',
        ].join('\n');

        function injectCss() {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.setAttribute('data-plugin-css', STYLE_ID);
            style.textContent = CSS;
            document.head.appendChild(style);
            console.log('[hide-update-retry] 已注入 CSS（隐藏「重试更新」）');
        }

        // 这个插件不注册任何 slot，也不需要任何官方 API —— 只是往文档里加一条样式。
        // 官方前端的样式表可能在 apply 之后才挂载，所以再补一次（幂等）。
        function apply() {
            injectCss();
            // DOM 就绪后再确认一次（避免 apply 早于 <head> 可用）
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', injectCss, { once: true });
            }
        }

        exports.apply = apply;
        exports.inject = [];
        return module.exports;
    },
});
