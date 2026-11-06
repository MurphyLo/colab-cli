# 用法：source ~/.agents/skills/colab-qwen38-deploy/scripts/claude_env.sh [本地端口，默认 30000]
# 然后在同一个终端里运行 `claude`，即使用 Colab 上自部署的 Qwen3.8-27B。
# Claude Code 读的是 ANTHROPIC_BASE_URL（不是 BASE_URL），且不带 /v1 后缀，它会自己拼 /v1/messages。
_QWEN_PORT=${1:-30000}
export ANTHROPIC_BASE_URL=http://localhost:${_QWEN_PORT}
export ANTHROPIC_AUTH_TOKEN=placeholder          # 服务端未设 --api-key，任意值即可
export ANTHROPIC_MODEL=Qwen/Qwen3.8-27B          # 必须等于服务端 --served-model-name
export ANTHROPIC_DEFAULT_OPUS_MODEL=Qwen/Qwen3.8-27B
export ANTHROPIC_DEFAULT_SONNET_MODEL=Qwen/Qwen3.8-27B
export ANTHROPIC_DEFAULT_HAIKU_MODEL=Qwen/Qwen3.8-27B   # 后台小任务也走同一个模型，否则会去请求不存在的 haiku
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# 不发系统提示词开头的 attribution 块（x-anthropic-billing-header，含按对话变化的指纹）。SGLang 不会剥掉它，
# 它会进 prompt：同一对话内虽稳定，但压缩后、子 agent 之间都不同，连系统提示词 + 工具定义的共同前缀都用不上缓存
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
# 关掉 tool search，所有工具在会话开始时一次性给出。开着时模型一旦调用 ToolSearch，结果里的 tool_reference 块
# SGLang 转换不了（500 Unexpected item type in content），Claude Code 只对 400/422 降级，会一直重试卡住；
# 即使能转换，工具列表中途变长也会改动模板开头的 system 段，整段前缀缓存失效
export ENABLE_TOOL_SEARCH=false
# 压缩窗口 = 输入 + 输出的总上限：Claude Code 会从窗口里扣掉最大输出（未知模型默认 32,000）再决定何时压缩，
# 实际约在输入 16.8 万时触发。窗口只需不超过 KV 容量 210,810，剩约 1 万给并发的后台请求。
# 不认识的模型 ID 本来就按 200K 处理，这里显式写出来，避免依赖默认值；超过 200K 还要另设 CLAUDE_CODE_MAX_CONTEXT_TOKENS
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000
unset _QWEN_PORT
echo "Claude Code -> $ANTHROPIC_BASE_URL ($ANTHROPIC_MODEL)。启动时出现 [claude-code:unrecognized_model] 提示属正常。"
