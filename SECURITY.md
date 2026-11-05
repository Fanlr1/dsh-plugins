# 安全政策 / Security Policy

## 报告漏洞

请**不要**开公开 Issue。优先使用 GitHub 的私密报告：

- 仓库 **Security** 标签页 → **Report a vulnerability**（GitHub Private Vulnerability Reporting）

我们会尽快确认并修复；修复后发布新版本并在 CHANGELOG/Release 中说明。

## 支持范围

| 版本 | 状态 |
|---|---|
| 最新 tag（v0.1.x） | ✅ 维护中 |
| 更早版本 | ❌ 建议升级 |

## 已知设计取舍（非漏洞）

- 部分插件需要访问本机文件/进程（如 `bash`、`hw-monitor`、`session-tidy`）—— 这是功能所需，安装前请阅读对应 README 的权限说明。
- 插件在 DSH 宿主进程内运行，**没有沙箱隔离**；只安装你信任的插件。
