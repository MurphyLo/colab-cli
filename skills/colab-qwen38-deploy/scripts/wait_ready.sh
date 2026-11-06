#!/bin/bash
# 本地执行：bash wait_ready.sh <endpoint> [超时秒数，默认 900]
# 轮询远端 remote_status.sh，直到 READY（exit 0）或 FAILED/DEAD/超时（exit 1）。
E=$1; LIMIT=${2:-900}; start=$(date +%s)
while true; do
  out=$(colab exec --endpoint "$E" "import subprocess;print(subprocess.run(['bash','/content/remote_status.sh'],capture_output=True,text=True).stdout)" 2>/dev/null)
  state=$(echo "$out" | grep -oE "STATE=[A-Z_]+" | head -1)
  case $state in
    STATE=READY) echo "$out" | grep -vE "Connecting"; exit 0 ;;
    STATE=FAILED|STATE=DEAD) echo "$out" | grep -vE "Connecting"; exit 1 ;;
  esac
  if [ $(( $(date +%s) - start )) -gt $LIMIT ]; then echo "TIMEOUT after ${LIMIT}s, last: $state"; echo "$out"; exit 1; fi
  sleep 15
done
