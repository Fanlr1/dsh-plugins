# dsh-plugin-runtime-log

把 DSH 全系统日志落盘

## 功能

- DSH 默认没有运行日志 ⇒ 本插件把所有日志接到磁盘
- 产出：`~/.dsh/logs/dsh-runtime.log`（10 MB 轮转 × 5 份）+ `dsh-runtime-errors.log`（只有 ERROR/WARN）
- host-only，零依赖

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\runtime-log"
cmd /c mklink /J "$nm\dsh-plugin-runtime-log" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: runtime-log
      name: 'dsh-plugin-runtime-log'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
