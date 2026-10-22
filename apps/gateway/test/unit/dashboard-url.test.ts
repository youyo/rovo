import { describe, expect, it } from "vitest";
import { dashboardUrl } from "../../src/dashboard/url";
import { ulid } from "../../src/tasks/ulid";

// docs/specs/dashboard.md D16・M10。形は ${PUBLIC_BASE_URL}/dashboard/tasks/<task_id>（末尾の / は除く）。
// PUBLIC_BASE_URL が空・不正、task_id が ULID でないときは、URL を作らない（undefined。呼び出し側はキーを付けない）。

const TASK_ID = "01JZ0000000000000000000000";

describe("dashboardUrl", () => {
  it("<PUBLIC_BASE_URL>/dashboard/tasks/<task_id> の形になる", () => {
    expect(dashboardUrl({ PUBLIC_BASE_URL: "https://rovo.example.com" }, TASK_ID)).toBe(
      `https://rovo.example.com/dashboard/tasks/${TASK_ID}`,
    );
    // wrangler dev の loopback の http・ポート付き
    expect(dashboardUrl({ PUBLIC_BASE_URL: "http://localhost:8787" }, TASK_ID)).toBe(
      `http://localhost:8787/dashboard/tasks/${TASK_ID}`,
    );
    expect(dashboardUrl({ PUBLIC_BASE_URL: "http://127.0.0.1:43210" }, TASK_ID)).toBe(
      `http://127.0.0.1:43210/dashboard/tasks/${TASK_ID}`,
    );
    expect(dashboardUrl({ PUBLIC_BASE_URL: "http://[::1]:8787" }, TASK_ID)).toBe(
      `http://[::1]:8787/dashboard/tasks/${TASK_ID}`,
    );
  });

  it("末尾の / は除く（1 つでも複数でも。OAuthProvider の issuer と同じ扱い）", () => {
    for (const base of ["https://rovo.example.com/", "https://rovo.example.com///"]) {
      expect(dashboardUrl({ PUBLIC_BASE_URL: base }, TASK_ID), base).toBe(
        `https://rovo.example.com/dashboard/tasks/${TASK_ID}`,
      );
    }
  });

  it("ulid() で作った task_id でも作れる（Crockford base32 の 26 文字）", () => {
    for (let i = 0; i < 50; i++) {
      const id = ulid();
      expect(dashboardUrl({ PUBLIC_BASE_URL: "https://rovo.example.com" }, id)).toBe(
        `https://rovo.example.com/dashboard/tasks/${id}`,
      );
    }
  });

  it("PUBLIC_BASE_URL が空・未設定・文字列でないときは undefined（キーを付けない）", () => {
    expect(dashboardUrl({ PUBLIC_BASE_URL: "" }, TASK_ID)).toBeUndefined();
    expect(dashboardUrl({ PUBLIC_BASE_URL: "   " }, TASK_ID)).toBeUndefined();
    expect(dashboardUrl({ PUBLIC_BASE_URL: "/" }, TASK_ID)).toBeUndefined();
    expect(dashboardUrl({}, TASK_ID)).toBeUndefined();
    expect(dashboardUrl({ PUBLIC_BASE_URL: undefined }, TASK_ID)).toBeUndefined();
    expect(dashboardUrl({ PUBLIC_BASE_URL: 8787 as unknown as string }, TASK_ID)).toBeUndefined();
    expect(dashboardUrl({ PUBLIC_BASE_URL: null as unknown as string }, TASK_ID)).toBeUndefined();
  });

  it("PUBLIC_BASE_URL が http / https の絶対 URL でないときは undefined", () => {
    const bad = [
      "rovo.example.com",
      "//rovo.example.com",
      "ftp://rovo.example.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "https:",
      "https://",
      "https:///",
      "https:rovo.example.com",
      "http//rovo.example.com",
      "https://rovo example.com",
      "https://rovo.example.com:notaport",
      "https://rovo.example.com:99999",
      "https://\\rovo.example.com",
      "https://rovo.example.com\\@evil.example",
    ];
    for (const base of bad) {
      expect(dashboardUrl({ PUBLIC_BASE_URL: base }, TASK_ID), base).toBeUndefined();
    }
  });

  it("PUBLIC_BASE_URL にパス・クエリ・フラグメント・認証情報・空白や改行を含むときは undefined", () => {
    const bad = [
      "https://rovo.example.com/gateway",
      "https://rovo.example.com/gateway/",
      "https://rovo.example.com/?a=1",
      "https://rovo.example.com?a=1",
      "https://rovo.example.com/?",
      "https://rovo.example.com#x",
      "https://rovo.example.com/#",
      "https://user@rovo.example.com",
      "https://user:pass@rovo.example.com",
      " https://rovo.example.com",
      "https://rovo.example.com ",
      "https://rovo.example.com\n",
      "https://rovo.example.com\t/",
      "https://rov\no.example.com",
    ];
    for (const base of bad) {
      expect(
        dashboardUrl({ PUBLIC_BASE_URL: base }, TASK_ID),
        JSON.stringify(base),
      ).toBeUndefined();
    }
  });

  it("task_id が ULID（26 文字の Crockford base32）でないときは undefined", () => {
    const env = { PUBLIC_BASE_URL: "https://rovo.example.com" };
    const bad = [
      "",
      "bad",
      "01JZ000000000000000000000", // 25 文字
      "01JZ00000000000000000000000", // 27 文字
      "01jz0000000000000000000000", // 小文字
      "01JZ000000000000000000000I", // I は Crockford base32 に無い
      "01JZ000000000000000000000L",
      "01JZ000000000000000000000O",
      "01JZ000000000000000000000U",
      `${TASK_ID}/`,
      `${TASK_ID}?x=1`,
      `${TASK_ID}#x`,
      `../${TASK_ID.slice(3)}`,
      `${TASK_ID.slice(0, 20)}%2e%2e%2e`,
      ` ${TASK_ID}`,
      `${TASK_ID}\n`,
      "consult-01JZ0000000000000000000000",
    ];
    for (const id of bad) {
      expect(dashboardUrl(env, id), JSON.stringify(id)).toBeUndefined();
    }
    expect(dashboardUrl(env, undefined as unknown as string)).toBeUndefined();
    expect(dashboardUrl(env, 123 as unknown as string)).toBeUndefined();
  });
});
