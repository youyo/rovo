# Coding Sandbox のイメージ。sandbox-shim（Files が使う）は SDK と同じタグの公式イメージから取る。
FROM docker.io/cloudflare/sandbox:1.0.1 AS shim

# uv は公式イメージの固定タグから COPY する（版を変えるときはこのタグだけ直す）。
FROM ghcr.io/astral-sh/uv:0.8.22 AS uv

# node は正確な版に固定する（mise link で登録する焼いた版がビルドのたびにずれないように）。版を変えるときはこのタグだけ直す。
FROM node:24.22.2-bookworm-slim
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
# 注意: 本番（Cloudflare Containers）の container.exec は、このイメージの ENV を引き継がない（PATH も既定値になる）。
# ENV を足す・変えるときは src/sandbox-env.ts の BASE_ENV にも同じ値を書く（test/node/sandbox-env-dockerfile.node.test.ts が一致を確かめる）。
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
# Go / Python（対応する言語は Node・TypeScript・Go・Python の 4 つだけ。mise は `mise run` / `mise exec` 用に入れる。下の mise の節）。
# gcc（build-essential）は入れない: cgo の Go パッケージ、Python の sdist、node のネイティブ拡張はビルドできない。
# apt は外向き通信で使えない（deb.debian.org は許可していない）ので、ビルド時に公式の配布物から焼く。
# Go: go.dev の公式 tarball を sha256 で確かめて /usr/local/go に置く。版を変えるときは ARG（と sha256）だけ直す。
# GOTOOLCHAIN=auto のまま、別の版の go.mod の toolchain は proxy.golang.org から取る（外向き通信で許可済み）。
# exec は root（HOME=/root）で動くが、どのユーザーでも書けるよう GOPATH / GOMODCACHE / GOCACHE は /opt/go-cache に置く。
# exec は ENV を引き継がないことがあるので（本番）、ENV に加えて go env -w（$HOME/.config/go/env）にも同じ値を書く。
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
# bash ツールは port.exec(["bash", "-lc", command]) で流す。ログインシェルは /etc/profile を読み、root の PATH を
# "/usr/local/sbin:...:/bin" で上書きする（上の ENV PATH も BASE_ENV の PATH もここで消える。本番で go・python3 が見つからなかった原因）。
# /etc/profile は最後に /etc/profile.d/*.sh を読むので、そこで venv と go を PATH の先頭へ足し直す（順番は ENV PATH / BASE_ENV と同じ）。
# /etc/profile が上書きするのは PATH だけ（ほかの ENV は消えない）。test/node/sandbox-env-dockerfile.node.test.ts が BASE_ENV の PATH との一致を確かめる。
RUN printf '%s\n' \
      'case ":$PATH:" in' \
      '  *:/opt/venv/bin:*) ;;' \
      '  *) export PATH="/opt/venv/bin:/usr/local/go/bin:$PATH" ;;' \
      'esac' > /etc/profile.d/rovo-path.sh \
 && chmod 0644 /etc/profile.d/rovo-path.sh \
 && grep -q 'profile.d' /etc/profile
RUN python3 --version | grep -F "Python 3.13." \
 && python --version | grep -F "Python 3.13." \
 && pip --version | grep -F "(python 3.13)" \
 && uv --version
# mise: リポジトリの mise.toml の [tools] / [tasks] を最優先で使えるようにする（mise run / mise exec 用）。
# 公式 release の tarball をビルド時に取り、sha256 で確かめて /usr/local/bin/mise に置く。版を変えるときは ARG（と sha256）だけ直す。
# 焼いた node / go / python は `mise link` で登録する。mise.toml の [tools] が焼いた版（前方一致を含む。node = "24"、go = "1.26"、python = "3.13" など）を
# 指すとき、ダウンロードせずに解決する。焼いていない node / python の版は、初回の mise run / mise exec / mise install で取る。
# 外向き通信はその配布元だけを、パスで絞って GET / HEAD で許可している（src/outbound-policy.ts の REGISTRY_PATH_PREFIXES。
# 根拠は docs/specs/phase2.md）: nodejs.org の /dist/、mise-versions.jdx.dev の /data/python-precompiled-、
# github.com の astral-sh/python-build-standalone の /releases/download/ と、その 302 の転送先（リポジトリ ID のパスだけ）。
# 許可先を最小にするため、mise の設定で次のようにする（ENV と /etc/mise/config.toml の両方に書く）:
#   use_versions_host=false: node の版の一覧を mise-versions.jdx.dev ではなく nodejs.org/dist/index.json から取る（インストールの記録の送信も止まる）。
#   node.compile=false / python.compile=false: 配布物が無い版をソースからビルドしに行かない（gcc も無い。python-build の git clone もしない）。
#   python.github_attestations=false: GitHub の attestation の検証（api.github.com・mise-versions・Sigstore の TUF への通信）をしない。
#     node は SHASUMS256.txt とその署名（mise に組み込みの鍵）で確かめる。python は HTTPS で固定のリポジトリの releases から取ることだけが根拠になる。
# go の焼いていない版は mise では取れない（mise の go は dl.google.com と github.com/golang/go の ls-remote を使い、許可していない）。
# mise install / mise run は失敗するが、mise exec は版の一覧の取得失敗を警告にするだけで、PATH 上の焼いた go で動く（mise の挙動。設定では変えられない）。
# go.mod の toolchain は GOTOOLCHAIN=auto で proxy.golang.org から取れる。shims / activate は使わず、PATH はこれまでどおり焼いたツールを直接指す。
# データ・キャッシュは /opt/mise（どのユーザーでも書ける）。exec は ENV を引き継がないことがあるので（本番）、ENV に加えて
# /etc/mise/config.toml（システムの設定）にも同じ値を書き、/root の既定の置き場所は /opt/mise への symlink にする。
ARG MISE_VERSION=2026.10.25
ARG MISE_SHA256_AMD64=199966edaad1b208eb4c72955f1722dafb8fa799f575db720dea05aaa8216546
ARG MISE_SHA256_ARM64=a7d1e2add53441ff76e7e971e7a3fb15c117741836ce51c026f5fb7eebe7dbcf
ENV MISE_DATA_DIR=/opt/mise/data \
    MISE_CACHE_DIR=/opt/mise/cache \
    MISE_STATE_DIR=/opt/mise/state \
    MISE_TRUSTED_CONFIG_PATHS=/workspace \
    MISE_YES=1 \
    MISE_DISABLE_UPDATE_WARNING=1 \
    MISE_USE_VERSIONS_HOST=false \
    MISE_NODE_COMPILE=false \
    MISE_PYTHON_COMPILE=false \
    MISE_PYTHON_GITHUB_ATTESTATIONS=false
RUN case "${TARGETARCH:-amd64}" in \
      amd64) MISE_SHA256="${MISE_SHA256_AMD64}"; MISE_ARCH=x64 ;; \
      arm64) MISE_SHA256="${MISE_SHA256_ARM64}"; MISE_ARCH=arm64 ;; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/mise.tgz "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${MISE_ARCH}.tar.gz" \
 && echo "${MISE_SHA256}  /tmp/mise.tgz" | sha256sum -c - \
 && tar -C /tmp -xzf /tmp/mise.tgz \
 && install -m 0755 /tmp/mise/bin/mise /usr/local/bin/mise \
 && rm -rf /tmp/mise /tmp/mise.tgz \
 && mkdir -p /opt/mise/data /opt/mise/cache /opt/mise/state /etc/mise /root/.local/share /root/.cache /root/.local/state \
 && printf '%s\n' '[settings]' 'yes = true' 'disable_update_warning = true' \
      'trusted_config_paths = ["/workspace"]' 'use_versions_host = false' \
      'node.compile = false' 'python.compile = false' 'python.github_attestations = false' > /etc/mise/config.toml \
 && ln -s /opt/mise/data /root/.local/share/mise \
 && ln -s /opt/mise/cache /root/.cache/mise \
 && ln -s /opt/mise/state /root/.local/state/mise \
 && NODE_FULL="$(node -p process.versions.node)" \
 && PY_FULL="$(/opt/venv/bin/python -c 'import platform; print(platform.python_version())')" \
 && mise link "node@${NODE_FULL}" /usr/local \
 && mise link "go@${GO_VERSION}" /usr/local/go \
 && mise link "python@${PY_FULL}" /opt/venv \
 && mkdir /tmp/misecheck && cd /tmp/misecheck \
 && printf '%s\n' '[tools]' 'node = "24"' "go = \"${GO_VERSION}\"" 'python = "3.13"' '' '[tasks.hello]' \
      'run = "go version && python --version && node --version"' > mise.toml \
 && mise --version | grep -F "${MISE_VERSION}" \
 && MISE_TRUSTED_CONFIG_PATHS=/tmp/misecheck mise run hello \
 && MISE_TRUSTED_CONFIG_PATHS=/tmp/misecheck mise exec -- go version | grep -F "go${GO_VERSION} " \
 && sed -i "s/^go = .*/go = \"${GO_VERSION%.*}\"/" mise.toml \
 && MISE_TRUSTED_CONFIG_PATHS=/tmp/misecheck mise exec -- go version | grep -F "go${GO_VERSION} " \
 && [ "$(MISE_TRUSTED_CONFIG_PATHS=/tmp/misecheck mise exec -- python -c 'import os, sys; print(os.path.realpath(sys.prefix))')" = /opt/venv ] \
 && MISE_TRUSTED_CONFIG_PATHS=/tmp/misecheck mise exec -- python -m pip --version \
 && cd / && rm -rf /tmp/misecheck \
 && chmod -R a+rwX /opt/mise
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
# コンテナを生かしておくだけ。実処理は ctx.container.exec で行う。
# tini を PID 1 にして、kill した子孫のゾンビを回収する。
CMD ["tini", "--", "sleep", "infinity"]
