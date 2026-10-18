import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 偽 GitHub が既定で要求する Installation Token（Basic の x-access-token）。E2E が SandboxDO に預ける値と合わせる。 */
export const TEST_GIT_TOKEN = "ghs_e2e_installation_token";

/** OutboundGateway が許可した通信の転送先になる偽サーバー。`x-original-host` で本来のホストを判別する。 */
export interface FakeUpstream {
  url: string;
  /** 偽 GitHub の acme/hello（main）の先頭コミット SHA */
  helloSha: string;
  /** 偽 GitHub の acme/calc（main）の先頭コミット SHA。add() にバグがある純 JS の小さなリポジトリ（npm test が失敗する） */
  calcSha: string;
  /** 受け取った（= 許可されて上流まで届いた）リクエスト */
  requests: {
    host: string;
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
  }[];
  /**
   * github.com 宛の通信に要求するトークン（`Authorization: Basic base64("x-access-token:<token>")`）。
   * 一致しなければ 401。undefined なら認証を要求しない。既定は TEST_GIT_TOKEN。
   */
  expectedToken: string | undefined;
  /**
   * 作業ブランチ `agent/task-<taskId>` を bare リポジトリに用意する（TaskDO が Phase 3 で作るものの代用）。
   * initialCommit を true にすると、main の先頭の上に空コミット（TaskDO の初期コミット相当）を作って指す。
   * false（既定）なら main の先頭をそのまま指す（initialSha = base）。
   */
  createTaskBranch(
    repo: FakeRepoName,
    taskId: string,
    opts?: { initialCommit?: boolean },
  ): { branch: string; initialSha: string };
  /** bare リポジトリの ref の先頭（無ければ undefined）。 */
  refSha(repo: FakeRepoName, ref: string): string | undefined;
  /** bare リポジトリの ref を直接動かす（「完了の後に head が動いた」などの再現用）。 */
  setRef(repo: FakeRepoName, ref: string, sha: string): void;
  /** bare リポジトリに commit が存在するか。 */
  hasObject(repo: FakeRepoName, sha: string): boolean;
  stop(): Promise<void>;
}

export type FakeRepoName = "hello" | "calc";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

function buildRepo(root: string, name: string, files: Record<string, string>): string {
  const work = join(root, "work", name);
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  for (const [file, content] of Object.entries(files)) writeFileSync(join(work, file), content);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  const bare = join(root, "repos", "acme", `${name}.git`);
  mkdirSync(join(root, "repos", "acme"), { recursive: true });
  git(root, "clone", "-q", "--bare", work, bare);
  // push（git-receive-pack）を有効にする。認証は偽サーバーの入口で確かめる
  git(bare, "config", "http.receivepack", "true");
  // push-options を広告する（クライアントが送ってきたとき、gateway が止めることを確かめるため）
  git(bare, "config", "receive.advertisePushOptions", "true");
  return git(work, "rev-parse", "HEAD").toString().trim();
}

/** E2E 用の小さな純 JS リポジトリ。add() が a - b になっていて、`npm test`（node --test）が失敗する。 */
const CALC_FILES: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "calc", version: "1.0.0", scripts: { test: "node --test" } }, null, 2)}\n`,
  "calc.js": "exports.add = (a, b) => a - b;\n",
  "calc.test.js": [
    'const test = require("node:test");',
    'const assert = require("node:assert");',
    'const { add } = require("./calc");',
    'test("add", () => assert.strictEqual(add(2, 3), 5));',
    "",
  ].join("\n"),
};

function buildTarball(root: string): { file: Buffer; integrity: string; shasum: string } {
  const dir = join(root, "pkg", "package");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "tiny-pkg", version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(join(dir, "index.js"), "module.exports = 'tiny';\n");
  const tgz = join(root, "tiny-pkg-1.0.0.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", join(root, "pkg"), "package"]);
  const file = readFileSync(tgz);
  return {
    file,
    integrity: `sha512-${createHash("sha512").update(file).digest("base64")}`,
    shasum: createHash("sha1").update(file).digest("hex"),
  };
}

const bareOf = (root: string, repo: FakeRepoName) => join(root, "repos", "acme", `${repo}.git`);

function gitBackend(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  user: string,
) {
  const url = new URL(req.url ?? "/", "http://x");
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH ?? "",
      GIT_PROJECT_ROOT: join(root, "repos"),
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method ?? "GET",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
      HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      REMOTE_USER: user,
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  child.stdin.end(body);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (d) => chunks.push(d));
  child.on("close", () => {
    const out = Buffer.concat(chunks);
    const sep = out.indexOf("\r\n\r\n");
    const head = out.subarray(0, sep).toString().split("\r\n");
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(out.subarray(sep + 4));
  });
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const root = mkdtempSync(join(tmpdir(), "rovo-upstream-"));
  const helloSha = buildRepo(root, "hello", { "README.md": "hello from fake github\n" });
  const calcSha = buildRepo(root, "calc", CALC_FILES);
  const tar = buildTarball(root);
  const requests: FakeUpstream["requests"] = [];
  const state: { expectedToken: string | undefined } = { expectedToken: TEST_GIT_TOKEN };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const host = String(req.headers["x-original-host"] ?? "");
      const path = req.url ?? "/";
      requests.push({ host, method: req.method ?? "", path, headers: { ...req.headers } });
      if (host === "github.com") {
        const want =
          state.expectedToken === undefined
            ? undefined
            : `Basic ${Buffer.from(`x-access-token:${state.expectedToken}`).toString("base64")}`;
        if (want !== undefined && req.headers.authorization !== want) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
          return void res.end("fake github: bad credentials");
        }
        return gitBackend(root, req, res, body, want === undefined ? "" : "x-access-token");
      }
      if (host === "registry.npmjs.org") {
        if (path === "/tiny-pkg") {
          res.setHeader("content-type", "application/json");
          return void res.end(
            JSON.stringify({
              name: "tiny-pkg",
              "dist-tags": { latest: "1.0.0" },
              versions: {
                "1.0.0": {
                  name: "tiny-pkg",
                  version: "1.0.0",
                  dist: {
                    tarball: "https://registry.npmjs.org/tiny-pkg/-/tiny-pkg-1.0.0.tgz",
                    integrity: tar.integrity,
                    shasum: tar.shasum,
                  },
                },
              },
            }),
          );
        }
        if (path === "/tiny-pkg/-/tiny-pkg-1.0.0.tgz") {
          res.setHeader("content-type", "application/octet-stream");
          return void res.end(tar.file);
        }
        if (path === "/redirect-me") {
          res.writeHead(302, { location: "https://example.com/secret" });
          return void res.end();
        }
      }
      res.writeHead(404);
      res.end("fake upstream: not found");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    helloSha,
    calcSha,
    requests,
    get expectedToken() {
      return state.expectedToken;
    },
    set expectedToken(v: string | undefined) {
      state.expectedToken = v;
    },
    createTaskBranch(repo, taskId, opts = {}) {
      const bare = bareOf(root, repo);
      const base = repo === "hello" ? helloSha : calcSha;
      const branch = `agent/task-${taskId}`;
      let initialSha = base;
      if (opts.initialCommit) {
        const tree = git(bare, "rev-parse", `${base}^{tree}`).toString().trim();
        initialSha = git(bare, "commit-tree", tree, "-p", base, "-m", `rovo: start task ${taskId}`)
          .toString()
          .trim();
      }
      git(bare, "update-ref", `refs/heads/${branch}`, initialSha);
      return { branch, initialSha };
    },
    refSha(repo, ref) {
      try {
        return git(bareOf(root, repo), "rev-parse", "--verify", "-q", ref).toString().trim();
      } catch {
        return undefined;
      }
    },
    setRef(repo, ref, sha) {
      git(bareOf(root, repo), "update-ref", ref, sha);
    },
    hasObject(repo, sha) {
      try {
        git(bareOf(root, repo), "cat-file", "-e", `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    },
    stop: () =>
      new Promise((resolve) => {
        server.close(() => {
          rmSync(root, { recursive: true, force: true });
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
