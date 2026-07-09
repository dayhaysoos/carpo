FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    fonts-dejavu-core \
    python3 \
    python3-pip \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Bump to force a fresh container image rollout on Cloudflare.
ARG CARPO_ENCODER_BUILD=slice-6-youtube-fail-fast
RUN echo "$CARPO_ENCODER_BUILD" >/app/BUILD_ID
COPY encoder.py /app/encoder.py

EXPOSE 8080
CMD ["python3", "/app/encoder.py"]
