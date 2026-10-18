import { describe, expect, it } from "vitest";
import { isTaskId, ulid } from "../../src/tasks/ulid";
import {
  computeFingerprint,
  exceedsInputLimit,
  isValidIdempotencyKey,
  parseCursor,
  parseTimeoutSeconds,
  taskInputSchema,
} from "../../src/tasks/validation";

const base = {
  repository: "Owner/Repo",
  base_ref: "main",
  base_sha: "0123456",
  title: "t",
  instructions: "i",
  acceptance_criteria: ["a"],
  constraints: ["c"],
};

describe("parseCursor", () => {
  it("省略は 0（先頭から）", () => {
    expect(parseCursor(undefined)).toEqual({ ok: true, value: 0 });
  });
  it("10進の非負整数を受け付ける", () => {
    expect(parseCursor("0")).toEqual({ ok: true, value: 0 });
    expect(parseCursor("42")).toEqual({ ok: true, value: 42 });
    expect(parseCursor(String(Number.MAX_SAFE_INTEGER))).toEqual({
      ok: true,
      value: Number.MAX_SAFE_INTEGER,
    });
  });
  it.each([
    "-1",
    "1.5",
    "1e3",
    "0x10",
    "",
    " 1",
    "1 ",
    "abc",
    "+1",
    String(Number.MAX_SAFE_INTEGER + 1),
    "99999999999999999999999",
  ])("不正な cursor %j は拒否する", (raw) => {
    expect(parseCursor(raw)).toEqual({ ok: false });
  });
});

describe("parseTimeoutSeconds", () => {
  it("省略は既定の 30 秒", () => {
    expect(parseTimeoutSeconds(undefined)).toEqual({ ok: true, value: 30 });
  });
  it("0 以上の整数を受け付け、60 秒にクランプする", () => {
    expect(parseTimeoutSeconds(0)).toEqual({ ok: true, value: 0 });
    expect(parseTimeoutSeconds(5)).toEqual({ ok: true, value: 5 });
    expect(parseTimeoutSeconds(60)).toEqual({ ok: true, value: 60 });
    expect(parseTimeoutSeconds(61)).toEqual({ ok: true, value: 60 });
    expect(parseTimeoutSeconds(100000)).toEqual({ ok: true, value: 60 });
  });
  it.each([-1, 1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number])(
    "不正な timeout %j は拒否する",
    (v) => {
      expect(parseTimeoutSeconds(v)).toEqual({ ok: false });
    },
  );
});

describe("isValidIdempotencyKey", () => {
  it("1〜128 文字の [A-Za-z0-9_-] を受け付ける", () => {
    expect(isValidIdempotencyKey("a")).toBe(true);
    expect(isValidIdempotencyKey("Abc_123-xyz")).toBe(true);
    expect(isValidIdempotencyKey("a".repeat(128))).toBe(true);
  });
  it.each(["", "a".repeat(129), "has space", "日本語", "a:b", "a/b", "a.b", "a\n"])(
    "不正なキー %j は拒否する",
    (k) => {
      expect(isValidIdempotencyKey(k)).toBe(false);
    },
  );
  it("文字列以外は拒否する", () => {
    expect(isValidIdempotencyKey(1)).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
  });
});

describe("taskInputSchema", () => {
  it("正常な入力を受け付け、配列の省略は空配列になる", () => {
    const r = taskInputSchema.safeParse({
      ...base,
      acceptance_criteria: undefined,
      constraints: undefined,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.acceptance_criteria).toEqual([]);
      expect(r.data.constraints).toEqual([]);
    }
  });
  it.each([
    ["repository が owner/name でない", { repository: "just-name" }],
    ["repository に余分なスラッシュ", { repository: "a/b/c" }],
    ["repository の owner が 40 文字", { repository: `${"a".repeat(40)}/repo` }],
    ["repository の name が 101 文字", { repository: `owner/${"a".repeat(101)}` }],
    ["base_sha が 6 桁", { base_sha: "012345" }],
    ["base_sha が 41 桁", { base_sha: "a".repeat(41) }],
    ["base_sha が 16 進でない", { base_sha: "ghijklm" }],
    ["title が空", { title: "" }],
    ["instructions が空", { instructions: "" }],
    ["base_ref が空", { base_ref: "" }],
  ])("%s は拒否する", (_name, patch) => {
    expect(taskInputSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
  it("repository は owner 39 文字・name 100 文字まで受け付ける", () => {
    const repository = `${"a".repeat(39)}/${"b".repeat(100)}`;
    expect(taskInputSchema.safeParse({ ...base, repository }).success).toBe(true);
  });
  it("入力全体のサイズ上限（MAX_INPUT_BYTES）を超えると exceedsInputLimit が true", () => {
    const big = {
      ...base,
      instructions: "x".repeat(100_000),
      acceptance_criteria: Array(50).fill("y".repeat(2_000)),
      constraints: Array(50).fill("z".repeat(2_000)),
    };
    const parsed = taskInputSchema.parse(big);
    expect(exceedsInputLimit(parsed)).toBe(true);
    expect(exceedsInputLimit(taskInputSchema.parse(base))).toBe(false);
  });
  it("base_sha は 7 桁と 40 桁の境界を受け付ける", () => {
    expect(taskInputSchema.safeParse({ ...base, base_sha: "a".repeat(7) }).success).toBe(true);
    expect(taskInputSchema.safeParse({ ...base, base_sha: "A".repeat(40) }).success).toBe(true);
  });
});

describe("computeFingerprint", () => {
  const parse = (v: object) => taskInputSchema.parse(v);

  it("同じ入力は同じ 64 桁の hex になる", async () => {
    const a = await computeFingerprint(parse(base));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeFingerprint(parse({ ...base }))).toBe(a);
  });
  it("プロパティの順序に依存しない", async () => {
    const reordered = {
      constraints: base.constraints,
      title: base.title,
      repository: base.repository,
      instructions: base.instructions,
      base_sha: base.base_sha,
      acceptance_criteria: base.acceptance_criteria,
      base_ref: base.base_ref,
    };
    expect(await computeFingerprint(parse(reordered))).toBe(await computeFingerprint(parse(base)));
  });
  it("repository と base_sha の大文字小文字は正規化する", async () => {
    const a = await computeFingerprint(parse(base));
    const b = await computeFingerprint(
      parse({ ...base, repository: "owner/repo", base_sha: "0123456".toUpperCase() }),
    );
    expect(b).toBe(a);
  });
  it("配列の省略と空配列は同じ", async () => {
    const a = await computeFingerprint(
      parse({ ...base, acceptance_criteria: [], constraints: [] }),
    );
    const b = await computeFingerprint(
      parse({ ...base, acceptance_criteria: undefined, constraints: undefined }),
    );
    expect(a).toBe(b);
  });
  it.each([
    ["repository", { repository: "owner/other" }],
    ["base_ref", { base_ref: "develop" }],
    ["base_sha", { base_sha: "0123457" }],
    ["title", { title: "t2" }],
    ["instructions", { instructions: "i2" }],
    ["acceptance_criteria", { acceptance_criteria: ["a", "b"] }],
    ["constraints", { constraints: ["x"] }],
  ])("%s が違えば別の値になる", async (_n, patch) => {
    expect(await computeFingerprint(parse({ ...base, ...patch }))).not.toBe(
      await computeFingerprint(parse(base)),
    );
  });
  it("配列の要素の順序は区別する", async () => {
    const a = await computeFingerprint(parse({ ...base, constraints: ["x", "y"] }));
    const b = await computeFingerprint(parse({ ...base, constraints: ["y", "x"] }));
    expect(a).not.toBe(b);
  });
  it("項目の境界が曖昧にならない（title/instructions の連結衝突）", async () => {
    const a = await computeFingerprint(parse({ ...base, title: "ab", instructions: "c" }));
    const b = await computeFingerprint(parse({ ...base, title: "a", instructions: "bc" }));
    expect(a).not.toBe(b);
  });
});

describe("ulid", () => {
  it("26 文字の Crockford base32 で、時刻順に並ぶ", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(isTaskId(a)).toBe(true);
    expect(a < b).toBe(true);
  });
  it("isTaskId は形式が違うものを拒否する", () => {
    expect(isTaskId("task_123")).toBe(false);
    expect(isTaskId("")).toBe(false);
    expect(isTaskId("0".repeat(25))).toBe(false);
    expect(isTaskId(`${"0".repeat(25)}U`)).toBe(false);
  });
});
