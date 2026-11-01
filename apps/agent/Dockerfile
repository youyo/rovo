# Coding Sandbox のイメージ。sandbox-shim（Files が使う）は SDK と同じタグの公式イメージから取る。
FROM docker.io/cloudflare/sandbox:1.0.1 AS shim

# uv は公式イメージの固定タグから COPY する（版を変えるときはこのタグだけ直す）。
FROM ghcr.io/astral-sh/uv:0.8.22 AS uv

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
# npm は audit の POST が外向き制御で 403 になるので既定で無効にする
RUN npm config set audit false --global && npm config set fund false --global
# pnpm / yarn は corepack の shim を有効にしておく（ワーカーが /tmp/bin に自分で入れたり PATH を足したりしなくてよい）。
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
# Go / Python（対応する言語は Node・TypeScript・Go・Python の 4 つだけ。mise は入れない）。
# gcc（build-essential）は入れない: cgo の Go パッケージ、Python の sdist、node のネイティブ拡張はビルドできない。
# apt は外向き通信で使えない（deb.debian.org は許可していない）ので、ビルド時に公式の配布物から焼く。
# Go: go.dev の公式 tarball を sha256 で確かめて /usr/local/go に置く。版を変えるときは ARG（と sha256）だけ直す。
# GOTOOLCHAIN=auto のまま、別の版の go.mod の toolchain は proxy.golang.org から取る（外向き通信で許可済み）。
# exec は root（HOME=/root）で動くが、どのユーザーでも書けるよう GOPATH / GOMODCACHE / GOCACHE は /opt/go-cache に置く。
# exec は PATH しか引き継がないことがあるので、ENV に加えて go env -w（$HOME/.config/go/env）にも同じ値を書く。
ARG GO_VERSION=1.26.5
ARG GO_SHA256_AMD64=5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053
ARG GO_SHA256_ARM64=fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) GO_SHA256="${GO_SHA256_AMD64}" ;; \
      arm64) GO_SHA256="${GO_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH:-amd64}.tar.gz" \
 && echo "${GO_SHA256}  /tmp/go.tgz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm /tmp/go.tgz \
 && mkdir -p /opt/go-cache/path /opt/go-cache/mod /opt/go-cache/build \
 && chmod -R 0777 /opt/go-cache
ENV PATH=/usr/local/go/bin:$PATH \
    GOTOOLCHAIN=auto \
    GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    GOPATH=/opt/go-cache/path \
    GOMODCACHE=/opt/go-cache/mod \
    GOCACHE=/opt/go-cache/build
RUN go env -w GOTOOLCHAIN=auto GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
      GOMODCACHE=/opt/go-cache/mod GOCACHE=/opt/go-cache/build \
 && go version | grep -F "go${GO_VERSION} "
# Python: apt の python3（3.11）は入れず、uv で 3.13 を入れ、その venv（/opt/venv）を PATH の先頭に置く。
# venv なので pip install が PEP 668（externally-managed）に邪魔されず、python3 / python / pip が 3.13 を指す。
# 実行時に GitHub から Python を取りに行かない（取れずに止まるのではなく、すぐ失敗させる）ため UV_PYTHON_DOWNLOADS=never。
# 別の版の Python は取れない（3.13 だけ）。
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv python install 3.13 \
 && uv venv --python 3.13 --seed /opt/venv \
 && chmod -R a+rX /opt/uv \
 && chmod -R a+rwX /opt/venv
ENV VIRTUAL_ENV=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/opt/venv/bin/python \
    PATH=/opt/venv/bin:$PATH
RUN python3 --version | grep -F "Python 3.13." \
 && python --version | grep -F "Python 3.13." \
 && pip --version | grep -F "(python 3.13)" \
 && uv --version
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
# コンテナを生かしておくだけ。実処理は ctx.container.exec で行う。
# tini を PID 1 にして、kill した子孫のゾンビを回収する。
CMD ["tini", "--", "sleep", "infinity"]
