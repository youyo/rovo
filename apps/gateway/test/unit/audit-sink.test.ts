import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultApp } from "../../src/app";
import { AUDIT_KV_PREFIX, auditFromWorker, readWorkerAudit } from "../../src/audit-sink";
import { clearWorkerAudit } from "./helpers";

const withEnv = (environment: string | undefined) =>
  ({ ...env, ENVIRONMENT: environment }) as unknown as Env;

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function keys(): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list({
      prefix: AUDIT_KV_PREFIX,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

beforeEach(clearWorkerAudit);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("auditFromWorker（DO の外で発行する監査イベントの test 用シンク）", () => {
  it("production（既定・空・未設定）では console.log に出すだけで、KV には何も書かない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.spyOn(env.OAUTH_KV, "put");
    for (const environment of ["production", "", undefined]) {
      await auditFromWorker(withEnv(environment), "auth_failed", { reason: "token_rejected" });
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      audit: true,
      event: "auth_failed",
      reason: "token_rejected",
    });
    expect(put).not.toHaveBeenCalled();
    expect(await keys()).toEqual([]);
    expect(await readWorkerAudit(withEnv("production"))).toEqual([]);
  });

  it("test では記録を KV に残し、readWorkerAudit が発行順に返す", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const e = withEnv("test");
    await auditFromWorker(e, "auth_failed", { reason: "token_rejected", host: "example.com" });
    await auditFromWorker(e, "authz_denied", { reason: "forbidden", userId: 9 });
    const records = await readWorkerAudit(e);
    expect(records.map((r) => r.event)).toEqual(["auth_failed", "authz_denied"]);
    expect(records[1]).toMatchObject({ audit: true, reason: "forbidden", userId: 9 });
  });

  it("記録にも allowlist が効く（禁止したフィールドは KV にも入らない）", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const e = withEnv("test");
    await auditFromWorker(e, "auth_failed", {
      reason: "token_rejected",
      token: "ghs_secret",
      url: "https://x.example/path",
    } as never);
    const raw = await Promise.all((await keys()).map((k) => env.OAUTH_KV.get(k)));
    expect(raw.join("")).not.toContain("ghs_secret");
    expect(raw.join("")).not.toContain("x.example");
  });

  it("未知のイベント名は出力も記録もしない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await auditFromWorker(withEnv("test"), "nope" as never, { reason: "x" });
    expect(log).not.toHaveBeenCalled();
    expect(await keys()).toEqual([]);
  });
});

describe("/__test/audit", () => {
  it("test 以外（production・空・未設定）は 404 で何も返さない", async () => {
    const app = createDefaultApp();
    for (const environment of ["production", "", undefined]) {
      const res = await app.request("/__test/audit", post({}), withEnv(environment));
      expect(res.status).toBe(404);
    }
  });

  it("test では Worker 側の記録を返す", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const e = withEnv("test");
    await auditFromWorker(e, "auth_failed", { reason: "token_rejected" });
    const res = await createDefaultApp().request("/__test/audit", post({}), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { event: string }[] };
    expect(body.records.map((r) => r.event)).toEqual(["auth_failed"]);
  });

  it("task_id が不正なら 400", async () => {
    const res = await createDefaultApp().request(
      "/__test/audit",
      post({ task_id: "../x" }),
      withEnv("test"),
    );
    expect(res.status).toBe(400);
  });
});
