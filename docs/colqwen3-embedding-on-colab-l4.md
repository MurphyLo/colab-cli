# 在 Colab L4 上运行 Ops-ColQwen3-4B 多向量嵌入

本文档记录使用 colab-cli 在 Google Colab L4 GPU 上运行 [OpenSearch-AI/Ops-Colqwen3-4B](https://huggingface.co/OpenSearch-AI/Ops-Colqwen3-4B) 多向量嵌入任务的完整过程，包括环境配置中需要注意的依赖冲突问题。

## 性能概览

| 项目 | 数据 |
|---|---|
| GPU | NVIDIA L4 (24 GB) |
| 模型 | Ops-ColQwen3-4B, fp16, flash_attention_2 |
| 输入 | 304 页 PDF 中间 50 页，200 DPI 渲染 (1220×1840 px) |
| Batch size | 1 |
| 总嵌入耗时 | 22.8s（不含模型加载） |
| 平均每页 | 0.46s |
| 每页输出 | (1261, 2560) — 1261 token × 2560 维 |
| GPU 峰值显存 | 16.56 GB |

## 1. 创建 Runtime

```bash
node --use-env-proxy dist/index.js runtime create --accelerator L4
```

L4 属于 high-mem-only 加速器，CLI 会自动使用 `--shape highmem`。

## 2. 安装 Python 依赖

### 2.1 核心依赖

```bash
node --use-env-proxy dist/index.js exec "
%pip install pillow 'transformers>=4.57.0' 'qwen-vl-utils>=0.0.14' 'torch==2.8.0'
"
```

### 2.2 ⚠️ 坑点：torchvision / torchaudio 版本冲突

Colab 预装的 `torchvision==0.25.0` 和 `torchaudio==2.10.0` 硬绑定 `torch==2.10.0`。降级 torch 到 2.8.0 后，`qwen-vl-utils` 导入 `torchvision` 时会报错：

```
RuntimeError: operator torchvision::nms does not exist
```

**必须同时安装匹配版本：**

```bash
node --use-env-proxy dist/index.js exec "
%pip install 'torchvision==0.23.0' 'torchaudio==2.8.0'
"
```

torch 与 torchvision/torchaudio 的版本对应关系参见 [PyTorch 官方兼容矩阵](https://pytorch.org/get-started/previous-versions/)。

### 2.3 安装 Flash Attention

使用预编译 wheel 安装，避免从源码编译（编译需 20+ 分钟且可能失败）：

```bash
node --use-env-proxy dist/index.js exec "
%pip install https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu12torch2.8cxx11abiTRUE-cp312-cp312-linux_x86_64.whl
"
```

> wheel 文件名中的关键参数：`cu12`（CUDA 12）、`torch2.8`、`cp312`（Python 3.12）。选错任何一项都会导致运行时 segfault 或加载失败。可在 [flash-attention releases](https://github.com/Dao-AILab/flash-attention/releases) 页面查找适配的 wheel。

### 2.4 安装 PDF 处理依赖

```bash
node --use-env-proxy dist/index.js exec "%pip install pymupdf -q"
```

### 2.5 ⚠️ 坑点：numpy 版本冲突

如果同时安装了 `opensearch-py-ml`（依赖 `numpy>=2.3.2`），它会把 numpy 升级到 2.4.x，导致 Colab 预装的 `scipy` 和 `scikit-learn` 崩溃：

```
AttributeError: module 'numpy._core._multiarray_umath' has no attribute '_blas_supports_fpe'
```

这个错误会沿着 `scipy → sklearn → transformers.generation` 的导入链传播，最终表现为 `transformers` 的 `AutoModel` 无法导入。

**解决方案：** 降级 numpy 回 Colab 默认版本：

```bash
node --use-env-proxy dist/index.js exec "%pip install 'numpy<2.1'"
```

> 如果确实需要 `opensearch-py-ml`，需要同时升级 `scipy` 和 `scikit-learn` 到支持 numpy 2.4 的版本，但这可能引发更多连锁冲突。建议仅在嵌入阶段避免安装 `opensearch-py-ml`。

### 2.6 重启内核

安装完所有包后必须重启内核，使新版本的 C 扩展模块（torch、flash-attn 等）生效：

```bash
node --use-env-proxy dist/index.js runtime restart
```

## 3. 运行嵌入任务

### 3.1 完整脚本

```python
import sys, os, time, pickle, io
import torch
import fitz  # PyMuPDF
from PIL import Image

# 将 HF 模型缓存路径加入 sys.path，以便导入 scripts/ 目录下的 embedder
from huggingface_hub import snapshot_download
model_path = snapshot_download('OpenSearch-AI/Ops-Colqwen3-4B')
sys.path.insert(0, model_path)
from scripts.ops_colqwen3_embedder import OpsColQwen3Embedder

# ── 1. PDF → 图像 ──────────────────────────────────────────
pdf_path = '/tmp/input.pdf'
doc = fitz.open(pdf_path)
total_pages = len(doc)

# 取中间 50 页
n = 50
start = (total_pages - n) // 2
end = start + n

dpi = 200
zoom = dpi / 72
mat = fitz.Matrix(zoom, zoom)

images = []
for i in range(start, end):
    pix = doc[i].get_pixmap(matrix=mat)
    img = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
    images.append(img)
doc.close()
print(f'Rendered {len(images)} pages ({start+1}-{end}), size: {images[0].size}')

# ── 2. 初始化模型 ──────────────────────────────────────────
embedder = OpsColQwen3Embedder(
    model_name='OpenSearch-AI/Ops-Colqwen3-4B',
    dims=2560,
    dtype=torch.float16,
    attn_implementation='flash_attention_2',
)

# ── 3. 逐页嵌入 (bs=1) ────────────────────────────────────
all_embeddings = []
t_start = time.time()
for i, img in enumerate(images):
    emb = embedder.encode_images([img])
    all_embeddings.append(emb[0])
    if (i + 1) % 10 == 0:
        print(f'  [{i+1}/{n}] {time.time() - t_start:.1f}s')

total_time = time.time() - t_start
print(f'Total: {total_time:.1f}s, avg: {total_time/len(images):.2f}s/page')
print(f'Shape: {all_embeddings[0].shape}')
print(f'GPU peak mem: {torch.cuda.max_memory_allocated()/1024**3:.2f} GB')
```

### 3.2 通过 colab-cli 执行

```bash
# 将上述脚本保存为 embed.py，然后：
node --use-env-proxy dist/index.js exec -f embed.py
```

## 4. 注意事项汇总

| 问题 | 现象 | 解决方案 |
|---|---|---|
| torch 降级后 torchvision 崩溃 | `RuntimeError: operator torchvision::nms does not exist` | 同步安装 `torchvision==0.23.0` `torchaudio==2.8.0` |
| numpy 被拉高到 2.4.x | `AttributeError: ... _blas_supports_fpe` 导致 transformers 无法导入 | `pip install 'numpy<2.1'` |
| flash-attn 从源码编译失败 | 编译超时 / CUDA 版本不匹配 | 使用预编译 wheel，注意匹配 CUDA、torch、Python 版本 |
| `import fitz` 失败 | `ModuleNotFoundError: No module named 'fitz'` | `pip install pymupdf` |
| pip install 后新包不生效 | 仍然 import 到旧版本 | 必须 `runtime restart` 重启内核 |
| 模型 `scripts/` 无法 import | `ModuleNotFoundError` | 需将 `snapshot_download()` 返回的路径加入 `sys.path` |

## 5. 依赖版本参考（已验证可用）

```
torch==2.8.0+cu128
torchvision==0.23.0
torchaudio==2.8.0
transformers==5.0.0
flash-attn==2.8.3
qwen-vl-utils==0.0.14
pillow==11.3.0
numpy==2.0.2
pymupdf (latest)
```

Colab 环境：Python 3.12, CUDA 12.8, NVIDIA L4 (24 GB)。
