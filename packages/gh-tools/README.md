# dsh-plugin-gh-tools

GitHub 仓库管理工具：PR / Issue / CI runs / 评论 —— 让 agent 直接管仓库的 CI/CD 状态。

## 功能

| 工具 | 用途 |
|---|---|
| `gh_pr_list` | 列 PR（state / limit）|
| `gh_pr_view` | PR 详情 + 改动文件列表（最多 30 个）|
| `gh_issue_list` | 列 Issue（自动过滤 PR）|
| `gh_comment` | 给 Issue/PR 发评论（**写操作**，公开动作，确认后调用）|
| `gh_run_list` | 列 GitHub Actions 运行（结论 / 工作流 / 编号 / 时间 / 分支）|
| `gh_run_watch` | 看最新 CI 运行状态（未完成时提示稍后再查）|

- **零依赖**，只用 `node:https`
- 凭据：`ctx.credentials.resolve('GITHUB_TOKEN')` → 环境变量 `GITHUB_TOKEN` / `GH_TOKEN` 兜底
- 只读工具声明 `isConcurrencySafe: () => true`（可并行）；`gh_comment` 是写操作
- **★ 关键坑**：`fetch` / `undici` 不认自签 MITM 根证书 ⇒ 内部一律 `node:https` + 显式 `ca`；
  用 `DSH_GH_TOOLS_CA` 或 `NODE_EXTRA_CA_CERTS` 指定根证书（PEM）

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\gh-tools"
cmd /c mklink /J "$nm\dsh-plugin-gh-tools" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: gh-tools
      name: 'dsh-plugin-gh-tools'
```

**重启 DSH**（host 侧插件，改完必须重启；HMR 已禁用）。

## 配置

| 环境变量 | 用途 |
|---|---|
| `GITHUB_TOKEN`（或 DSH 凭据 seam 里的同名条目）| 必填。经典 token 需 `repo` scope；fine-grained token 需对应仓库的 Pull requests / Issues / Actions 读权限（评论需写权限）|
| `DSH_GH_TOOLS_CA` / `NODE_EXTRA_CA_CERTS` | 可选；自签 / MITM 根证书路径（PEM）|

## 用法示例

```
gh_run_list   repo="owner/repo"
gh_pr_list    repo="owner/repo" state="open"
gh_pr_view    repo="owner/repo" number=12
gh_issue_list repo="owner/repo"
gh_comment    repo="owner/repo" number=12 body="已在 main 修复"
gh_run_watch  repo="owner/repo" workflow="ci"
```

工具返回纯文本摘要（编号 / 标题 / 作者 / 时间 / 结论），便于 agent 直接读。

## 适配

- DSH **0.2.2-rc.1+**（用到 `ctx.tools.register` / `ctx.credentials` 等内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
