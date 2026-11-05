# 贡献指南 / Contributing

感谢你愿意改进这些插件！本仓库是 **DSH（DeepSeek Harness）社区插件**集合，目标是小而稳、零运行时依赖。

## 环境

| 项 | 要求 |
|---|---|
| DSH | 0.2.2-rc.1+（各插件 README 标注了适配版本） |
| Node.js | >= 20 |
| 包管理 | pnpm（仓库根 `pnpm-workspace.yaml`）或直接 npm |

## 本地开发（Junction 方式，改源码立即生效）

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\<插件>"
cmd /c mklink /J "$nm\dsh-plugin-<插件>" $src
# 然后在 profile 的 cordis.patch.yml 追加 - insert: id: <插件> name: 'dsh-plugin-<插件>'
# 重启 DSH
```

> client 侧改动需要重启 DSH（HMR 已禁用）；纯样式调试可以先改页面。

## 提交 PR 前

1. `node scripts/check.mjs` 通过（语法 + 敏感串 + package.json 必填字段）
2. 实测：装上插件、重启 DSH、按 README 操作一遍
3. PR 只做**一件事**；描述里写清 DSH 版本、测试步骤、截图/日志
4. 使用仓库的 PR 模板勾选自查清单

## 代码约定（重要）

| 规则 | 说明 |
|---|---|
| **零运行时依赖** | 只允许 Node 内置模块；不要 `dependencies` |
| **不 require Harness Client 包** | client 插件只能 `require('react')` / `require('react-dom')`（官方明令禁止加载 Harness Client 包） |
| **样式只用变量** | client 样式绑定 `--dsw-*` / `--dsw-alias-*` 主题变量；**禁止 `!important`** |
| **不写本机路径** | 用 `os.homedir()` / `process.env.*`；禁止 `C:\Users\<用户名>` |
| **不写密钥** | 任何 token/key 都不进仓库 |
| **host 入口必须有** | 即使 client-only 插件也要导出一个 host 入口（否则 client bundle 不会被扫进启动图） |
| **钩内部 API 要注释** | 依赖 DSH 内部 API 的地方注明「升级可能失效」 |

## 提交 Issue

- **Bug**：用 Bug 模板，附 DSH 版本 / 插件名 / 复现步骤 / 日志
- **功能请求**：用 Feature 模板，先说场景再说方案
- 非 bug 的交流 → Discussions

## 许可证

本仓库全部代码为 **MIT**。提交 PR 即表示同意以 MIT 许可发布你的贡献。
