import { describe, expect, it } from "vitest";
import { isTaskId, ulid } from "../../src/tasks/ulid";
import {
  answerInputSchema,
  computeFingerprint,
  exceedsInputLimit,
  isValidIdempotencyKey,
  parseCursor,
  parseTimeoutSeconds,
  steerInputSchema,
  taskInputSchema,
} from "../../src/tasks/validation";

const base = {
  repository: "Owner/Repo",
  base_ref: "main",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
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
  it("0 以上の整数を受け付け、50 秒にクランプする", () => {
    expect(parseTimeoutSeconds(0)).toEqual({ ok: true, value: 0 });
    expect(parseTimeoutSeconds(5)).toEqual({ ok: true, value: 5 });
    expect(parseTimeoutSeconds(50)).toEqual({ ok: true, value: 50 });
    expect(parseTimeoutSeconds(51)).toEqual({ ok: true, value: 50 });
    expect(parseTimeoutSeconds(60)).toEqual({ ok: true, value: 50 });
    expect(parseTimeoutSeconds(100000)).toEqual({ ok: true, value: 50 });
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
    ["base_sha が 7 桁（短縮形）", { base_sha: "a".repeat(7) }],
    ["base_sha が 39 桁", { base_sha: "a".repeat(39) }],
    ["base_sha が 40 桁の 16 進でない", { base_sha: `${"a".repeat(39)}g` }],
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
  it("base_sha は 40 桁の 16 進だけを受け付ける（大文字も可）", () => {
    expect(taskInputSchema.safeParse({ ...base, base_sha: "a".repeat(40) }).success).toBe(true);
    expect(taskInputSchema.safeParse({ ...base, base_sha: "A".repeat(40) }).success).toBe(true);
  });
  it.each([7, 39])("base_sha が %i 桁なら、40 桁の SHA を求めるメッセージで拒否する", (n) => {
    const r = taskInputSchema.safeParse({ ...base, base_sha: "a".repeat(n) });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues.find((i) => i.path[0] === "base_sha");
    expect(issue?.message).toContain("40-digit commit SHA");
    expect(issue?.message).toContain("abbreviated");
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
      parse({ ...base, repository: "owner/repo", base_sha: base.base_sha.toUpperCase() }),
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
    ["base_sha", { base_sha: "0123456789abcdef0123456789abcdef01234568" }],
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

describe("verification_commands の検証", () => {
  const ok = { argv: ["npm", "test"] };
  const parseVc = (vc: unknown) =>
    taskInputSchema.safeParse({ ...base, verification_commands: vc });

  it("省略できる（空配列が既定）", () => {
    const r = taskInputSchema.safeParse(base);
    expect(r.success && r.data.verification_commands).toEqual([]);
  });
  it("argv / cwd / timeout_seconds を受け付ける", () => {
    const r = parseVc([{ argv: ["pnpm", "test"], cwd: "packages/app", timeout_seconds: 600 }, ok]);
    expect(r.success).toBe(true);
  });
  it.each([
    ["argv が空配列", [{ argv: [] }]],
    ["argv の要素が空文字", [{ argv: ["npm", ""] }]],
    ["argv が文字列", [{ argv: "npm test" }]],
    ["argv の要素が多すぎる", [{ argv: Array(65).fill("a") }]],
    ["argv の要素が長すぎる", [{ argv: ["a".repeat(1_001)] }]],
    ["件数が多すぎる", Array(11).fill(ok)],
    ["cwd が絶対パス", [{ argv: ["a"], cwd: "/etc" }]],
    ["cwd に ..", [{ argv: ["a"], cwd: "../x" }]],
    ["cwd の途中に ..", [{ argv: ["a"], cwd: "a/../../x" }]],
    ["cwd に NUL", [{ argv: ["a"], cwd: "a\0b" }]],
    ["cwd が空", [{ argv: ["a"], cwd: "" }]],
    ["timeout_seconds が 0", [{ argv: ["a"], timeout_seconds: 0 }]],
    ["timeout_seconds が小数", [{ argv: ["a"], timeout_seconds: 1.5 }]],
    ["timeout_seconds が上限超過", [{ argv: ["a"], timeout_seconds: 1_801 }]],
    ["未知の項目", [{ argv: ["a"], shell: true }]],
  ])("%s は拒否する", (_n, vc) => {
    expect(parseVc(vc).success).toBe(false);
  });
  it("fingerprint: 検証コマンドが違えば別の値、省略と空配列は同じ", async () => {
    const none = await computeFingerprint(taskInputSchema.parse(base));
    const empty = await computeFingerprint(
      taskInputSchema.parse({ ...base, verification_commands: [] }),
    );
    const a = await computeFingerprint(
      taskInputSchema.parse({ ...base, verification_commands: [ok] }),
    );
    const b = await computeFingerprint(
      taskInputSchema.parse({ ...base, verification_commands: [{ argv: ["npm", "run", "lint"] }] }),
    );
    const c = await computeFingerprint(
      taskInputSchema.parse({ ...base, verification_commands: [{ ...ok, cwd: "x" }] }),
    );
    expect(empty).toBe(none);
    expect(new Set([none, a, b, c]).size).toBe(4);
  });
});

describe("task_answer / task_steer の入力", () => {
  it("answer は 1〜20,000 文字。question_id は必須", () => {
    const ok = { task_id: "t", question_id: "q", answer: "a" };
    expect(answerInputSchema.safeParse(ok).success).toBe(true);
    expect(answerInputSchema.safeParse({ ...ok, answer: "a".repeat(20_000) }).success).toBe(true);
    expect(answerInputSchema.safeParse({ ...ok, answer: "" }).success).toBe(false);
    expect(answerInputSchema.safeParse({ ...ok, answer: "a".repeat(20_001) }).success).toBe(false);
    expect(answerInputSchema.safeParse({ ...ok, question_id: "" }).success).toBe(false);
    expect(answerInputSchema.safeParse({ task_id: "t", answer: "a" }).success).toBe(false);
  });

  it("steer の message は 1〜20,000 文字。idempotency_key は任意で形式を検証する", () => {
    const ok = { task_id: "t", message: "m" };
    expect(steerInputSchema.safeParse(ok).success).toBe(true);
    expect(steerInputSchema.safeParse({ ...ok, message: "m".repeat(20_000) }).success).toBe(true);
    expect(steerInputSchema.safeParse({ ...ok, message: "" }).success).toBe(false);
    expect(steerInputSchema.safeParse({ ...ok, message: "m".repeat(20_001) }).success).toBe(false);
    expect(steerInputSchema.safeParse({ ...ok, idempotency_key: "key-1" }).success).toBe(true);
    expect(steerInputSchema.safeParse({ ...ok, idempotency_key: "bad key!" }).success).toBe(false);
    expect(steerInputSchema.safeParse({ ...ok, idempotency_key: "" }).success).toBe(false);
  });
});

describe("merge_policy（D9）", () => {
  it("省略は human_review。human_review / agent_merge だけを受け付け、他は拒否する", () => {
    expect(taskInputSchema.parse(base).merge_policy).toBe("human_review");
    expect(taskInputSchema.parse({ ...base, merge_policy: "agent_merge" }).merge_policy).toBe(
      "agent_merge",
    );
    for (const bad of ["auto", "AGENT_MERGE", "", 1, null]) {
      expect(taskInputSchema.safeParse({ ...base, merge_policy: bad }).success).toBe(false);
    }
  });

  it("fingerprint: 既定（human_review）は従来の値のまま。agent_merge は別のタスク", async () => {
    const implicit = await computeFingerprint(taskInputSchema.parse(base));
    const explicit = await computeFingerprint(
      taskInputSchema.parse({ ...base, merge_policy: "human_review" }),
    );
    const merge = await computeFingerprint(
      taskInputSchema.parse({ ...base, merge_policy: "agent_merge" }),
    );
    expect(explicit).toBe(implicit);
    expect(merge).not.toBe(implicit);
    // 検証コマンドがあっても、policy の違いは別のタスクにする
    const cmd = { verification_commands: [{ argv: ["npm", "test"] }] };
    const withCmd = await computeFingerprint(taskInputSchema.parse({ ...base, ...cmd }));
    const withCmdMerge = await computeFingerprint(
      taskInputSchema.parse({ ...base, ...cmd, merge_policy: "agent_merge" }),
    );
    expect(withCmdMerge).not.toBe(withCmd);
    // 従来の fingerprint（v1 形式）が変わらない: 保存済みのタスクの再試行（同じ idempotency_key）が conflict にならない
    const v1 = JSON.stringify(["v1", "owner/repo", "main", base.base_sha, "t", "i", ["a"], ["c"]]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v1));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(implicit).toBe(hex);
  });
});

describe("model（D10）", () => {
  it("省略できる。指定は文字列だけ（許可リストとの照合は service が env の AGENT_MODELS で行う）", () => {
    expect(taskInputSchema.parse(base).model).toBeUndefined();
    expect(taskInputSchema.parse({ ...base, model: "anthropic/claude-haiku-5-5" }).model).toBe(
      "anthropic/claude-haiku-5-5",
    );
    for (const bad of ["", 1, null, "x".repeat(101)]) {
      expect(taskInputSchema.safeParse({ ...base, model: bad }).success).toBe(false);
    }
  });

  it("fingerprint: 未指定は従来の値のまま（v1 / v2 / v3）。指定すれば別のタスク（v4）", async () => {
    const implicit = await computeFingerprint(taskInputSchema.parse(base));
    const haiku = await computeFingerprint(
      taskInputSchema.parse({ ...base, model: "anthropic/claude-haiku-5-5" }),
    );
    const sol = await computeFingerprint(
      taskInputSchema.parse({ ...base, model: "openai/gpt-6-sol" }),
    );
    expect(haiku).not.toBe(implicit);
    expect(sol).not.toBe(haiku);
    // 既存の値が変わらない: v1 / v3 を直接計算して一致を確かめる
    const sha = async (v: unknown) => {
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v)));
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    expect(implicit).toBe(
      await sha(["v1", "owner/repo", "main", base.base_sha, "t", "i", ["a"], ["c"]]),
    );
    const merge = await computeFingerprint(
      taskInputSchema.parse({ ...base, merge_policy: "agent_merge" }),
    );
    expect(merge).toBe(
      await sha([
        "v3",
        "owner/repo",
        "main",
        base.base_sha,
        "t",
        "i",
        ["a"],
        ["c"],
        [],
        "agent_merge",
      ]),
    );
    // model と merge_policy の組み合わせも別のタスク
    const both = await computeFingerprint(
      taskInputSchema.parse({ ...base, merge_policy: "agent_merge", model: "openai/gpt-6-sol" }),
    );
    expect(both).not.toBe(merge);
    expect(both).not.toBe(sol);
  });
});
