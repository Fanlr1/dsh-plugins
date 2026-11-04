# dsh-plugin-multi-edit

给 DSH agent 的 `multi_edit` 工具：**一次调用改多文件/多处**的字面替换。
内置 `edit` 一次只能改一处——批量改值、批量改名时代价很高。

## 为什么用它

- 内置 `edit` 一次一处：改 7 处说法要 7~10 次调用
- **两阶段提交**：先把所有编辑在内存里预检并试应用，全部通过才写盘（不会改一半）
- 支持 `dryRun`（只报会替换几处）、BOM 保留、同文件多条顺序生效

## 安装

### 方式 A：Junction（推荐，改源码立即生效）

```powershell
$nm = "$env:USERPROFILE\.dsh\profiles\desktop
ode_modules"
$src = "C:\path	o\dsh-plugins\packages\multi-edit"
cmd /c mklink /J "$nm\dsh-plugin-multi-edit" $src
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: multi-edit
      name: 'dsh-plugin-multi-edit'
```

### 方式 B：npm

```bash
pnpm dsh plugin --profile desktop add dsh-plugin-multi-edit
```

改完 **重启 DSH**（host 侧插件）。

## 参数

| 字段 | 说明 |
|---|---|
| `edits` | 数组，每项 `{file_path, old_string, new_string, replace_all?}`，按顺序应用 |
| `onError` | `stop`（默认：任一预检失败则一份都不写）/ `continue` |
| `dryRun` | true 时只报告每条会替换几处，不落盘 |

> `old_string` 必须字面精确匹配；命中多处时必须显式 `replace_all: true`（防误伤）。

## 适配

- DSH **0.2.2-rc.1+**（`ctx.tools.register(def)` 单参数契约）
- 零运行时依赖 · host-only

## License

MIT
