// dsh-plugin-hide-update-retry -- host 侧
//
// 宿主端【什么都不做】——这个插件只在浏览器里注入一条 CSS。
// 之所以还保留 host 入口，是因为 DSH 的插件包需要一个可解析的 main，
// 且 cordis 会按 name/inject/apply 的形状加载它。
//
// 客户端部分见 lib/client.js（通过 package.json 的 exports["./client"] 暴露）。

export const name = 'hide-update-retry';

/** 不依赖任何宿主 API。 */
export const inject = [];

export function apply(ctx) {
  ctx.logger?.info?.('[hide-update-retry] 已加载（只在客户端注入 CSS）');
}
