---
name: colab-qwen38-deploy
description: >-
  在 Google Colab G4（RTX PRO 6000 96GB）上用 SGLang 部署原始 BF16 精度的 Qwen3.8-27B（EAGLE-4 投机解码 +
  可靠前缀缓存），通过 colab port-forward 把 Anthropic Messages API 固定到本地 localhost:30000，
  供 Claude Code 等 agent 客户端使用。当用户要求部署 / 启动 / 重启 / 检查自部署的千问 3.8（Qwen3.8）、
  让 Claude Code 用自部署千问，或排查这个服务时使用。
metadata:
  short-description: Colab G4 部署 Qwen3.8-27B BF16（SGLang+EAGLE-4）并转发 Anthropic API 到本地 30000
disable-model-invocation: true
---

# Qwen3.8-27B 自部署（Colab G4 + SGLang + Anthropic API）

这套配置 2026-10-03 以 MTP 投机解码首次验证（Claude Code 在本地通过 `localhost:30000` 完成多轮工具调用），
2026-10-21 换成 EAGLE-4 后在同一台 G4 上与 MTP 逐项对照，并重新走通了本流程。
**全部 Colab 操作都通过 colab-cli skill 的 `colab` 命令完成**，flag 有疑问时以 `colab <cmd> --help` 为准。

本 skill 的目录记为 `$S=~/.agents/skills/colab-qwen38-deploy`。

| 项 | 值 |
|---|---|
| 硬件 | Colab **G4 High-RAM**（RTX PRO 6000 Blackwell 96GB） |
| 引擎 | SGLang `0.5.23.dev252+eagle.4`（eagle-hq 构建）+ `eagle-harness` 0.1.0，py3.12 venv，torch 2.14 cu130 |
| 投机解码 | EAGLE-4，draft 为 `EAGLE-Corp/Qwen3.8-27B-EAGLE4`（BF16，6.2 GB），每轮树形按实测成本自动选择 |
| 精度 | BF16 权重、bf16 KV cache、fp32 GDN 状态（全程原始精度，不用量化版） |
| 实测性能 | 单用户解码 91–96 tok/s（固定输出），真实对话约 77 tok/s，约为 MTP（55 / 53 tok/s）的 1.45–1.7 倍；KV 容量 210,810 token；13 万 token 会话的后续轮次 TTFT 约 0.3 s |
| 接口 | 远端 `:30000` → 本地 `http://localhost:30000`，同时提供 `/v1/messages`（Anthropic）和 `/v1/chat/completions`（OpenAI） |

## 硬性约束

- **只用 G4。** 不要因为 G4 暂时没有资源就自行换成 A100。A100 80GB 上同一套配置的 KV 只有约 5–13 万 token，满足不了用户"20 万以内上下文"的需求。G4 创建失败时，向用户报告并询问下一步。
- **不要改用量化权重**（FP8/NVFP4/GGUF），用户要求原始精度。EAGLE-4 是投机解码，target 仍是 BF16 原权重，不受此限制影响。
- **不要主动销毁 runtime。** 部署完成后服务要一直供用户使用，只有用户明确要求时才执行 `colab runtime destroy`。
- 启动参数以 `scripts/remote_serve.sh` 为准，不要凭记忆改动。每个参数为什么这样设见该文件注释和 `references/notes.md`。

## 部署流程

每一步看到预期输出再进行下一步。耗时参考：创建 runtime 约 1 分钟（G4 经常暂时无资源，可每分钟重试，通常 10 分钟内拿到），安装和下载约 4–5 分钟，首次启动约 2–3 分钟。

### 0. 前置检查

```bash
colab auth status            # 未登录则 colab auth login（会打开浏览器）
colab usage                  # 确认 CCU 余额
colab runtime list           # 已有 G4 runtime 且服务在跑的话，直接跳到第 4 步做检查
lsof -iTCP:30000 -sTCP:LISTEN   # 本地 30000 端口被别的程序占用时，先问用户
```

如果已经有一个 G4 runtime：先用 `colab exec --endpoint <E> "..."` 执行 `bash /content/remote_status.sh`（文件存在的话）。返回 `STATE=READY` 时，跳到第 5 步。

### 1. 创建 G4 runtime

```bash
E=$(colab --json runtime create --accelerator G4 --shape high-ram | jq -r '.endpoint'); echo $E
colab exec --endpoint $E "import subprocess;print(subprocess.run('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv', shell=True, capture_output=True, text=True).stdout)"
```

预期显卡是 `NVIDIA RTX PRO 6000 Blackwell Server Edition, 97887 MiB`，驱动 580.x。如果驱动主版本不是 580（对应 CUDA 13.0），`remote_setup.sh` 里的 `--torch-backend=cu130` 可能需要调整，先告诉用户。

### 2. 上传文件

```bash
S=~/.agents/skills/colab-qwen38-deploy
for f in remote_setup.sh remote_serve.sh remote_status.sh; do colab fs upload $S/scripts/$f --remote-path content/$f --endpoint $E; done
colab fs upload $S/assets/chat_template.jinja --remote-path content/chat_template.jinja --endpoint $E
```

### 3. 安装与下载（后台 shell）

```bash
SID=$(colab shell --background --endpoint $E)      # 打印 shell ID
colab shell send $SID --data 'mkdir -p /content/logs; bash /content/remote_setup.sh > /content/logs/setup.log 2>&1\n'
```

用 Bash 的 `run_in_background` 跑一个 until 循环，等到日志里出现 `SETUP_OK` 或 `SETUP_FAILED`：

```bash
until out=$(colab exec --endpoint $E "import os;p='/content/logs/setup.log';print(open(p).read() if os.path.exists(p) else '')" 2>/dev/null) && echo "$out" | grep -qE "SETUP_OK|SETUP_FAILED"; do sleep 20; done; echo "$out" | tail -5
```

- 出现 `SETUP_FAILED` 时，看 `/content/logs/install_sglang.log`、`download.log`、`download_draft.log` 或 `eagle_check.log`。如果日志首行是 `Using Python 3.13 environment at: /usr`，说明没有用 `--python` 指定 venv。脚本里已经处理了这个问题，不要去掉 `--python`。

### 4. 启动服务并等待就绪

```bash
colab shell send $SID --data 'bash /content/remote_serve.sh start\n'
bash $S/scripts/wait_ready.sh $E          # 建议用 run_in_background；成功时打印 STATE=READY 和容量
```

- 预期输出包含 `max_total_num_tokens=210810`（允许小幅差异）和 `max_running_requests=2`。如果明显低于 20 万，先确认 `remote_serve.sh` 里是 `--mem-fraction-static 0.92`。
- 就绪后的前几个请求会测量 draft 和验证的耗时（live costs），速度略低；结果缓存在 `/root/.cache/eagle-harness/costs/`，同一 runtime 重启后直接复用。
- `remote_serve.sh start` 会先停掉旧服务，确认进程退出后再启动，所以重启也用同一条命令。不要自己拼 `pkill -f sglang...`：在 `colab exec` 里，这个模式会匹配到执行它的那个 shell 自身。
- 出现 `STATE=FAILED` 或 `DEAD` 时，查看 `/content/logs/serve.log`。常见原因见 `references/notes.md` 的"故障排查"。

### 5. 端口转发到本地 30000

```bash
colab port-forward create 30000:30000 --endpoint $E
curl -s -m 30 http://localhost:30000/v1/models      # 应返回 Qwen/Qwen3.8-27B
```

- 转发由 colab-cli 的 daemon 维持。daemon 重启或本地机器重启后，转发会消失，重新执行 `create` 即可，服务端不需要动。
- **`port-forward` 的 `list` 和 `close` 一律带上 `--endpoint $E`。** 转发是按 runtime 分开管理的，不带 `--endpoint` 时只看"最近创建的那台"。这样可能出现 `list` 显示没有转发、但 30000 端口实际被另一台 runtime 的转发占着的情况（`create` 时报 `EADDRINUSE`）。遇到这种情况，用 `lsof -iTCP:30000 -sTCP:LISTEN` 确认占用端口的是 colab daemon，再对每个 endpoint 执行 `port-forward list --endpoint`，找到对应的那条后关闭。

### 6. 冒烟测试

```bash
bash $S/scripts/smoke_test.sh 30000        # 四项全部 OK，最后打印 SMOKE_OK
```

测试内容：模型列表、`effort=high` 的请求（Claude Code 默认发这个值）、流式输出、工具调用（`stop_reason: tool_use`）。

### 7. 交给用户

告诉用户：在**自己的终端**里执行下面的命令，然后运行 `claude`：

```bash
source ~/.agents/skills/colab-qwen38-deploy/scripts/claude_env.sh   # 设置 ANTHROPIC_BASE_URL 等变量
claude
```

需要说明的几点：

- Claude Code 读取的是 `ANTHROPIC_BASE_URL`，值为 `http://localhost:30000`，**不带 `/v1`**。用户口头说的 "BASE_URL" 指的就是这个变量。
- 启动时出现 `[claude-code:unrecognized_model]` 提示属于正常现象。
- 用 OpenAI 兼容客户端时，base URL 为 `http://localhost:30000/v1`，模型名填 `Qwen/Qwen3.8-27B`。
- 最后报告：endpoint、shell ID、KV 容量、冒烟测试结果，以及当前 CCU 消耗速率（`colab usage`）。

## 日常运维

| 操作 | 命令 |
|---|---|
| 查看状态 | `colab exec --endpoint $E "import subprocess;print(subprocess.run(['bash','/content/remote_status.sh'],capture_output=True,text=True).stdout)"` |
| 查看缓存命中 | 响应 usage 的 `cache_read_input_tokens`（Claude Code 会记进 transcript）；或在 `/content/logs/serve.log` 里 grep `Prefill batch`，看 `#cached-token` |
| 重启服务 | `colab shell send $SID --data 'bash /content/remote_serve.sh start\n'`，然后执行 `wait_ready.sh` |
| 停止服务 | `bash /content/remote_serve.sh stop` |
| 恢复转发 | `colab port-forward list --endpoint $E`，没有转发时重新 `create 30000:30000 --endpoint $E` |
| 用户要求下线 | `colab port-forward close --all --endpoint $E`；**用户确认后**才执行 `colab runtime destroy --endpoint $E` |

如果 shell ID 丢了，用 `colab shell list` 找，或者重新开一个 `colab shell --background --endpoint $E`。

## 给用户的使用建议（保证缓存命中）

- 同一个会话里，不要修改 reasoning effort、system prompt 和工具列表（包括 MCP 工具的增减）。这三者都会写进模板开头的 system 段，一改就整段前缀失效，下一轮要重新 prefill 全部历史。14 万 token 大约需要 38 秒。
- 第一次塞入很长的上下文时要等 prefill，大约 3–6k token/s；之后每一轮只需计算新增的内容。
- 实际可用上下文约 21 万 token（KV 容量 210,810；服务端上限是 262,144），输入和输出都要放进去。`claude_env.sh` 把压缩窗口设成 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000`。Claude Code 会先从窗口里扣掉最大输出（未知模型默认 32,000），所以输入到约 16.8 万 token 时就会压缩。改了 KV 容量的话，这个值要跟着改：窗口不超过"KV 容量 − 1 万"。

更多背景见 `references/notes.md`：选型依据、实测数据、每个参数的来源、故障排查。
