# dsh-plugin-deepseek-balance

Show DeepSeek balance in the composer dock (projection approach)

## 功能

- DeepSeek 余额 / 今日用量 / 峰谷定价预估（composer dock）
- 走 `sessionProjections` 通道（host 采集 → client 展示）
- `live.js` 实时请求 · `projection.js` 注册投影 · `usage.js` 汇总用量
- 需要 `DEEPSEEK_API_KEY`（DSH 凭据）

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\balance"
cmd /c mklink /J "$nm\dsh-plugin-deepseek-balance" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: balance
      name: 'dsh-plugin-deepseek-balance'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
