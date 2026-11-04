# dsh-plugin-goal-fold

Make the session GoalBar collapsible and expandable

## 功能

- 会话头部的目标条（GoalBar）折叠/展开三态：展开 / 精简 / 隐藏
- 纯前端 DOM 增强（host 侧空占位），不依赖官方未公开 API
- 状态按会话记忆

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\goal-fold"
cmd /c mklink /J "$nm\dsh-plugin-goal-fold" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: goal-fold
      name: 'dsh-plugin-goal-fold'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
