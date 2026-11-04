// dsh-plugin-goal-fold -- host 侧（占位）
//
// 本包只在浏览器侧做事（DOM 增强），但 Loader 需要一个 host 侧的 row
// 才会挂载这个包，因此这里提供一个空的 apply ——
// 与官方 dsh-client-ui-brand-official 的 node half 做法一致。

/** Host plugin body —— 本包只贡献浏览器表现。 */
function apply() {}

export { apply };
