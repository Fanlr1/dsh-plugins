# DSH Plugins

一组为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）写的社区插件。
DSH 的信条是 **Everything is a Plugin** —— 这些插件都来自日常使用的真实痛点。

## 插件

| 插件 | 一句话 | 形态 | 适配 |
|---|---|---|---|
| [multi-edit](packages/multi-edit/) | 一次调用改多文件/多处（两阶段预检 + dryRun） | host 工具 | 0.2.2-rc.1+ |
| [bash](packages/bash/) | Windows 上的 bash 工具 + 子 agent 藏 pwsh + spill + 后台 job | host 工具 | 0.2.2-rc.1+ |
| [loop-guard](packages/loop-guard/) | 思维链循环守卫：检测推理打转 → 截断本轮流 | host 钩子 | 0.2.2-rc.1+ |
| [hub-finder](packages/hub-finder/) | 中文搜索 DSH 社区插件（工具 + 设置页 UI） | host + client | 0.2.2-rc.1+ |
| [session-tidy](packages/session-tidy/) | 删除会话文件（官方只归档不删） | host + client | 0.2.2-rc.1+ |

> 更多插件（balance / hw-monitor / goal-fold / chat-zoom / doc-guard / tls-proxy / comfyui …）会陆续迁入。

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

> host 侧插件改动 = 重启；纯 client 侧 = 刷新页面。

## 适配版本

- **DSH 0.2.2-rc.1+**。这些插件钩的是 DSH **内部/半公开 API**（`ctx.tools.register` / `connection.authenticatedUrl` / `agent/pre-step` 等），**升级 DSH 后可能失效**——见各包 README 的「适配」节。
- 全部包**零运行时依赖**（只用 Node 内置模块）。

## 自检

```bash
node scripts/check.mjs   # 语法 + 敏感串 + package.json 必填字段
```

## 免责

这是社区插件，不是 DeepSeek 官方项目。`session-tidy` 会删除会话文件（有二次确认），使用前请自行备份重要数据。

## License

MIT —— 与 DSH 本体一致。
