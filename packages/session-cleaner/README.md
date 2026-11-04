# dsh-plugin-session-cleaner

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
    - id: session-cleaner
      name: 'dsh-plugin-session-cleaner'
```

> ⚠️ **npm 上已有同名的 `dsh-plugin-session-cleaner`（他人）**：如需发布到 npm，请使用 scope（如 `@your-name/dsh-plugin-session-cleaner`）或改名；本仓库的包名仅用于源码分发。

## 适配

- DSH **0.2.2-rc.1+** · 零运行时依赖
- client + host 双入口

## License

MIT
