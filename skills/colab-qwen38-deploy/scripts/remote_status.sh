#!/bin/bash
# 远端执行（Colab runtime）：bash /content/remote_status.sh
# 输出一行 STATE=<READY|BOOTING|FAILED|DEAD|NOT_STARTED>，以及关键日志行。
LOG=/content/logs/serve.log
[ -f $LOG ] || { echo "STATE=NOT_STARTED"; exit 0; }
alive=0; pgrep -f "[s]glang.launch_server" >/dev/null && alive=1
err=$(grep -m1 -E "Traceback|OutOfMemoryError|CUDA out of memory|RuntimeError" $LOG | cut -c1-300)
if grep -q "The server is fired up and ready to roll" $LOG && [ $alive = 1 ]; then
  echo "STATE=READY"
elif [ -n "$err" ] && [ $alive = 0 ]; then
  echo "STATE=FAILED"; echo "ERR: $err"; tail -n 15 $LOG | cut -c1-300
elif [ $alive = 0 ]; then
  echo "STATE=DEAD"; tail -n 15 $LOG | cut -c1-300
else
  echo "STATE=BOOTING"; tail -n 2 $LOG | tr '\r' '\n' | tail -n 1 | cut -c1-200
fi
grep -hoE "max_total_num_tokens=[0-9]+|max_running_requests=[0-9]+|context_len=[0-9]+" $LOG | sort -u | tr '\n' ' '; echo
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader
