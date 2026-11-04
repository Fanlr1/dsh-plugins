# dsh-plugin-chat-user-edit

编辑自己已发出的 user 消息（会话日志 append 一条 surface 替换）

## 功能

- 点自己发过的消息 → 编辑 → 保存
- 机制：会话日志 append 一条带 `surfaceOp: { op: "replace" }` 的 `user/message` 事件
- 模型只看到修改后的版本（旧副本被遮蔽），**不删除历史**，可反复修改

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\chat-user-edit"
cmd /c mklink /J "$nm\dsh-plugin-chat-user-edit" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: chat-user-edit
      name: 'dsh-plugin-chat-user-edit'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
