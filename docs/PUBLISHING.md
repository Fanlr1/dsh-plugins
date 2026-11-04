# 发布到 npm（Trusted Publishing）

> npm 2025-11 起移除 classic token；2026 发布强制 2FA。**长期路线 = Trusted Publishing（OIDC）**。

## 现状（2026-11 实测）

| 项 | 说明 |
|---|---|
| classic token | ❌ 已移除（2025-11） |
| granular token | 可用但 90 天过期；2026-08 起 bypass-2FA 不可用 |
| 发布要求 | 强制 2FA（或 trusted publishing OIDC） |
| Trusted Publishing | ✅ GitHub Actions 支持；新配置须 **2 天内完成首次发布** 否则过期 |
| 环境要求 | npm CLI ≥ 11.5.1 · Node ≥ 22.14 |

## 首次发布（每个包一次，需要 2FA）

包必须先存在才能配置 Trusted Publisher，所以首次手动发布：

```bash
npm login                      # 浏览器/OTP
cd packages/multi-edit && npm publish --access public
cd ../bash && npm publish --access public
cd ../loop-guard && npm publish --access public
cd ../hub-finder && npm publish --access public
cd ../session-tidy && npm publish --access public
```

## 配置 Trusted Publishing

npmjs.com → 每个包 → Settings → Trusted publishing → Add：

| 字段 | 值 |
|---|---|
| Provider | GitHub Actions |
| Organization/user | Fanlr1 |
| Repository | dsh-plugins |
| Workflow filename | publish.yml |
| Allowed actions | ✅ npm publish（+ dist-tag 可选） |

随后建议：Settings → Publishing access → **Require two-factor authentication and disallow tokens**。

## 之后的发布

```bash
git tag v0.1.0 && git push origin v0.1.0
# → .github/workflows/publish.yml 自动用 OIDC 发布全部 5 个包（带 provenance）
```

## workflow 说明

- `.github/workflows/publish.yml`：tag `v*` 或手动触发；`id-token: write`；Node 24；逐包 `npm publish --provenance`
- 无需 `NODE_AUTH_TOKEN`（npm CLI 自动检测 OIDC 环境）
