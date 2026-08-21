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

# The 449MB fp32 ONNX and the 17MB tokenizer are baked into the image.
#
# They used to be fetched on first start, which halved the image and kept it
# inside the 0.5GB/month Artifact Registry free allowance. That traded registry
# bytes for a start-up that depended on huggingface.co being reachable AND not
# rate-limiting, and on 2026-08-21 that bill came due: two deploys in a row died
# with `429 Too Many Requests` on the tokenizer, the container never answered
# its port, and Cloud Run's 4-minute startup probe timed out. Nothing reached
# production - Cloud Run refuses to shift traffic to a revision that never went
# healthy - but the deploy could not land either.
#
# Baking them in costs roughly $0.05/month of registry storage (keep exactly one
# image; see the cleanup step in README.md) and buys a container start that does
# no network I/O at all, which is the property a live demo actually needs.
RUN python -c "from huggingface_hub import hf_hub_download as d; r='intfloat/multilingual-e5-small'; d(r,'onnx/model.onnx'); d(r,'tokenizer.json')"

# Resolve both files from the cache above and never call the Hub. Without this,
# hf_hub_download still makes one metadata request per file at start-up, and
# that is exactly the call that was returning 429.
ENV HF_HUB_OFFLINE=1

COPY --chown=user artifacts/ ./artifacts/
COPY --chown=user core/ ./core/
COPY --chown=user web/ ./web/
COPY --chown=user app.py .

EXPOSE 7860
# Not `uvicorn --port 7860`: Cloud Run injects $PORT (8080) and a hardcoded port
# makes the container fail its startup probe. app.py's __main__ branch already
# reads $PORT and falls back to 7860, so defer to it.
CMD ["python", "app.py"]
