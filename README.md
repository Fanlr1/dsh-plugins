# DSH Plugins

一组为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）写的社区插件。
DSH 的信条是 **Everything is a Plugin** —— 这些插件都来自日常使用的真实痛点。

## 插件（15 个）

| 插件 | 一句话 | 形态 |
|---|---|---|
| [multi-edit](packages/multi-edit/) | 一次调用改多文件/多处（两阶段预检 + dryRun） | host 工具 |
| [bash](packages/bash/) | Windows 上的 bash 工具 + 子 agent 藏 pwsh + spill + 后台 job | host 工具 |
| [loop-guard](packages/loop-guard/) | 思维链循环守卫：检测推理打转 → 截断本轮流 | host 钩子 |
| [hub-finder](packages/hub-finder/) | 中文搜索 DSH 社区插件（工具 + 设置页 UI） | host + client |
| [session-tidy](packages/session-tidy/) | 删除会话文件（官方只归档不删） | host + client |
| [hw-monitor](packages/hw-monitor/) | 显存/内存实时监控（composer 旁） | host + client |
| [deepseek-balance](packages/deepseek-balance/) | DeepSeek 余额/用量/峰谷预估（原 balance，npm 重名改名） | host + client |
| [goal-fold](packages/goal-fold/) | 会话目标条折叠/展开 | client |
| [queue-fold](packages/queue-fold/) | 排队消息条展开/收起 | client |
| [chat-zoom](packages/chat-zoom/) | Ctrl+Alt+滚轮缩放对话区 + 列宽倍率 | client |
| [chat-user-edit](packages/chat-user-edit/) | 编辑已发出的用户消息（不删历史） | host + client |
| [hide-update-retry](packages/hide-update-retry/) | 隐藏桌面端「重试更新」提示 | client |
| [github-tools](packages/github-tools/) | 只读 GitHub 工具（仓库/文件树/路由探针） | host 工具 |
| [scoped-instructions](packages/scoped-instructions/) | 子 agent 指令剔除 scope:main 段（省 token） | host 钩子 |
| [runtime-log](packages/runtime-log/) | 把 DSH 全系统日志落盘 | host 钩子 |

> 更多插件（chat-zoom 之外：doc-guard / tls-proxy / comfyui / local-llm / lang-guard …）会陆续迁入。

## 安装（通用步骤）

### 方式 A：Junction（推荐；改源码立即生效）

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\<插件>"
cmd /c mklink /J "$nm\dsh-plugin-<插件>" $src
```

### 方式 B：npm（发布后）

```bash
pnpm dsh plugin --profile desktop add dsh-plugin-<插件>
```

最后在 profile 的 `cordis.patch.yml` 追加对应 `insert` 段（见各包 README），**重启 DSH**。

> host 侧插件改动 = 重启；纯 client 侧 = 刷新页面；凭据文件改动 = 自动热重载。

## 适配版本

- **DSH 0.2.2-rc.1+**。这些插件钩的是 DSH **内部/半公开 API**（例如 `ctx.tools.register` / `connection.authenticatedUrl` / `sessionProjections` / `ctx.slots`），**升级 DSH 后可能失效**——见各包 README。
- 全部包**零运行时依赖**（只用 Node 内置模块）。

## 自检

```bash
node scripts/check.mjs   # 语法 + 敏感串 + package.json 必填字段
```

## 免责

社区插件，非 DeepSeek 官方项目。`session-tidy` 会删除会话文件（有二次确认），使用前请自行备份重要数据。

## License

MIT —— 与 DSH 本体一致。
