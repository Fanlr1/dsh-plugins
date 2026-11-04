# dsh-plugin-queue-fold

Make the queued-message strip expandable and collapsible

## 功能

- 排队消息条展开/收起（锚点 `data-queue-dock`）
- 展开 = 放开 `_preview` 的 nowrap 与 `_list` 的 180px 限高
- 纯前端实现，host 侧空占位

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\queue-fold"
cmd /c mklink /J "$nm\dsh-plugin-queue-fold" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: queue-fold
      name: 'dsh-plugin-queue-fold'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
