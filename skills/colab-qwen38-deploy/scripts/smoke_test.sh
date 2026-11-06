#!/bin/bash
# 本地执行：bash smoke_test.sh [本地端口，默认 30000]
# 通过 port-forward 验证 Anthropic Messages API：模型列表、effort=high（Claude Code 默认）、流式、工具调用。
P=${1:-30000}; U=http://localhost:$P; H=(-H 'content-type: application/json' -H 'anthropic-version: 2023-06-01')
fail=0
echo "== GET /v1/models"
curl -s -m 30 $U/v1/models | grep -q '"Qwen/Qwen3.8-27B"' && echo "OK" || { echo "FAIL"; fail=1; }

echo "== POST /v1/messages (effort=high)"
r=$(curl -s -m 180 $U/v1/messages "${H[@]}" -d '{"model":"Qwen/Qwen3.8-27B","max_tokens":400,"output_config":{"effort":"high"},"messages":[{"role":"user","content":"1+1=? Answer with the number only."}]}')
echo "$r" | grep -q '"type":"message"' && echo "OK" || { echo "FAIL: ${r:0:300}"; fail=1; }

echo "== POST /v1/messages stream"
s=$(curl -sN -m 180 $U/v1/messages "${H[@]}" -d '{"model":"Qwen/Qwen3.8-27B","max_tokens":200,"stream":true,"messages":[{"role":"user","content":"hi"}]}')
echo "$s" | grep -q "event: message_stop" && echo "OK" || { echo "FAIL: ${s:0:300}"; fail=1; }

echo "== POST /v1/messages tools"
t=$(curl -s -m 300 $U/v1/messages "${H[@]}" -d '{"model":"Qwen/Qwen3.8-27B","max_tokens":1500,"tools":[{"name":"get_weather","description":"Get weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"messages":[{"role":"user","content":"What is the weather in Beijing? Use the tool."}]}')
echo "$t" | grep -q '"stop_reason":"tool_use"' && echo "OK" || { echo "FAIL: ${t:0:300}"; fail=1; }

[ $fail = 0 ] && echo "SMOKE_OK" || echo "SMOKE_FAILED"
