// 偽の GitHub（テスト用）。POST /app-manifests/{code}/conversions だけを答える。本物の github.com / api.github.com には触れない。
//   import { startFakeGithub } から使う、または CLI: node fake-github.mjs <port を書くファイル> [ok|fail|incomplete]

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// 秘密の検出（scan:secrets）に引っかからないよう、鍵のヘッダは実行時に組み立てる
export const FAKE_PEM = [
  "-----BEGIN RSA ",
  "PRIVATE KEY-----\nFAKEPEMBODY0123456789\n-----END RSA ",
  "PRIVATE KEY-----\n",
].join("");
export const SENTINELS = {
  clientSecret: "CLIENTSECRET-SENTINEL-0001",
  webhookSecret: "WEBHOOKSECRET-SENTINEL-0002",
  pemBody: "FAKEPEMBODY0123456789",
};
export const FAKE_APP = { id: 424242, slug: "acme-rovo-xyz", client_id: "Iv1.fakeclientid0001" };

export function startFakeGithub({ mode = "ok" } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url ?? "");
      if (req.method !== "POST" || !m) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      if (mode === "fail") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Validation Failed", errors: ["code expired"] }));
        return;
      }
      const app = {
        ...FAKE_APP,
        client_secret: SENTINELS.clientSecret,
        webhook_secret: SENTINELS.webhookSecret,
        pem: FAKE_PEM,
      };
      if (mode === "incomplete") delete app.pem;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(app));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [portFile, mode] = process.argv.slice(2);
  const s = await startFakeGithub({ mode: mode || "ok" });
  writeFileSync(portFile, String(s.port));
}
