import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** OutboundGateway が許可した通信の転送先になる偽サーバー。`x-original-host` で本来のホストを判別する。 */
export interface FakeUpstream {
  url: string;
  /** 偽 GitHub の acme/hello（main）の先頭コミット SHA */
  helloSha: string;
  /** 受け取った（= 許可されて上流まで届いた）リクエスト */
  requests: {
    host: string;
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
  }[];
  stop(): Promise<void>;
}

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

function buildRepo(root: string): string {
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "hello from fake github\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  const bare = join(root, "repos", "acme", "hello.git");
  mkdirSync(join(root, "repos", "acme"), { recursive: true });
  git(root, "clone", "-q", "--bare", work, bare);
  return git(work, "rev-parse", "HEAD").toString().trim();
}

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

function gitBackend(root: string, req: IncomingMessage, res: ServerResponse, body: Buffer) {
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
      REMOTE_USER: "",
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
  const helloSha = buildRepo(root);
  const tar = buildTarball(root);
  const requests: FakeUpstream["requests"] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const host = String(req.headers["x-original-host"] ?? "");
      const path = req.url ?? "/";
      requests.push({ host, method: req.method ?? "", path, headers: { ...req.headers } });
      if (host === "github.com") return gitBackend(root, req, res, body);
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
    requests,
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
