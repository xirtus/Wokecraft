# syntax=docker/dockerfile:1
# ==============================================================================
# Celandia: Xirtoth Survivors & MMO — Production Host & World Server Container
# ==============================================================================

FROM rust:1.85-bookworm AS builder
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev clang lld nodejs npm \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY scripts ./scripts

# Build both:
# 1. `wenilla-host` (HTTP + WebSocket game host serving /data + /ws/{3724,8085})
# 2. `celandia-server` (Authoritative 1.12.1 SRP6 Auth :3724 + World :8085 MMO Server)
RUN cargo build --release -p wenilla-host -p celandia-server

# Runtime image
FROM debian:bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data

COPY --from=builder /build/target/release/wenilla-host /usr/local/bin/wenilla-host
COPY --from=builder /build/target/release/celandia-server /usr/local/bin/celandia-server
COPY WoW/Data /app/WoW/Data
COPY web /app/www

ENV BIND_ADDR="0.0.0.0:8090"
ENV UPSTREAM_HOST="127.0.0.1"
ENV RUST_LOG="info"

EXPOSE 8090 3724 8085

CMD ["sh", "-c", "wenilla-host --bind ${BIND_ADDR} --www /app/www --data /app/WoW/Data --upstream ${UPSTREAM_HOST}"]
