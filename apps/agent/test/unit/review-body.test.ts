import { describe, expect, it } from "vitest";
import { buildReviewBody, MAX_REVIEW_BODY_CHARS, neutralizeMentions } from "../../src/review/body";

const sha = "0123456789abcdef0123456789abcdef01234567";
const finding = (over: Record<string, unknown> = {}) => ({
  path: "src/a.ts",
  line: 3,
  reason: "off by one",
  change: "use <=",
  severity: "high" as const,
  ...over,
});
const args = (over: Partial<Parameters<typeof buildReviewBody>[0]> = {}) => ({
  model: "anthropic/claude-sonnet-5-5",
  headSha: sha,
  verdict: { summary: "Mostly fine.", mustFix: [finding()], suggestions: [finding({ line: 9 })] },
  commands: [
    { argv: ["pnpm", "test"], exitCode: 0, timedOut: false, output: "ok" },
    { argv: ["pnpm", "lint"], exitCode: 2, timedOut: false, output: "line1\nline2\nlint failed" },
    { argv: ["pnpm", "e2e"], exitCode: -1, timedOut: true, output: "" },
  ],
  commandsUnavailable: false,
  diffPartial: false,
  timedOut: false,
  ...over,
});

describe("neutralizeMentions", () => {
  it("@名前 をバッククォートで囲む（通知を飛ばさない）。メールアドレスは触らない", () => {
    expect(neutralizeMentions("cc @octocat and @acme/core")).toBe("cc `@octocat` and `@acme/core`");
    expect(neutralizeMentions("mail a@b.com")).toBe("mail a@b.com");
    expect(neutralizeMentions("already `@x`")).toBe("already `@x`");
  });
});

describe("buildReviewBody", () => {
  it("見出しにモデル名と head の 7 桁、直すべき点・提案・全体のテストの節", () => {
    const { body } = buildReviewBody(args());
    expect(body).toContain("rovo のレビュー（anthropic/claude-sonnet-5-5、0123456）");
    expect(body).toContain("直すべき点");
    expect(body).toContain("提案");
    expect(body).toMatch(/直さなくてよい/);
    expect(body).toContain("全体のテスト");
    expect(body).toContain("src/a.ts");
    expect(body).toContain("off by one");
    // 成功・失敗・タイムアウト
    expect(body).toMatch(/pnpm test.*成功/);
    expect(body).toMatch(/pnpm lint.*失敗/);
    expect(body).toMatch(/pnpm e2e.*タイムアウト/);
    // 失敗の出力は末尾だけ
    expect(body).toContain("lint failed");
  });

  it("モデルの自由文の @名前 は通知にならない形にする", () => {
    const { body } = buildReviewBody(
      args({ verdict: { summary: "ping @octocat", mustFix: [], suggestions: [] } }),
    );
    expect(body).toContain("`@octocat`");
    expect(body).not.toMatch(/(^|[^`])@octocat/);
  });

  it("モデルの自由文の画像・リンク・HTML は効かない形にする（外部への読み出しを作らない）", () => {
    const { body } = buildReviewBody(
      args({
        verdict: {
          summary: "![x](https://evil.example/p?d=1) <img src=https://evil.example/q>",
          mustFix: [],
          suggestions: [],
        },
      }),
    );
    expect(body).not.toContain("![x](");
    expect(body).not.toContain("<img");
  });

  it("本文の秘密を伏せ字にし、伏せ字にしたことを返す", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const r = buildReviewBody(
      args({ verdict: { summary: `leak ${secret}`, mustFix: [], suggestions: [] } }),
    );
    expect(r.body).not.toContain(secret);
    expect(r.redacted).toBe(true);
    expect(buildReviewBody(args()).redacted).toBe(false);
  });

  it("差分の一部が未確認・テストを実行できなかった・時間切れを書く", () => {
    const { body } = buildReviewBody(
      args({ diffPartial: true, commandsUnavailable: true, timedOut: true, commands: [] }),
    );
    expect(body).toMatch(/差分の一部は未確認/);
    expect(body).toMatch(/テストを実行できなかった/);
    expect(body).toMatch(/時間/);
  });

  it("コマンドが無いときは、差分だけのレビューと書く", () => {
    const { body } = buildReviewBody(args({ commands: [] }));
    expect(body).toMatch(/差分だけ/);
  });

  it("コマンドの出力にバッククォートが続いても、コードブロックを閉じられない", () => {
    const { body } = buildReviewBody(
      args({
        commands: [
          { argv: ["x"], exitCode: 1, timedOut: false, output: "```\n# injected heading\n````" },
        ],
      }),
    );
    // 出力を囲むフェンスは、出力のどのバッククォートの並びより長い
    expect(body).toMatch(/`{5,}/);
  });

  it("GitHub の本文の上限に収める", () => {
    const long = "y".repeat(1900);
    const many = Array.from({ length: 10 }, (_, i) =>
      finding({ line: i + 1, reason: long, change: long }),
    );
    const { body } = buildReviewBody(
      args({
        verdict: {
          summary: long,
          mustFix: many,
          suggestions: Array(20).fill(finding({ reason: long, change: long })),
        },
      }),
    );
    expect(body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY_CHARS);
  });
});
