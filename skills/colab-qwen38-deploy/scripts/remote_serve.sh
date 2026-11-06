#!/bin/bash
# 远端执行（Colab runtime）：bash /content/remote_serve.sh start|stop
# start：先停掉已有服务并确认进程退出，再以推荐配置启动 SGLang（端口 30000），立即返回。
# 日志：/content/logs/serve.log（旧日志轮转为 serve.log.<时间戳>）
set -u
ACTION=${1:-start}
LOG=/content/logs/serve.log

# 注意：模式写成 [s]glang，避免 pkill -f 匹配到执行本命令的 shell 自身
stop_server() {
  pkill -f "[s]glang.launch_server" 2>/dev/null
  for i in $(seq 1 30); do
    pgrep -f "[s]glang.launch_server|[s]glang::" >/dev/null || return 0
    sleep 2
  done
  pkill -9 -f "[s]glang.launch_server|[s]glang::" 2>/dev/null
  sleep 3
}

stop_server
[ "$ACTION" = stop ] && { echo "STOPPED"; exit 0; }

mkdir -p /content/logs
[ -f $LOG ] && mv $LOG $LOG.$(date +%Y%m%d-%H%M%S)

# flashinfer 首次运行要 JIT 编译，需要 PATH 上有 ninja；venv 未激活时它不在 PATH 里，
# 全新 runtime 会报 FileNotFoundError: 'ninja'
export PATH=/content/venv-sglang/bin:$PATH TOKENIZERS_PARALLELISM=false
# 不能在 EAGLE-4 源码 checkout 里启动，否则 python -m 会导入源码树而不是装好的包
cd /content

# 推荐配置（G4 = RTX PRO 6000 Blackwell 96GB，2026-10-21 实测，对照数据见 references/notes.md）
# - 公共部分沿用 2026-10-03 验证过的 MTP 配置（SGLang Cookbook RTX PRO 6000 + BF16 格子为基础）：
#   --kv-cache-dtype bfloat16（原始精度）、fp32 GDN 状态、extra_buffer 前缀缓存 + 40 个 state slot、
#   --chat-template 的 reasoning_effort 映射、--enable-cache-report
# - 投机解码：EAGLE-4（eagle-hq/EAGLE-4 v0.1.0 + EAGLE-Corp/Qwen3.8-27B-EAGLE4 draft），
#   树形上限取官方 B300 配方：深度 12、top-k 4、验证宽度 16；每轮实际树形由实测成本自动选择（mode=serve）。
#   单用户解码约 96 tok/s（MTP 约 55），贪心分叉全部是 near-tie（logprob 差 ≤ 0.125），不改变模型能力。
# - --mem-fraction-static 0.92（原 0.85）：EAGLE-4 的 draft 权重、draft KV 池和宽度 16 的 GDN 中间状态
#   比 MTP 多占约 10 GB，0.85 下 KV 只有 128,379；0.92 下 210,810，启动后仍余约 8 GB，
#   19.2 万 token 单请求 prefill 实测无 OOM。
# - --max-running-requests 2：GDN 中间状态按"并发 × 验证宽度"预留，2 个并发占 6.75 GB。
nohup /content/venv-sglang/bin/python -m sglang.launch_server \
  --trust-remote-code \
  --model-path /content/models/Qwen3.8-27B --served-model-name Qwen/Qwen3.8-27B \
  --chat-template /content/chat_template.jinja \
  --kv-cache-dtype bfloat16 --mamba-ssm-dtype float32 \
  --mem-fraction-static 0.92 \
  --attention-backend flashinfer \
  --chunked-prefill-size 2048 \
  --reasoning-parser qwen3 --tool-call-parser qwen3_coder --enable-cache-report \
  --mamba-radix-cache-strategy extra_buffer \
  --speculative-algorithm EAGLE_HARNESS \
  --speculative-draft-model-path /content/models/Qwen3.8-27B-EAGLE4 \
  --speculative-draft-model-quantization unquant \
  --speculative-draft-attention-backend flashinfer --speculative-attention-mode prefill \
  --speculative-num-steps 12 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 \
  --speculative-algorithm-config '{"mode":"serve"}' \
  --max-mamba-cache-size 40 --max-running-requests 2 \
  --host 0.0.0.0 --port 30000 >$LOG 2>&1 &
echo "STARTED PID=$! LOG=$LOG"
