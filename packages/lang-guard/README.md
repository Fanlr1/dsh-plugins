# dsh-plugin-lang-guard

> 思维链语言自检：每回合客观测量汉字占比并落盘。**只读观测，不干预生成。**

## 它解决什么问题

主 agent 的思维链会漂成英文，而「凭感觉自查」在机理上无效 —— 自检与被检同源：如果已经在用英文思考，那「扫一眼自己」这个动作本身也是在英文语境里完成的。

本插件把观测内嵌进运行时：挂 `agent/turn-stopping` → 聚合**整回合全部 step** 的 reasoning 块 → 算汉字占比 → 落盘日志 + 状态文件。

## 安装

```bash
dsh plugin --profile desktop add dsh-plugin-lang-guard
```

没有 `dsh` CLI 时（如本机）：把包复制到 `~/.dsh/profiles/<profile>/node_modules/`，并在 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: lang-guard
      name: 'dsh-plugin-lang-guard'
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_LANG_GUARD_LOG` | `~/.dsh/lang-guard.log` | 日志文件路径 |
| `DSH_LANG_GUARD_STATUS` | `~/.dsh/lang-status.json` | 状态文件（外部工具可读） |
| `DSH_PLUGIN_LOGFILE=off` | — | 关闭文件写入（只用 `ctx.logger`） |

阈值（导出的常量）：`THRESHOLD_BAD = 0.2`（< 20% 严重漂移）· `THRESHOLD_WARN = 0.5`（< 50% 中英混杂）。

## 不做什么

- **不 steer、不改消息、不改配置** —— V1 对生成过程零副作用
- 看护层自身的异常全部 try/catch 静默放行（绝不能影响宿主）

## License

MIT
