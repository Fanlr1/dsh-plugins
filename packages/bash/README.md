# dsh-plugin-bash

Windows 上的 `bash` 工具（走 Git for Windows），并对子 agent 隐藏 `pwsh`。

## 为什么需要它

官方 `@deepseek-ai/dsh-tool-bash` 在 **win32 上被设计性禁用**（bundle patch 里 `disabled: !!js process.platform === 'win32'`），
执行器侧 `bash-sandbox` 同样禁用；而 Windows 上做文本处理（sed/awk/sort/xargs）又离不开 bash。

## 特性

- 注册 `bash` 工具（自动探测 Git for Windows 安装路径）
- **对子 agent 隐藏 `pwsh`**（`agent.ctx.tools.restrict`），主 agent 保留全能力
- 输出超限 **spill 落盘**（完整内容给路径，不丢）
- `run_in_background`：接 DSH `ctx.jobs`；前台命令**超时自动转后台**

## 配置（均可选）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BASH_LOG` | `~/.dsh/logs/bash-tool.log` | 插件日志 |
| `DSH_BASH_SPILL` | `~/.dsh/logs/bash-spill` | 超长输出落盘目录 |

## 依赖

- **Git for Windows**（默认探测 `C:\Program Files\Gitinash.exe`）
- DSH **0.2.2-rc.1+** · 零运行时依赖 · host-only

## License

MIT
