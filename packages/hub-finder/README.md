# dsh-plugin-hub-finder

在 DSH 里**中文搜索社区插件**：`find_dsh_plugin` 工具 + 设置页 UI
（插件页「添加插件」菜单入口、中文搜索浮层、卡片列表、原生分页）。

## 数据源

- `https://api.dsh-plugin.org`（**第三方社区服务**，非 DeepSeek 官方）
- 缓存 TTL 1 小时，缓存文件可配置

## 功能

- 中文/英文关键词搜索；也支持 `owner/repo` 或 dsh-plugin.org 链接精确反查
- 返回：GitHub 地址 · 中文简介 · 功能要点 · stars · 分类 · 更新时间 · 安装命令
- 设置页 UI 与 agent 工具共用同一份匹配逻辑

## 配置（均可选）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HUB_FINDER_CACHE` | `~/.dsh/logs/dsh-plugin-index.json` | 索引缓存文件 |
| `DSH_PLUGIN_DIR` | `~/llm` | 本地插件目录（供「自研/第三方」徽章判定）|

## 局限

- 数据源可用性/内容不受本插件控制；索引是第三方聚合结果，**别当权威依据**
- 部署了 agent preset roster 的环境会额外提供预设元数据（可选）

## License

MIT
