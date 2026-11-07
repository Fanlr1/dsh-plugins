# dsh-plugin-comfyui

把 ComfyUI 接进 DeepSeek Harness：**列工作流、查参数、跑图、取图**，支持 UI 格式与 API 格式。

> 零依赖（只用 Node 内置模块）· host-only 插件 · 已装于 `~/.dsh/profiles/desktop`（Junction）

---

## 工具

| 工具 | 作用 |
|---|---|
| `comfyui_list` | 列出工作流文件（自动识别 UI / API 格式，含大小与修改时间）|
| `comfyui_params` | 列出一个工作流的可调参数：节点 id、class_type、输入名、类型、当前值、可选值 |
| `comfyui_run` | 运行工作流。`mode:"sync"` 阻塞等待；`mode:"async"` 交给后台 job，提交后结束本轮等完成通知 |

`comfyui_run` 参数：

| 参数 | 说明 |
|---|---|
| `workflow` | 文件名（默认目录下）或绝对路径 |
| `prompt` | 替换提示词（自动挑喂给 `TextGenerate.prompt` / `CLIPTextEncode.text` 的节点，避开 system_prompt）|
| `seed` / `width` / `height` | 替换 KSampler 种子、latent 宽高 |
| `overrides` | 按节点覆盖：`{ "KSampler": { "steps": 20 } }`；键名写错会被拒绝（先用 `comfyui_params` 查）|
| `mode` | `sync`（默认）/ `async` |
| `timeoutSec` | 等待上限，默认 300 |

**async 的语义**：提交后立刻返回 job id，模型应**结束本轮**；完成时宿主发通知唤醒，再调一次 `job_output` 拿到现成的 Markdown 图片行。

---

## 同源路由

挂在 DSH 自己的 `webServer` 上（浏览器不直连 ComfyUI，无 CORS）：

| 路由 | 用途 |
|---|---|
| `GET /comfyui/status` | 探测后端与 ComfyUI 版本 |
| `GET /comfyui/media?filename=&subfolder=&` | 取 `output` 目录里的图（路径穿越已挡）|
| `GET /comfyui/assets` | 本插件生成过的资产（最近 100 条）|
| `GET /comfyui/queue` | 转发 ComfyUI 当前队列 |

---

## 安装

```bash
# 有 dsh CLI 时：
dsh plugin --profile desktop add dsh-plugin-comfyui
```

没有 `dsh` CLI 时（手工三步）：

```bash
# 1) 复制包到 profile 的 node_modules
cp -r dsh-plugin-comfyui ~/.dsh/profiles/desktop/node_modules/
# 2) cordis.patch.yml 末尾追加：
#    - insert:
#        - id: comfyui
#          name: 'dsh-plugin-comfyui'
# 3) 重启 DSH（host 侧改动必须重启）
```

前置：ComfyUI 在跑（默认 `127.0.0.1:8188`）。

---

## 配置（环境变量，全部可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `COMFYUI_WORKFLOWS` | `~/llm/ComfyUI/user/default/workflows` | 工作流目录 |
| `COMFYUI_OUTPUT` | `~/llm/ComfyUI/output` | 输出目录（媒体路由与路径拼接用）|
| `COMFYUI_LLM_DIR` | `~/llm` | 上面两个默认值的根（换机器时改这一个）|
| `COMFYUI_LOG` | `~/llm/logs/comfyui-plugin.log` | 插件日志 |
| `COMFYUI_ASSETS` | `~/llm/logs/comfyui-assets.json` | 资产索引 |

---

## 已知限制

1. **ComfyUI 只认 API 格式**。本插件内置 UI→API 转换（递归展开 subgraph、widget 映射、动态组合），但服务端有几条硬规则：
   - `BOUNDING_BOXES`（`CreateBoundingBoxes.editor_state`）必须用 `{"__value__": []}` 包装；
   - DynamicCombo 必须扁平（`sampling_mode` + `sampling_mode.temperature`）；
   - Autogrow 组（`COMFY_AUTOGROW_V3`）本身可缺失。
   这几条是服务端硬规则，与宿主无关。
2. **Job 取消**：`job_kill` 会调用 `cancel()`（`POST /queue {delete}` + `/interrupt`）；`/interrupt` 是全局中断，可能影响同时在跑的其他任务。
3. **进度**：订阅 ComfyUI `/ws` 的 `progress` 事件，断线 3 秒重连；连不上只影响进度显示，不影响生成。
4. 目前只有 host 侧；工作流/资产面板是后续计划。

---

## 测试

```bash
node test/test.mjs                 # 契约测试（不需要 ComfyUI）
COMFYUI_TEST=1 node test/test.mjs  # 真实调用（需要 ComfyUI 在跑）
```

默认只跑契约：工具注册、output 契约、参数校验。设 `COMFYUI_TEST=1` 后额外跑真实列出工作流、参数清单、async 提交。

> 测试进程会挂着 ComfyUI 的进度 WS（生产里由 dispose 处理）⇒ 跑完显式 `process.exit(0)`。
