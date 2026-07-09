FROM debian:bookworm-slim

ARG TARGETARCH
ARG DENO_VERSION=2.9.2
ARG DENO_AMD64_SHA256=5bc8a7a4a628360b391ddeac2efac7dec9e670b33156d831bf1e899070655173
ARG DENO_ARM64_SHA256=1a2b9903943f9741c4f5f0afc1e2002e0c5c7320b8487a7f192f7695cd36c9a1
ARG YTDLP_VERSION=2026.07.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    fonts-dejavu-core \
    python3 \
    python3-pip \
    unzip \
  && case "${TARGETARCH}" in \
      amd64) DENO_ARCH=x86_64; DENO_SHA256="${DENO_AMD64_SHA256}" ;; \
      arm64) DENO_ARCH=aarch64; DENO_SHA256="${DENO_ARM64_SHA256}" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}"; exit 1 ;; \
    esac \
  && curl -fsSL \
    "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${DENO_ARCH}-unknown-linux-gnu.zip" \
    -o /tmp/deno.zip \
  && unzip -p /tmp/deno.zip deno > /tmp/deno \
  && echo "${DENO_SHA256}  /tmp/deno" | sha256sum -c - \
  && install -m 0755 /tmp/deno /usr/local/bin/deno \
  && rm -f /tmp/deno /tmp/deno.zip \
  && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]==${YTDLP_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Bump to force a fresh container image rollout on Cloudflare.
ARG CARPO_ENCODER_BUILD=ytdlp-js-runtime-v3
RUN echo "$CARPO_ENCODER_BUILD" >/app/BUILD_ID
COPY encoder.py /app/encoder.py

EXPOSE 8080
CMD ["python3", "/app/encoder.py"]
