#!/bin/bash
# 远端执行（Colab runtime）：bash /content/remote_setup.sh
# 并行完成 BF16 权重下载 + EAGLE-4 draft 下载 + SGLang（EAGLE-4 版）venv 安装。可重复执行：已完成的步骤自动跳过。
# 最后一行输出 SETUP_OK 或 SETUP_FAILED。日志在 /content/logs/。
set -u
mkdir -p /content/logs /content/models
MODEL_DIR=/content/models/Qwen3.8-27B
DRAFT_DIR=/content/models/Qwen3.8-27B-EAGLE4
VENV=/content/venv-sglang
# 版本钉自 github.com/eagle-hq/EAGLE-4 的 docs/release.env（v0.1.0）。
# 原版 PyPI 的 sglang 没有 EAGLE-4 插件需要的 hook，必须装 eagle-hq 索引里的这个构建。
SGLANG_VERSION=0.5.23.dev252+eagle.4
EAGLE_VERSION=0.1.0

pip install -q -U uv "huggingface_hub[hf_xet]" >/content/logs/pip_base.log 2>&1

shards_ok() { [ "$(ls $MODEL_DIR/model-*-of-00018.safetensors 2>/dev/null | wc -l)" = 18 ]; }
draft_ok() { [ -f $DRAFT_DIR/model.safetensors ] && [ -f $DRAFT_DIR/config.json ]; }
venv_ok() {
  $VENV/bin/python -c "import sglang, eagle_harness, torch; assert sglang.__version__ == '$SGLANG_VERSION'; assert torch.cuda.is_available()" >/dev/null 2>&1
}

if shards_ok; then echo "[setup] 权重已存在，跳过下载"; else
(
  hf download Qwen/Qwen3.8-27B --local-dir $MODEL_DIR >/content/logs/download.log 2>&1
  echo "DOWNLOAD_EXIT=$?" >>/content/logs/download.log
) &
fi

if draft_ok; then echo "[setup] EAGLE-4 draft 已存在，跳过下载"; else
(
  hf download EAGLE-Corp/Qwen3.8-27B-EAGLE4 --local-dir $DRAFT_DIR >/content/logs/download_draft.log 2>&1
  echo "DRAFT_EXIT=$?" >>/content/logs/download_draft.log
) &
fi

if venv_ok; then echo "[setup] SGLang venv 已就绪，跳过安装"; else
(
  rm -rf $VENV
  uv venv -q -p 3.12 $VENV
  # Colab 预设 UV_SYSTEM_PYTHON=true：必须 --python 指定 venv，否则会装进系统 Python 3.13 并失败。
  # Colab 驱动 580 对应 CUDA 13.0，torch 用 cu130；sglang 构建在 eagle-hq 的 cu130 索引，cuda-tile 在 pypi.nvidia.com。
  uv pip install --python $VENV/bin/python --torch-backend=cu130 --prerelease=allow \
    --index-strategy unsafe-best-match \
    --extra-index-url https://eagle-hq.github.io/EAGLE-4/whl/cu130/ \
    --extra-index-url https://pypi.nvidia.com \
    "sglang==$SGLANG_VERSION" 'flashinfer-python>=0.7.2' "eagle-harness==$EAGLE_VERSION" \
    >/content/logs/install_sglang.log 2>&1
  echo "SGLANG_EXIT=$?" >>/content/logs/install_sglang.log
) &
fi

wait
if shards_ok && draft_ok && venv_ok; then
  # 插件 hook 检查：引擎缺 hook 时插件不会注册，服务端会拒绝 EAGLE_HARNESS
  (cd /content && $VENV/bin/eagle-harness-check >/content/logs/eagle_check.log 2>&1)
  if grep -q "every hook matches" /content/logs/eagle_check.log; then
    $VENV/bin/python -c "import sglang, torch; from importlib.metadata import version; print('[setup] sglang', sglang.__version__, '| eagle-harness', version('eagle-harness'), '| torch', torch.__version__)"
    echo "SETUP_OK"
  else
    cat /content/logs/eagle_check.log
    echo "SETUP_FAILED"
  fi
else
  echo "[setup] 权重分片数: $(ls $MODEL_DIR/model-*-of-00018.safetensors 2>/dev/null | wc -l)/18；draft: $(draft_ok && echo ok || echo missing)"
  tail -n 5 /content/logs/download.log /content/logs/download_draft.log /content/logs/install_sglang.log 2>/dev/null
  echo "SETUP_FAILED"
fi
