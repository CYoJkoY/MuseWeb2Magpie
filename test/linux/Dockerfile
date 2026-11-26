# Linux test bed: Node 22 + Debian Chromium, no desktop, running as root (so --no-sandbox applies).
#   docker build -t magpie-muse-web-linux-test test/linux
#   docker run --rm -v "$PWD:/plugin:ro" -w /plugin magpie-muse-web-linux-test node --test contract.test.ts "test/*.test.ts"
# Behind a proxy, add --build-arg http_proxy=... --build-arg https_proxy=... to the build.
FROM golang:1.27.4-bookworm AS toolchain
FROM node:22-bookworm-slim
COPY --from=toolchain /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"
ARG http_proxy
ARG https_proxy
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
