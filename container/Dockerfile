FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    python3-pip \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp boto3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY encoder.py /app/encoder.py

EXPOSE 8080
CMD ["python3", "/app/encoder.py"]
