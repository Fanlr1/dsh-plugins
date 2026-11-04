# dsh-plugin-hw-monitor

Real-time hardware monitor (VRAM / RAM / GPU / CPU / CPU clock) shown beside the composer

## 功能

- **host 侧**采集五项指标（Node os 模块 + `nvidia-smi`，2.5s 一次）→ 挂成 **sessionProjection** → **client 侧**读取显示
- 挂在 composer dock 最左，只显示显存/内存
- 悬浮面板对齐官方 `stat_dialog` 样式（z-index 1100 · padding 16px · 官方 clamp 定位）
- 无 nvidia-smi 时自动降级（只显示内存）

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\hw-monitor"
cmd /c mklink /J "$nm\dsh-plugin-hw-monitor" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: hw-monitor
      name: 'dsh-plugin-hw-monitor'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
