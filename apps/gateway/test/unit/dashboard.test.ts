import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleDashboard, isDashboardPath } from "../../src/dashboard/serve";

const TASK_ID = "01JZ0000000000000000000000";
const INDEX_HTML = "<!doctype html><title>rovo ダッシュボード</title><div id=root></div>";
const BASE = "https://rovo.example.test";
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/** 偽の ASSETS。dist 直下（/ と /assets/...）にあるファイルだけを返し、無いものは 404（not_found_handling なし相当）。 */
function fakeAssets(extra: Record<string, string> = {}) {
  const files: Record<string, { body: string; type: string }> = {
    "/": { body: INDEX_HTML, type: "text/html; charset=utf-8" },
    "/assets/index-abc123.js": { body: "console.log(1)", type: "text/javascript" },
    ...Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [k, { body: v, type: "text/plain" }]),
    ),
  };
  const requested: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requested.push(url.pathname);
      const file = files[url.pathname];
      if (!file) return new Response("Not Found", { status: 404 });
      return new Response(file.body, { headers: { "content-type": file.type, etag: '"x"' } });
    },
  } as unknown as Fetcher;
  return { fetcher, requested };
}

function call(path: string, init: RequestInit = {}, assets = fakeAssets()) {
  const request = new Request(`${BASE}${path}`, init);
  return handleDashboard(request, { ...env, ASSETS: assets.fetcher } as Env).then((response) => ({
    response,
    requested: assets.requested,
  }));
}

describe("isDashboardPath", () => {
  it("/dashboard と /dashboard/ 配下だけが対象", () => {
    expect(isDashboardPath("/dashboard")).toBe(true);
    expect(isDashboardPath("/dashboard/")).toBe(true);
    expect(isDashboardPath("/dashboard/tasks/x")).toBe(true);
    expect(isDashboardPath("/dashboard/api/overview")).toBe(true);
    // 接頭辞が同じだけの別のパスは対象外（OAuthProvider に渡る）
    expect(isDashboardPath("/dashboardx")).toBe(false);
    expect(isDashboardPath("/mcp")).toBe(false);
    expect(isDashboardPath("/authorize")).toBe(false);
    expect(isDashboardPath("/.well-known/oauth-authorization-server")).toBe(false);
    expect(isDashboardPath("/")).toBe(false);
  });
});

describe("SPA の HTML（index.html）", () => {
  for (const path of ["/dashboard", "/dashboard/", `/dashboard/tasks/${TASK_ID}`]) {
    it(`${path} は index.html を返す`, async () => {
      const { response, requested } = await call(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(INDEX_HTML);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      // dist 直下の index.html は "/" で取る（/index.html は / へのリダイレクトになりうる）
      expect(requested).toEqual(["/"]);
    });
  }

  it("HTML のヘッダ: CSP・nosniff・no-referrer・no-store", async () => {
    const { response } = await call("/dashboard/");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // assets 側の ETag を引き継がない（no-store の HTML に条件付きリクエストを持ち込まない）
    expect(response.headers.get("etag")).toBeNull();
  });

  it("HEAD でも同じヘッダで、本文は無い", async () => {
    const { response } = await call("/dashboard/", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await response.text()).toBe("");
  });

  it("タスク ID（ULID）の形でない /dashboard/tasks/... は HTML を返さず 404", async () => {
    for (const path of [
      "/dashboard/tasks/not-a-ulid",
      "/dashboard/tasks/",
      "/dashboard/tasks",
      `/dashboard/tasks/${TASK_ID}/extra`,
      `/dashboard/tasks/${TASK_ID.toLowerCase()}`,
    ]) {
      const { response, requested } = await call(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type") ?? "", path).not.toContain("text/html");
      expect(await response.text(), path).not.toContain("<div id=root>");
      expect(requested, path).toEqual([]);
    }
  });

  it("/dashboard 配下の未知のパスは HTML を返さず 404（SPA のフォールバックは 2 ルートだけ）", async () => {
    for (const path of ["/dashboard/unknown", "/dashboard/index.html", "/dashboard/login"]) {
      const { response } = await call(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain("<div id=root>");
    }
  });

  it("GET / HEAD 以外は 405（Allow 付き）", async () => {
    const { response } = await call("/dashboard/", { method: "POST", body: "x" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("index.html が取れないとき（未ビルドなど）は 503 で、HTML の中身も内部の詳細も出さない", async () => {
    const failing = {
      async fetch() {
        return new Response("Not Found", { status: 404 });
      },
    } as unknown as Fetcher;
    const request = new Request(`${BASE}/dashboard/`);
    const response = await handleDashboard(request, { ...env, ASSETS: failing } as Env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("/dashboard/assets/*", () => {
  it("存在するファイルは、/dashboard を剥がしたパスで ASSETS から返し、immutable にする", async () => {
    const { response, requested } = await call("/dashboard/assets/index-abc123.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log(1)");
    expect(requested).toEqual(["/assets/index-abc123.js"]);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // JS に HTML 用の CSP は付けない
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("存在しないファイルは 404。index.html を返さない（壊れたスクリプトが HTML で返るのを避ける）", async () => {
    const { response } = await call("/dashboard/assets/nope.js");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<div id=root>");
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("assets の外へ出るパスや不正な文字は ASSETS に渡さず 404", async () => {
    for (const path of [
      "/dashboard/assets/",
      "/dashboard/assets",
      "/dashboard/assets/%2e%2e/index.html",
      "/dashboard/assets/a%2fb.js",
      "/dashboard/assets/a%5cb.js",
      "/dashboard/assets//x.js",
    ]) {
      const { response, requested } = await call(path);
      expect(response.status, path).toBe(404);
      expect(requested, path).toEqual([]);
    }
  });
});

describe("/dashboard/api/*", () => {
  it("未知の API は JSON の 404（HTML ではない）。nosniff・no-store・CORS なし", async () => {
    const { response, requested } = await call("/dashboard/api/x", { headers: SAME_ORIGIN });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(requested).toEqual([]);
  });

  it("/dashboard/api だけでも、メソッドが何でも JSON の 404", async () => {
    for (const [path, method] of [
      ["/dashboard/api", "GET"],
      ["/dashboard/api/", "GET"],
      ["/dashboard/api/x", "POST"],
      ["/dashboard/api/x", "OPTIONS"],
    ] as const) {
      const { response } = await call(path, { method, headers: SAME_ORIGIN });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("Sec-Fetch-Site が cross-site / same-site の API 呼び出しは 403", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const { response } = await call("/dashboard/api/x", { headers: { "sec-fetch-site": site } });
      expect(response.status, site).toBe(403);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    for (const site of ["same-origin", "none"]) {
      const { response } = await call("/dashboard/api/x", { headers: { "sec-fetch-site": site } });
      expect(response.status, site).toBe(404);
    }
  });

  // M1 で M4 に残した決定: ナビゲーション以外の API でヘッダが無い呼び出しは拒否する（ルートの有無を漏らさないよう 404 より前）
  it("Sec-Fetch-Site が無い API 呼び出しは 403（存在しないパスでも 404 にならない）", async () => {
    for (const path of ["/dashboard/api/x", "/dashboard/api/me", "/dashboard/api"]) {
      const { response } = await call(path);
      expect(response.status, path).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("Worker 全体の振り分け（実 Worker。ASSETS には触れない経路）", () => {
  it("/dashboard/api/x は Worker が JSON 404 で返す", async () => {
    const res = await SELF.fetch(`${env.PUBLIC_BASE_URL}/dashboard/api/x`, {
      headers: SAME_ORIGIN,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("/dashboard 以外は今までどおり OAuthProvider（/ は defaultHandler、/mcp は 401）", async () => {
    const root = await SELF.fetch(`${env.PUBLIC_BASE_URL}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("rovo gateway");

    const mcp = await SELF.fetch(`${env.PUBLIC_BASE_URL}/mcp`, { method: "POST", body: "{}" });
    expect(mcp.status).toBe(401);

    const meta = await SELF.fetch(`${env.PUBLIC_BASE_URL}/.well-known/oauth-authorization-server`);
    expect(meta.status).toBe(200);
  });

  it("/dashboardx のような接頭辞だけ同じパスは SPA の HTML を返さない", async () => {
    const res = await SELF.fetch(`${env.PUBLIC_BASE_URL}/dashboardx`);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});
