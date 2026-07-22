ARG BGUTIL_PROVIDER_VERSION=1.3.1
ARG BGUTIL_PROVIDER_SHA256=b5400343482820062372e997cc0c9ace18637f8e774cf70b22c58b89b99e9abe

FROM node:25-bookworm-slim AS bgutil-provider

ARG BGUTIL_PROVIDER_VERSION
ARG BGUTIL_PROVIDER_SHA256

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL \
    "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_PROVIDER_VERSION}.tar.gz" \
    -o /tmp/bgutil-provider.tar.gz \
  && echo "${BGUTIL_PROVIDER_SHA256}  /tmp/bgutil-provider.tar.gz" | sha256sum -c - \
  && mkdir -p /opt/bgutil-ytdlp-pot-provider \
  && tar -xzf /tmp/bgutil-provider.tar.gz \
    --strip-components=1 \
    -C /opt/bgutil-ytdlp-pot-provider \
  && rm -f /tmp/bgutil-provider.tar.gz \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/bgutil-ytdlp-pot-provider/server
RUN npm ci --omit=dev --no-audit --no-fund

FROM debian:bookworm-slim

ARG TARGETARCH
ARG DENO_VERSION=2.9.2
ARG DENO_AMD64_SHA256=5bc8a7a4a628360b391ddeac2efac7dec9e670b33156d831bf1e899070655173
ARG DENO_ARM64_SHA256=1a2b9903943f9741c4f5f0afc1e2002e0c5c7320b8487a7f192f7695cd36c9a1
ARG YTDLP_VERSION=2026.07.04
ARG BGUTIL_PROVIDER_VERSION

ENV DENO_DIR=/opt/deno-cache \
    DENO_NO_PROMPT=1 \
    DENO_NO_UPDATE_CHECK=1 \
    BGUTIL_PROVIDER_VERSION=${BGUTIL_PROVIDER_VERSION} \
    BGUTIL_PROVIDER_HOME=/opt/bgutil-ytdlp-pot-provider/server \
    YOUTUBE_PO_TOKEN_MODE=bgutil

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
  && pip3 install --no-cache-dir --break-system-packages \
    "yt-dlp[default]==${YTDLP_VERSION}" \
    "bgutil-ytdlp-pot-provider==${BGUTIL_PROVIDER_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bgutil-provider \
  /opt/bgutil-ytdlp-pot-provider/server \
  /opt/bgutil-ytdlp-pot-provider/server

RUN cd /opt/bgutil-ytdlp-pot-provider/server \
  && deno cache --frozen src/generate_once.ts

WORKDIR /app
# Bump to force a fresh container image rollout on Cloudflare.
ARG CARPO_ENCODER_BUILD=youtube-po-token-bgutil-v1
RUN echo "$CARPO_ENCODER_BUILD" >/app/BUILD_ID
COPY encoder.py /app/encoder.py

EXPOSE 8080
CMD ["python3", "/app/encoder.py"]
