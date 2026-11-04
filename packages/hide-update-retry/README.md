# dsh-plugin-hide-update-retry

隐藏桌面端的「重试更新」提示

## 功能

- 自建未签名构建没有更新源，每次自动检查都会失败并弹「重试更新」——本插件用 CSS 把它隐藏
- 纯前端（host 侧空占位）
- 可随时删除插件恢复原状

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\hide-update-retry"
cmd /c mklink /J "$nm\dsh-plugin-hide-update-retry" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: hide-update-retry
      name: 'dsh-plugin-hide-update-retry'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
