import { describe, expect, it } from "vitest";
import { baseUrl } from "./helpers";

// 実 Worker（wrangler dev + 実 assets = apps/dashboard/dist）に fetch して、/dashboard の配信を通しで確かめる。
// dist は mise の build:dashboard が先に作る。

const TASK_ID = "01JZ0000000000000000000000";

function get(path: string, init: RequestInit = {}) {
  // リダイレクトは辿らない（/dashboard が別の URL に飛ばされないことも確かめる）
  return fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
}

async function assetPathFromIndex(): Promise<string> {
  const html = await (await get("/dashboard/")).text();
  const match = html.match(/src="(\/dashboard\/assets\/[^"]+\.js)"/);
  if (!match?.[1]) throw new Error(`index.html に JS の参照が無い: ${html}`);
  return match[1];
}

describe("ダッシュボードの配信（SPA）", () => {
  for (const path of ["/dashboard", "/dashboard/", `/dashboard/tasks/${TASK_ID}`]) {
    it(`GET ${path} は HTML（SPA の index.html）を返す`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('<div id="root">');
      expect(html).toContain("/dashboard/assets/");
    });
  }

  it("HTML のヘッダ: CSP・nosniff・no-referrer・no-store", async () => {
    const res = await get("/dashboard/");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("HTML が指す JS は /dashboard/assets/ から取れて、immutable で配られる（base と assets のパスが合っている）", async () => {
    const res = await get(await assetPathFromIndex());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body).not.toContain("<!doctype html");
  });

  it("存在しない /dashboard/assets/... は 404（index.html を返さない）", async () => {
    const res = await get("/dashboard/assets/nope-12345.js");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<div id="root">');
  });

  it("/dashboard の外から assets のファイルは取れない（接頭辞なしのパスは OAuthProvider の経路）", async () => {
    const asset = await assetPathFromIndex();
    const res = await get(asset.replace("/dashboard", ""));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toMatch(/javascript/);
  });

  it("未知の /dashboard/api/x は JSON の 404", async () => {
    const res = await get("/dashboard/api/x");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("別サイトからの API 呼び出しは 403", async () => {
    const res = await get("/dashboard/api/x", { headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
  });

  it("タスク ID でない /dashboard/tasks/foo や未知の /dashboard/foo は HTML を返さない", async () => {
    for (const path of ["/dashboard/tasks/foo", "/dashboard/foo"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('<div id="root">');
    }
  });
});

describe("ダッシュボードが OAuthProvider の経路を飲み込まない", () => {
  it("/.well-known/oauth-authorization-server は JSON のメタデータのまま", async () => {
    const res = await get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.authorization_endpoint).toBe(`${baseUrl}/authorize`);
  });

  it("/.well-known/oauth-protected-resource/mcp も JSON のまま", async () => {
    const res = await get("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("未認証の /mcp は 401 と resource_metadata（HTML ではない）", async () => {
    const res = await get("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("GET /mcp も HTML を返さない", async () => {
    const res = await get("/mcp");
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(await res.text()).not.toContain('<div id="root">');
  });

  it("/authorize は SPA の HTML ではなく、今までどおりの応答（client_id が無いので 400）", async () => {
    const res = await get("/authorize");
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('<div id="root">');
  });

  it("/ は defaultHandler のまま", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("rovo gateway");
  });

  it("未知のパスは SPA の HTML にならず 404（assets の自動フォールバックを使っていない）", async () => {
    for (const path of ["/api/x", "/unknown", "/index.html"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('<div id="root">');
    }
  });
});
