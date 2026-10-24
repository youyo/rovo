import { describe, expect, it } from "vitest";
import { MAX_MUST_FIX, MAX_SUGGESTIONS, parseReviewResponse } from "../../src/review/output";

const paths = ["src/a.ts", "src/b.ts"];
const item = (over: Record<string, unknown> = {}) => ({
  path: "src/a.ts",
  line: 3,
  reason: "off by one",
  change: "use <=",
  severity: "high",
  ...over,
});
const json = (v: unknown) => JSON.stringify(v);

describe("parseReviewResponse", () => {
  it("must_fix と suggestions を分けて受け取る", () => {
    const r = parseReviewResponse(
      json({
        summary: "ok",
        must_fix: [item()],
        suggestions: [item({ path: "src/b.ts", line: null })],
      }),
      paths,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.mustFix).toEqual([
      { path: "src/a.ts", line: 3, reason: "off by one", change: "use <=", severity: "high" },
    ]);
    expect(r.verdict.suggestions[0]?.path).toBe("src/b.ts");
    expect(r.verdict.suggestions[0]?.line).toBeNull();
    expect(r.verdict.summary).toBe("ok");
  });

  it("JSON でなければ not_json", () => {
    expect(parseReviewResponse("Looks good to me!", paths)).toEqual({
      ok: false,
      code: "not_json",
    });
    // 閉じていない JSON（出力の上限で切れた）も失敗
    expect(parseReviewResponse('{"must_fix": [', paths)).toEqual({ ok: false, code: "not_json" });
  });

  it("コードブロック 1 つで囲んだだけの JSON は受け取る", () => {
    const r = parseReviewResponse(
      `\`\`\`json\n${json({ must_fix: [], suggestions: [] })}\n\`\`\``,
      paths,
    );
    expect(r.ok).toBe(true);
  });

  it("形が違えば schema_mismatch（must_fix に path・line・reason が要る）", () => {
    for (const bad of [
      [],
      { must_fix: [] },
      { must_fix: "x", suggestions: [] },
      { must_fix: [item({ line: undefined })], suggestions: [] },
      { must_fix: [item({ line: 0 })], suggestions: [] },
      { must_fix: [item({ reason: "" })], suggestions: [] },
      { must_fix: [item({ path: 5 })], suggestions: [] },
      { must_fix: [item({ severity: "urgent" })], suggestions: [] },
    ]) {
      expect(parseReviewResponse(json(bad), paths)).toEqual({ ok: false, code: "schema_mismatch" });
    }
  });

  it("差分に無いパスの指摘は捨てて、数を数える", () => {
    const r = parseReviewResponse(
      json({
        must_fix: [item(), item({ path: "src/elsewhere.ts" })],
        suggestions: [item({ path: "/etc/passwd" })],
      }),
      paths,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.mustFix).toHaveLength(1);
    expect(r.verdict.suggestions).toHaveLength(0);
    expect(r.droppedUnknownPath).toBe(2);
  });

  it("件数の上限を超えたら重要度の順に切る", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      item({ line: i + 1, severity: i < 5 ? "low" : "high" }),
    );
    const sugg = Array.from({ length: 25 }, (_, i) => item({ line: i + 1, severity: "medium" }));
    const r = parseReviewResponse(json({ must_fix: many, suggestions: sugg }), paths);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.mustFix).toHaveLength(MAX_MUST_FIX);
    expect(r.verdict.mustFix.every((m) => m.severity === "high")).toBe(true);
    expect(r.verdict.suggestions).toHaveLength(MAX_SUGGESTIONS);
    expect(r.cut).toEqual({ mustFix: 5, suggestions: 5 });
  });

  it("モデルが event や承認を書いても、受け取る形に含めない", () => {
    const r = parseReviewResponse(
      json({ event: "APPROVE", approve: true, must_fix: [], suggestions: [] }),
      paths,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.verdict).sort()).toEqual(["mustFix", "suggestions", "summary"]);
    expect(JSON.stringify(r)).not.toContain("APPROVE");
  });

  it("長すぎる文字列は切り詰める", () => {
    const r = parseReviewResponse(
      json({ must_fix: [item({ reason: "r".repeat(10_000) })], suggestions: [] }),
      paths,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.mustFix[0]?.reason.length).toBeLessThanOrEqual(2000);
  });
});
