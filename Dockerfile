# Hugging Face Space (SDK: docker).
#
# torch is unavoidable: sentence-transformers needs it to run the embedding
# model. What we CAN avoid is the CUDA build, which a plain `pip install torch`
# would pull in (~2.5GB of GPU libraries that a free CPU Space can never use).
# Installing from PyTorch's CPU index first brings the image to roughly 1.9GB.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/app/.cache/huggingface \
    PORT=7860

WORKDIR /app

# A Space runs as uid 1000 and cannot write to root-owned paths.
RUN useradd -m -u 1000 user && mkdir -p /app/.cache && chown -R user /app
USER user
ENV PATH=/home/user/.local/bin:$PATH

# CPU-only torch first, so the requirements.txt pin below is already satisfied
# and pip never reaches for the CUDA wheel on PyPI.
RUN pip install --no-cache-dir --user --index-url https://download.pytorch.org/whl/cpu torch==2.7.1

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# Bake the embedding model into the image so a cold start does not have to
# download ~470MB before it can answer the first request.
RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('intfloat/multilingual-e5-small')"

COPY --chown=user artifacts/ ./artifacts/
COPY --chown=user core/ ./core/
COPY --chown=user web/ ./web/
COPY --chown=user app.py .

EXPOSE 7860
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
