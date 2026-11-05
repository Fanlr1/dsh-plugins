## 变更说明

<!-- 这个 PR 做什么、为什么；关联的 Issue -->

Closes #

## 类型

- [ ] 🐛 Bug 修复
- [ ] ✨ 新功能
- [ ] ♻️ 重构 / 内部改进
- [ ] 📝 文档
- [ ] 🔧 CI / 工程

## 自查清单（提交前逐条确认）

- [ ] 单一职责：一个 PR 只做一件事（一个插件或一个主题）
- [ ] `node scripts/check.mjs` 通过
- [ ] 零运行时依赖（只用 Node 内置模块）
- [ ] 未写入本机路径 / 密钥等敏感信息
- [ ] client 插件未 `require` 任何 Harness Client 包（官方明令）
- [ ] client 样式只用 `--dsw-*` / `--dsw-alias-*` 变量、无 `!important`
- [ ] 对应 README 已同步更新

## 测试方式（必填）

<!-- DSH 版本、profile、操作步骤、期望 vs 实际、截图/日志 -->
