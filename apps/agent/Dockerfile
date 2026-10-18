# Coding Sandbox のイメージ。sandbox-shim（Files が使う）は SDK と同じタグの公式イメージから取る。
FROM docker.io/cloudflare/sandbox:1.0.1 AS shim

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
# コンテナを生かしておくだけ。実処理は ctx.container.exec で行う。
CMD ["sleep", "infinity"]
