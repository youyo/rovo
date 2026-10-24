import { beforeAll, describe, expect, it } from "vitest";
import {
  createAppJwt,
  GitHubApiError,
  GitHubAppClient,
  parsePrivateKey,
} from "../../../src/github";
import { generateAppKeyPair } from "../../support/app-keys";
import { json, routerFetch } from "./helpers";

let pair: Awaited<ReturnType<typeof generateAppKeyPair>>;
beforeAll(async () => {
  pair = await generateAppKeyPair();
});

const b64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function verifyJwt(jwt: string, publicPem: string) {
  const [h, p, s] = jwt.split(".") as [string, string, string];
  const der = Uint8Array.from(
    atob(publicPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64u(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  return {
    ok,
    header: JSON.parse(new TextDecoder().decode(b64u(h))),
    payload: JSON.parse(new TextDecoder().decode(b64u(p))),
  };
}

describe("parsePrivateKey", () => {
  it("PKCS#8 の PEM を読める", async () => {
    await expect(parsePrivateKey(pair.privatePem)).resolves.toBeDefined();
  });
  it("改行が \\n の文字列になっていても読める（.dev.vars の一行表記）", async () => {
    await expect(
      parsePrivateKey(pair.privatePem.trim().replace(/\n/g, "\\n")),
    ).resolves.toBeDefined();
  });
  it("ヘッダーなしの base64 だけでも読める", async () => {
    const body = pair.privatePem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    await expect(parsePrivateKey(body)).resolves.toBeDefined();
  });
  it("PKCS#1（BEGIN RSA PRIVATE KEY）は変換手順つきのエラーにする", async () => {
    await expect(
      parsePrivateKey("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----"),
    ).rejects.toThrow(/PKCS#8/);
  });
  it("壊れた鍵は拒否する", async () => {
    await expect(parsePrivateKey("not a key")).rejects.toThrow();
  });
});

describe("createAppJwt", () => {
  it("RS256 で署名し、iat は 60 秒前、exp は 9 分後、iss は App ID", async () => {
    const key = await parsePrivateKey(pair.privatePem);
    const nowMs = 1_800_000_000_000;
    const jwt = await createAppJwt({ appId: "12345", key, nowMs });
    const v = await verifyJwt(jwt, pair.publicPem);
    expect(v.ok).toBe(true);
    expect(v.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(v.payload).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "12345" });
  });
});

describe("GitHubAppClient", () => {
  async function client(routes: Parameters<typeof routerFetch>[0], nowMs = 1_800_000_000_000) {
    const r = routerFetch(routes);
    const c = new GitHubAppClient({
      appId: "12345",
      privateKey: pair.privatePem,
      apiBase: "https://api.github.test",
      fetch: r.fetch,
      now: () => nowMs,
    });
    return { c, ...r };
  }

  it("Installation Token を発行する（repository_ids と permissions を絞る。JWT で認証）", async () => {
    const { c, calls } = await client({
      "POST /app/installations/77/access_tokens": () =>
        json({ token: "ghs_secret", expires_at: "2027-01-15T09:00:00Z" }, { status: 201 }),
    });
    const t = await c.createInstallationToken(77, 4242);
    expect(t).toEqual({ token: "ghs_secret", expiresAt: Date.parse("2027-01-15T09:00:00Z") });
    const req = calls[0] as Request;
    expect(await req.clone().json()).toEqual({
      repository_ids: [4242],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
    const jwt = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    expect((await verifyJwt(jwt, pair.publicPem)).ok).toBe(true);
  });

  it("bot の作者: GET /app の slug と GET /users/<slug>[bot] の id から <id>+<slug>[bot] の noreply を作る（JWT で /app を引く）", async () => {
    const { c, calls } = await client({
      "GET /app": () => json({ id: 12345, slug: "acme-rovo", name: "Acme Rovo" }),
      "GET /users/acme-rovo%5Bbot%5D": () => json({ login: "acme-rovo[bot]", id: 98765 }),
    });
    await expect(c.getBotIdentity()).resolves.toEqual({
      name: "acme-rovo[bot]",
      email: "98765+acme-rovo[bot]@users.noreply.github.com",
    });
    const jwt = (calls[0] as Request).headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    expect((await verifyJwt(jwt, pair.publicPem)).ok).toBe(true);
  });

  it("bot の作者: Installation Token を渡すと GET /users/<slug>[bot] をそのトークンで認証して引く（共有 IP の認証なし上限を避ける）", async () => {
    const { c, calls } = await client({
      "GET /app": () => json({ slug: "acme-rovo" }),
      "GET /users/acme-rovo%5Bbot%5D": () => json({ id: 98765 }),
    });
    await c.getBotIdentity("ghs_tok");
    expect((calls[1] as Request).headers.get("authorization")).toBe("Bearer ghs_tok");
  });

  it("bot の作者: slug や id が引けない・不正なら例外（呼び出し側が代わりの作者にする）", async () => {
    const noUser = await client({
      "GET /app": () => json({ slug: "acme-rovo" }),
      "GET /users/acme-rovo%5Bbot%5D": () => json({ message: "Not Found" }, { status: 404 }),
    });
    await expect(noUser.c.getBotIdentity()).rejects.toBeInstanceOf(GitHubApiError);
    const badSlug = await client({
      "GET /app": () => json({ slug: "a/../b" }),
    });
    await expect(badSlug.c.getBotIdentity()).rejects.toThrow();
    const badId = await client({
      "GET /app": () => json({ slug: "acme-rovo" }),
      "GET /users/acme-rovo%5Bbot%5D": () => json({ id: "x" }),
    });
    await expect(badId.c.getBotIdentity()).rejects.toThrow();
  });

  it("失効は DELETE /installation/token（そのトークンで認証）。204 と、既に無効な 401 は成功扱い", async () => {
    const { c, calls } = await client({
      "DELETE /installation/token": [
        () => new Response(null, { status: 204 }),
        () => json({ message: "Bad credentials" }, { status: 401 }),
      ],
    });
    await c.revokeInstallationToken("ghs_x");
    await c.revokeInstallationToken("ghs_x");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer ghs_x");
  });

  it("失効が 5xx なら GitHubApiError（再試行できる）", async () => {
    const { c } = await client({
      "DELETE /installation/token": () => json({ message: "x" }, { status: 502 }),
    });
    await expect(c.revokeInstallationToken("ghs_x")).rejects.toMatchObject({ status: 502 });
  });

  it("エラーには status・Retry-After・本文のメッセージが付き、トークンは含まれない", async () => {
    const { c } = await client({
      "POST /app/installations/77/access_tokens": () =>
        json(
          { message: "rate limited ghs_leak?" },
          { status: 429, headers: { "retry-after": "7" } },
        ),
    });
    const err = await c.createInstallationToken(77, 1).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 7000, rateLimited: true });
    expect(String(err.message)).not.toMatch(/Bearer|eyJ/);
  });

  it("ネットワーク障害は status 0 の GitHubApiError", async () => {
    const c = new GitHubAppClient({
      appId: "1",
      privateKey: pair.privatePem,
      fetch: (async () => {
        throw new TypeError("boom");
      }) as typeof fetch,
    });
    await expect(c.createInstallationToken(1, 1)).rejects.toMatchObject({ status: 0 });
  });

  it("想定外の応答（token なし）は拒否する", async () => {
    const { c } = await client({
      "POST /app/installations/77/access_tokens": () => json({}, { status: 201 }),
    });
    await expect(c.createInstallationToken(77, 1)).rejects.toBeInstanceOf(GitHubApiError);
  });
});
