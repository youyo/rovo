export const CA_CERT = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
export const WORKSPACE = "/workspace";
/**
 * イメージに焼いた Go の版（apps/agent/Dockerfile の ARG GO_VERSION と同じ値。
 * test/node/sandbox-env-dockerfile.node.test.ts が一致を確かめる）。mise.toml の go の版の診断（repo-diag.ts）に使う。
 */
export const GO_VERSION = "1.26.5";
/** HTTPS 傍受の CA を各ツールに信用させる。exec はイメージの ENV を引き継がないので毎回渡す。
 * Dockerfile の最終ステージの ENV は、ここにも同じ値で書く（test/node/sandbox-env-dockerfile.node.test.ts が一致を確かめる）。 */
export const BASE_ENV: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: CA_CERT,
  GIT_SSL_CAINFO: CA_CERT,
  REQUESTS_CA_BUNDLE: CA_CERT,
  SSL_CERT_FILE: CA_CERT,
  // 作業ツリー（/workspace）に npm のキャッシュなどが書かれて git add -A に混ざらないよう、HOME は外に置く
  HOME: "/root",
  // pnpm / yarn の本体はイメージのビルド時にここへ入れてある（apps/agent/Dockerfile）
  COREPACK_HOME: "/opt/corepack",
  // corepack が pnpm / yarn の本体を取るときに「ダウンロードしてよいか」の確認で止まらないようにする
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  // 以下は Dockerfile の ENV と同じ値（本番の exec は ENV を引き継がない）。PATH は Dockerfile の最終的な値（venv → go → 既定）
  PATH: "/opt/venv/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  GOTOOLCHAIN: "auto",
  GOPROXY: "https://proxy.golang.org",
  GOSUMDB: "sum.golang.org",
  GOPATH: "/opt/go-cache/path",
  GOMODCACHE: "/opt/go-cache/mod",
  GOCACHE: "/opt/go-cache/build",
  UV_PYTHON_INSTALL_DIR: "/opt/uv/python",
  VIRTUAL_ENV: "/opt/venv",
  UV_PYTHON_DOWNLOADS: "never",
  UV_PYTHON: "/opt/venv/bin/python",
  MISE_DATA_DIR: "/opt/mise/data",
  MISE_CACHE_DIR: "/opt/mise/cache",
  MISE_STATE_DIR: "/opt/mise/state",
  MISE_TRUSTED_CONFIG_PATHS: "/workspace",
  MISE_YES: "1",
  MISE_DISABLE_UPDATE_WARNING: "1",
  // 焼いていない node / python は実行時に取る。許可先を最小にする mise の設定（理由は Dockerfile の mise の節）
  MISE_USE_VERSIONS_HOST: "false",
  MISE_NODE_COMPILE: "false",
  MISE_PYTHON_COMPILE: "false",
  MISE_PYTHON_GITHUB_ATTESTATIONS: "false",
  // github: / aqua: backend も python と同じ方針で attestation の検証を切る（Sigstore の TUF が取れず、tflint は workflow の身元も合わない）。aqua の checksum の確認は残る
  MISE_GITHUB_ATTESTATIONS: "false",
  MISE_AQUA_GITHUB_ATTESTATIONS: "false",
  // terraform の checkpoint（checkpoint-api.hashicorp.com は許可していない）を止める
  CHECKPOINT_DISABLE: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: WORKSPACE,
};
