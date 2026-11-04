# dsh-plugin-scoped-instructions

Give subagents a trimmed workspace-instruction baseline

## 功能

- 给子 agent 的工作区指令自动剔除 `<!-- scope:main -->` 段落（主 agent 专用内容）
- 省 token（实测约 858 token/次），主 agent 不受影响
- host-only，零依赖

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\scoped-instructions"
cmd /c mklink /J "$nm\dsh-plugin-scoped-instructions" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: scoped-instructions
      name: 'dsh-plugin-scoped-instructions'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
