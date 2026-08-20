# Cloud Run / any Docker host. (Hugging Face Docker Spaces now need a paid
# plan to create - see the deploy section of README.md.)
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

# Run as a non-root uid that owns /app, so the HF_HOME cache below is
# writable at container start. uid 1000 also matches what HF Spaces expects.
RUN useradd -m -u 1000 user && mkdir -p /app/.cache && chown -R user /app
USER user
ENV PATH=/home/user/.local/bin:$PATH

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# The model is fetched at container start by default, which keeps the image
# under the 0.5GB/month Artifact Registry free allowance. The cost is a ~20s
# longer cold start, which the keep-alive ping hides (see README).
#
# Build with --build-arg KOTOBA_FETCH_MODEL_AT_START=0 to bake the 448MB fp32
# ONNX and the tokenizer into the image instead: cold starts answer immediately,
# but the image goes back to ~900MB.
ARG KOTOBA_FETCH_MODEL_AT_START=1
RUN if [ "$KOTOBA_FETCH_MODEL_AT_START" = "0" ]; then \
      python -c "from huggingface_hub import hf_hub_download as d; r='intfloat/multilingual-e5-small'; d(r,'onnx/model.onnx'); d(r,'tokenizer.json')"; \
    fi

COPY --chown=user artifacts/ ./artifacts/
COPY --chown=user core/ ./core/
COPY --chown=user web/ ./web/
COPY --chown=user app.py .

EXPOSE 7860
# Not `uvicorn --port 7860`: Cloud Run injects $PORT (8080) and a hardcoded port
# makes the container fail its startup probe. app.py's __main__ branch already
# reads $PORT and falls back to 7860, so defer to it.
CMD ["python", "app.py"]
