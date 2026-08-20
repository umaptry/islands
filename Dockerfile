# Hugging Face Space / Cloud Run / any Docker host.
#
# No torch. The embedding model runs through ONNX Runtime and the frozen UMAP
# encoder runs in numpy, which takes the image from ~1.9GB to roughly 900MB and
# resident memory from ~1,250MB to ~965MB.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/app/.cache/huggingface \
    OMP_NUM_THREADS=1 \
    PORT=7860

WORKDIR /app

# Hugging Face Spaces runs as uid 1000 and cannot write to root-owned paths.
RUN useradd -m -u 1000 user && mkdir -p /app/.cache && chown -R user /app
USER user
ENV PATH=/home/user/.local/bin:$PATH

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# Bake the ONNX model and tokenizer in, so a cold start answers immediately
# instead of downloading 465MB first. Set KOTOBA_FETCH_MODEL_AT_START=1 at build
# time to skip this and keep the image ~465MB smaller (see README).
ARG KOTOBA_FETCH_MODEL_AT_START=0
RUN if [ "$KOTOBA_FETCH_MODEL_AT_START" = "0" ]; then \
      python -c "from huggingface_hub import hf_hub_download as d; r='intfloat/multilingual-e5-small'; d(r,'onnx/model.onnx'); d(r,'tokenizer.json')"; \
    fi

COPY --chown=user artifacts/ ./artifacts/
COPY --chown=user core/ ./core/
COPY --chown=user web/ ./web/
COPY --chown=user app.py .

EXPOSE 7860
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
