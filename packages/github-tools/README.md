# dsh-plugin-github-tools

只读 GitHub 工具：github_repo（元信息+文件树+单文件）与 github_probe（路由探针）

## 功能

- `github_repo`：读仓库元信息、文件树、单文件内容（raw）
- `github_probe`：一次探测 api / raw / 页面三条路由是否可用（含耗时与推荐）
- 零依赖，只用 `node:https`
- **★ 关键坑**：`fetch` / `undici` 不认自签 MITM 根证书 ⇒ 内部一律 `node:https` + 显式 `ca`；可用 `DSH_GITHUB_TOOLS_CA` 或 `NODE_EXTRA_CA_CERTS` 指定

## 安装

Junction 方式（改源码立即生效）：

```powershell
$nm  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
$src = "<本仓库路径>\packages\github-tools"
cmd /c mklink /J "$nm\dsh-plugin-github-tools" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: github-tools
      name: 'dsh-plugin-github-tools'
```

**重启 DSH**。

## 适配

- DSH **0.2.2-rc.1+**（用到 DSH 内部/半公开 API，升级 DSH 后可能失效）
- 零运行时依赖（只用 Node 内置模块）
- MIT

## License

MIT
