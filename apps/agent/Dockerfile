# Coding Sandbox のイメージ。sandbox-shim（Files が使う）は SDK と同じタグの公式イメージから取る。
FROM docker.io/cloudflare/sandbox:1.0.1 AS shim

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates tini python3 \
 && rm -rf /var/lib/apt/lists/*
# npm は audit の POST が外向き制御で 403 になるので既定で無効にする
RUN npm config set audit false --global && npm config set fund false --global
# pnpm / yarn は corepack の shim を有効にしておく（子が /tmp/bin に自分で入れたり PATH を足したりしなくてよい）。
# 本体はビルド時に corepack のキャッシュ（COREPACK_HOME）へ入れておき、実行時に取りに行かせない。
# 理由: pnpm 11 以降の wrapper は native バイナリ（約 44MB）を初回の実行時に Node の fetch（undici）で取る。
# 外向き通信の中継越しにこれを受けると、Node 24 の undici が assert(!this.paused) で落ちる（本番の不具合）。
# npm（undici を使わない）と git は影響を受けない。ビルド時の取得も、undici ではなく npm の経路（pm-prepare.mjs）。
# 版は package.json の packageManager に従うので、焼いた版と違うときは SandboxDO が clone のあとに
# pm-prepare.mjs を呼んで、npm の経路で用意する。焼く版を変えるときは、この ARG だけ直す（E2E も ARG を読む）。
ARG PNPM_VERSION=12.14.0
ARG YARN_VERSION=1.22.22
ENV COREPACK_HOME=/opt/corepack
# ダウンロードの確認で止まらないようにする
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY container/pm-prepare.mjs /usr/local/lib/rovo/pm-prepare.mjs
RUN corepack enable \
 && node /usr/local/lib/rovo/pm-prepare.mjs "pnpm@${PNPM_VERSION}" \
 && node /usr/local/lib/rovo/pm-prepare.mjs "yarn@${YARN_VERSION}" \
 && mkdir /tmp/pmcheck && cd /tmp/pmcheck \
 && echo "{\"packageManager\":\"pnpm@${PNPM_VERSION}\"}" > package.json \
 && COREPACK_ENABLE_NETWORK=0 corepack pnpm --version | grep -Fx "${PNPM_VERSION}" \
 && echo "{\"packageManager\":\"yarn@${YARN_VERSION}\"}" > package.json \
 && COREPACK_ENABLE_NETWORK=0 corepack yarn --version | grep -Fx "${YARN_VERSION}" \
 && cd / && rm -rf /tmp/pmcheck
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
# コンテナを生かしておくだけ。実処理は ctx.container.exec で行う。
# tini を PID 1 にして、kill した子孫のゾンビを回収する。
CMD ["tini", "--", "sleep", "infinity"]
