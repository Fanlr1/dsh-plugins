# dsh-plugin-session-tidy

清理 DSH **会话文件**——官方只提供「归档」，磁盘上的 session 文件仍在，长年积累。

## 功能

- **会话行右键菜单**：删除单个会话
- **侧边栏底部批量面板**：多选 → 移到 `sessions-trash` → 可再清空
- 删除是**移到回收区**（可恢复）；清空才真删

## 安全设计

- 破坏性操作有**二次确认**（按住 Ctrl 可跳过，适合批量场景）
- 只动会话文件，不碰配置/凭据

## 安装

Junction 方式（同其它插件）+ profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: session-tidy
      name: 'dsh-plugin-session-tidy'
```

> 本插件原名 `session-cleaner`；因 npm 上已有同名包（他人），开源版统一改名为 `dsh-plugin-session-tidy`（含内部插件 id / 路由 / 快捷键）。

## 适配

- DSH **0.2.2-rc.1+** · 零运行时依赖
- client + host 双入口

## License

MIT
