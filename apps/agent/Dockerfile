# Coding Sandbox のイメージ。sandbox-shim（Files が使う）は SDK と同じタグの公式イメージから取る。
FROM docker.io/cloudflare/sandbox:1.0.1 AS shim

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
# npm は audit の POST が外向き制御で 403 になるので既定で無効にする
RUN npm config set audit false --global && npm config set fund false --global
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
# コンテナを生かしておくだけ。実処理は ctx.container.exec で行う。
# tini を PID 1 にして、kill した子孫のゾンビを回収する。
CMD ["tini", "--", "sleep", "infinity"]
