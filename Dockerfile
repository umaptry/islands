# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 PORT=7860
WORKDIR /app
RUN useradd -m -u 1000 user && chown user:user /app
USER user
ENV PATH=/home/user/.local/bin:$PATH
COPY --chown=user requirements.txt ./
RUN pip install --no-cache-dir --user -r requirements.txt
COPY --chown=user core/ ./core/
COPY --chown=user web/ ./web/
COPY --chown=user app.py ./
EXPOSE 7860
CMD ["python", "app.py"]

# This context directory contains only the four verified map files.
FROM base AS gemini
ARG MAP_ARTIFACTS_SOURCE=.release-artifacts
COPY --chown=user ${MAP_ARTIFACTS_SOURCE}/ /app/artifacts/
ENV EMBEDDING_PROVIDER=gemini MAP_ARTIFACTS_DIR=/app/artifacts MAP_RUNTIME_CHECK=1
RUN python -c "from core.artifact_manifest import validate_manifest; validate_manifest('/app/artifacts', 'gemini')"
RUN python -c "import importlib.util; assert all(importlib.util.find_spec(n) is None for n in ('onnxruntime','tokenizers','huggingface_hub','torch','umap'))"

# Default target retains E5 development and offline rollback support.
FROM base AS onnx
COPY --chown=user requirements-onnx.txt ./
RUN pip install --no-cache-dir --user -r requirements-onnx.txt
ENV HF_HOME=/app/.cache/huggingface EMBEDDING_PROVIDER=onnx MAP_ARTIFACTS_DIR=/app/artifacts
ARG HF_REVISION=614241f622f53c4eeff9890bdc4f31cfecc418b3
ARG ONNX_SHA256=ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665
ARG TOKENIZER_SHA256=0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39
RUN HF_REVISION="${HF_REVISION}" ONNX_SHA256="${ONNX_SHA256}" TOKENIZER_SHA256="${TOKENIZER_SHA256}" python - <<'PY'
import hashlib
import os
from huggingface_hub import hf_hub_download
for filename, expected in (("onnx/model.onnx", os.environ["ONNX_SHA256"]), ("tokenizer.json", os.environ["TOKENIZER_SHA256"])):
    path = hf_hub_download("intfloat/multilingual-e5-small", filename, revision=os.environ["HF_REVISION"])
    with open(path, "rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != expected:
            raise RuntimeError(f"Checksum mismatch: {filename}")
PY
ENV HF_HUB_OFFLINE=1
COPY --chown=user artifacts/ /app/artifacts/
RUN python -c "from core.artifact_manifest import validate_manifest; validate_manifest('/app/artifacts', 'onnx')"
