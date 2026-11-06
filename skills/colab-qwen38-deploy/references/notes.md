# 背景、实测数据与故障排查

EAGLE-4 与 MTP 的对照报告和原始数据在 `/Users/lorne/pyenv/ipy-data/colab/qwen3.8-27b-bf16-bench/eagle4/REPORT.md`
（换用 EAGLE-4 前的 MTP 版 skill 备份在同目录 `skill_backup_mtp_20261021/`）。

更早的完整测试报告和原始数据在 `/Users/lorne/pyenv/ipy-data/colab/qwen3.8-27b-bf16-bench/REPORT.md`，包括：

- A100 和 G4 对比
- SGLang 和 vLLM 对比
- 投机解码与上下文缓存的对照实验

## 为什么是 G4 + SGLang + EAGLE-4

2026-10-21 在同一台 G4 上的对照（单用户，T=1、top_p 0.95、top_k 20，与 skill 的公共参数完全一致，只换投机解码部分）：

| 配置 | KV 容量 | 固定输出 1024 token（tok/s） | 真实对话（tok/s，中位数） |
|---|---:|---:|---:|
| 不开投机 | 377,665 | 27.0 | — |
| MTP 3/1/4，mem 0.85（旧配置） | 258,885 | 55.2 | 53.1 |
| EAGLE-4 宽度 16、并发 2，mem 0.85 | 128,379 | 89.8 | 78.7 |
| **EAGLE-4 宽度 16、并发 2，mem 0.92（本配置）** | **210,810** | **96.0**（复测 91.0） | **77.1** |
| EAGLE-4 宽度 12、并发 2，mem 0.92 | 232,287 | 82.3 | — |
| EAGLE-4 宽度 16、并发 1，mem 0.92 | 239,446 | 90.6 | — |
| EAGLE-4 宽度 8、并发 1，mem 0.85 | 185,650 | 75.9 | 66.6 |

- 能力不变：T=0 下与不开投机的输出逐字比较，MTP 和 EAGLE-4 都会在 BF16 near-tie 处分叉（10 题中各有 7、8 题分叉）。
  在不开投机的服务上取分叉点两个 token 的 logprob，差值全部 ≤ 0.125（一个 BF16 舍入步长），没有一处是真实的模型行为改变。
  T=1 下 SGLang 的树形投机采样同时按 top-k 和 top-p 过滤（fork 的 `eagle_utils._filter_verify_target_probs`），分布不变。
- 前缀缓存：回传思考、丢弃思考、插入另一会话再回来，全部命中，与 MTP 相同；13 万 token 会话后续轮次 TTFT 0.26–0.35 s（MTP 0.46–0.50 s）。
- 长上下文：mem 0.92 下 19.2 万 token 单请求 prefill 约 3.3k token/s、无 OOM，该长度下解码 77 tok/s。
- 需要更大 KV 时可改宽度 12（23.2 万，速度降约 14%）；并发 1 虽然容量更大，但 Claude Code 的后台请求会排队，不推荐。

2026-10-03 的选型对照（MTP 时代，各方案单用户实测）：

| 方案 | 解码 tok/s | 单用户 KV 容量 | 多轮缓存 |
|---|---|---|---|
| G4 SGLang MTP（旧配置） | 57.9 | 258,885 | 分叉、切换会话后仍然命中；14 万会话后续轮次 TTFT 0.44–0.50 s |
| A100 vLLM MTP | 61.4 | 285,836 | 按 800 token 一块缓存，开 MTP 时还会额外丢 1 块，每轮多重算约 1.6k token |
| A100 SGLang MTP | 59.6 | 134,315（只留 5 个 slot 时）；给缓存留 slot 后更少 | — |
| 不开 MTP | 约 27–29 | — | — |

- BF16 单流解码受显存带宽限制，所以 A100（2.04 TB/s）比 G4（1.79 TB/s）快约 8%。
- MTP 的平均接受长度约 2.6，速度约翻倍。投机采样在理论上不改变输出分布。
- EAGLE-4 再快约 1.5–1.7 倍：单层 draft（0.44B 层参数）+ 低秩候选头，按实测的 draft/验证成本每轮选树形（深度、验证宽度）。
  G4 是 sm_120，只能用 Triton 内核和原生候选头，没有 B300 专用的 Gluon GDN 内核，所以加速比低于论文（B300 单卡 3.33×）。
- vLLM 默认用的 Rust 前端会忽略 `--enable-auto-tool-choice`，工具调用参数不生效，这也是不选 vLLM 的原因之一。

## 每个参数的来源

基准是 SGLang Cookbook（docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-27B）里 RTX PRO 6000 + BF16 的格子，在 v0.5.19 上验证过。
投机解码部分来自 EAGLE-4 的 SGLang quickstart（github.com/eagle-hq/EAGLE-4 docs/quickstart-sglang.md）。在此基础上：

- `--kv-cache-dtype bfloat16`：Cookbook 的所有格子都固定用 fp8_e4m3，这里改成 Playground 提供的 BF16 选项，保证原始精度。
- `--mamba-ssm-dtype float32`：与 config 里的 `mamba_ssm_dtype` 一致。
- `--chunked-prefill-size 2048`：Cookbook 对 SM120 的建议。不要改成 32768，在 80GB 卡上捕获 CUDA graph 时会 OOM，96GB 卡上也没有收益。
- `--mamba-radix-cache-strategy extra_buffer`：Low-Latency 层的设置，每个运行中的请求占 5 个 state slot。
- EAGLE-4 投机参数：`--speculative-algorithm EAGLE_HARNESS`、深度 12 / top-k 4 / 验证宽度 16、`{"mode":"serve"}`、draft 不量化、
  draft attention 用 flashinfer、`--speculative-attention-mode prefill`，全部照官方配方。官方配方里的 `--disable-radix-cache`、
  `--disable-overlap-schedule`、`--mamba-ssm-dtype bfloat16` 是为吞吐基准可复现设的，这里没有照搬：前缀缓存在 EAGLE-4 下
  实测正常，GDN 状态保持 fp32 原始精度。
- `--mem-fraction-static 0.92`（Cookbook 是 0.85）：EAGLE-4 比 MTP 多占约 10 GB（draft 权重 6.0 GB、draft KV 池按 KV token 数
  分配约 2.4 GB、宽度 16 的 GDN 中间状态 6.75 GB，MTP 宽度 4 只要约 1.7 GB）。0.92 下启动后仍余约 8 GB。
- 版本：SGLang 必须装 eagle-hq 索引里的 `0.5.23.dev252+eagle.4`，原版缺插件 hook；`eagle-harness-check` 会逐项检查。
- `--max-mamba-cache-size 40`：混合 GDN 模型的前缀缓存要求在分叉点存有 GDN 状态检查点（粒度为 64 token），这些检查点占用 state slot。实测只给 5 个 slot 时，丢弃思考内容或插入另一个会话后命中都会变成 0；给 40 个 slot 后都能命中。
- `--max-running-requests 2`：投机验证用的 GDN 中间状态按"并发数 × 验证宽度"预留。MTP 时代限制为 2 后从 5.06 GB 降到 1.69 GB；
  EAGLE-4 宽度 16、并发 2 占 6.75 GB，并发 1 占约 3.4 GB（容量 23.9 万，但后台请求会排队）。
- `--enable-cache-report`：让 usage 返回缓存命中数，Anthropic 接口据此填写 `cache_read_input_tokens`。只影响统计，不影响推理。
- `--chat-template`（assets/chat_template.jinja）：在官方模板的基础上，只加了 `reasoning_effort` 的取值映射（`high`、`max` → `xhigh`，`minimal`、`none` → `low`）。原生取值（不传 / `xhigh` / `medium` / `low`）的渲染结果和官方模板逐字一致，已验证。

## 缓存行为（实测）

- 每一轮能命中之前的全部历史，需要重新计算的是"上一轮模型输出 + 新消息"。上一轮输出较长时（约 2.5k token），生成的内容无法复用，原因未查明。所以每轮 TTFT 大约是"上一轮输出长度 ÷ prefill 速度"，再加约 0.1–0.5 s 的固定开销。
- 在 Claude Code 实测中，第 1 轮约 16k token 冷启动（system prompt 加工具定义），第 2 轮命中 16,384、新算 2,281，第 3 轮命中 17,536、新算 1,237。
- 缓存命中通过 Anthropic usage 的 `cache_read_input_tokens` 返回（`input_tokens` 为扣除命中后需要重新计算的部分），与服务端日志的 `#cached-token` 一致。这依赖 `--enable-cache-report`；不加时该字段恒为 0，Claude Code 状态栏等读取 usage 的工具会一直显示 0。`cache_creation_input_tokens` 始终为 0，SGLang 不报告缓存写入。
- 混合模型的命中还要求分叉点之前有 GDN 状态检查点。检查点只落在各请求 prompt 末尾和长 prefill 的 2048 块边界上，40 个槽位按 LRU 淘汰，大约 20–30 个请求之后就被挤掉。没有可用检查点时直接退回命中 0，即使那段 KV 还在显存里（Uncensored 版实测，脚本在 `prefix-cache-debug/`）。所以改动历史中较早的内容会导致整段重算。
- Claude Code（2.1.310）在正常工具循环、手动提问、改 CLAUDE.md 和 memory 时都只在末尾追加。真实会话里偶发的"工具循环中途命中 0"还没复现出来，触发条件未知。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 安装日志显示 `Using Python 3.13 environment at: /usr`，outlines-core 编译失败、缺 Rust | Colab 预设了 `UV_SYSTEM_PYTHON=true`，`VIRTUAL_ENV` 不生效。必须用 `uv pip install --python <venv>/bin/python` |
| 启动约 30 秒后 `STATE=FAILED`，日志显示 `FileNotFoundError: ... 'ninja'`（flashinfer JIT） | venv 的 bin 目录不在 PATH 上。`remote_serve.sh` 已经 `export PATH=/content/venv-sglang/bin:$PATH`，不要去掉 |
| Claude Code 报 `API Error: 500`，服务日志显示 `Unexpected reasoning effort high` | 没有加载修补过的模板。确认 `/content/chat_template.jinja` 已上传，并且启动日志里有 `Loading chat template from argument` |
| 启动时 OOM（捕获 prefill CUDA graph 阶段） | 不要调大 `--chunked-prefill-size`，`--mem-fraction-static` 不要超过 0.92（0.92 实测余约 8 GB）。核对显卡是不是 G4 |
| `wait_ready` 很快就报 READY，但实际连上的是旧服务 | 重启必须用 `remote_serve.sh start`，它会先等旧进程退出，并轮转日志；`remote_status.sh` 只看新日志 |
| `colab exec` 里执行 `pkill -f sglang...` 后，命令后半段没有执行 | pkill 匹配到了执行它的 shell 自身。模式要写成 `[s]glang` |
| 本地 `curl localhost:30000` 连不上 | 执行 `colab port-forward list`；如果 daemon 重启过，转发会消失，重新 `create 30000:30000` |
| 多轮对话 TTFT 突然变长（与总长度成正比） | 前缀失效。检查是否改了 effort、system prompt 或工具列表；回传历史时有没有丢掉思考内容（Anthropic 的 `thinking` 块、OpenAI 的 `reasoning_content`） |
| Claude Code 一直重试，服务日志反复出现 `Unexpected item type in content` 和 500 | 模型调用了 ToolSearch，结果里的 `tool_reference` 块 SGLang 不支持。`claude_env.sh` 已设 `ENABLE_TOOL_SEARCH=false`，确认是 source 过它的终端 |
| 非流式请求在 60 秒左右返回 502，但服务日志里是 200 | Colab port-forward 对超过约 60 s 才返回首字节的响应会断开。长 prefill 的请求要用流式（Claude Code 默认就是流式） |
| 首次启动比较慢（2–3 分钟） | Triton JIT 编译和 CUDA graph 捕获，属正常现象。同一个 runtime 上再次启动约 40 秒 |
| 日志出现 `Live cost cache ... is unavailable or invalid ... measuring again` | 正常。第一次启动没有成本缓存，前几个请求会边跑边测，之后写入 `/root/.cache/eagle-harness/costs/` |
| 启动报 `EAGLE_HARNESS` 未注册或 hook 不匹配 | venv 里不是 eagle-hq 的 SGLang 构建。重跑 `remote_setup.sh`（版本不对会自动重装），看 `/content/logs/eagle_check.log` |
| `max_total_num_tokens` 只有约 12.8 万 | `--mem-fraction-static` 被改回了 0.85。EAGLE-4 必须用 0.92 |
| 想回退到 MTP | 用 `eagle4/skill_backup_mtp_20261021/` 里的旧脚本（原版 SGLang 0.5.21），需要重建 venv |

## 许可

EAGLE-4 代码和 draft 使用 Eagle 4 Source-Available License（非 OSI 开源）。个人非商业使用、内部评估和研究在许可范围内；
用于付费产品、对外服务等商业用途需要另签商业协议（见 github.com/eagle-hq/EAGLE-4 的 LICENSE 与 COMMERCIAL-LICENSE-AGREEMENT.md）。
