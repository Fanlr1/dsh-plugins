# dsh-plugin-chat-zoom

对话区缩放 + 列宽倍率

## 功能

- `Ctrl+Alt+滚轮`：缩放对话区（50%-200%）
- `Ctrl+Alt+Shift+滚轮`：调列宽倍率
- `Ctrl+Alt+0`：恢复默认
- 顶栏 A- / A+ 控件 + 全局快捷键；只缩放对话区，不整页缩放

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\chat-zoom"
cmd /c mklink /J "$nm\dsh-plugin-chat-zoom" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: chat-zoom
      name: 'dsh-plugin-chat-zoom'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
