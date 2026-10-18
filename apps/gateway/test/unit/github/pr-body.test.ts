import { describe, expect, it } from "vitest";
import {
  applyManagedBlock,
  fenceUntrusted,
  MANAGED_BEGIN,
  MANAGED_END,
  MAX_PR_BODY_CHARS,
  type PrReport,
  renderInitialBlock,
  renderReportBlock,
} from "../../../src/github/pr-body";

const base: PrReport = {
  taskId: "T1",
  status: "COMPLETED",
  summary: "did the thing",
  verified: true,
  commitSha: "a".repeat(40),
  results: [{ argv: ["npm", "test"], exitCode: 0, timedOut: false, output: "ok" }],
  warnings: [],
  headSha: "a".repeat(40),
  headMatches: true,
};

describe("fenceUntrusted", () => {
  it("コードフェンスで囲み、本文中の ``` より長いフェンスを使う", () => {
    const out = fenceUntrusted("x\n```\nevil\n```\n", 1000);
    expect(out.startsWith("````\n")).toBe(true);
    expect(out.trimEnd().endsWith("````")).toBe(true);
  });
  it("上限を超えたら切り詰めて、切ったことを示す", () => {
    const out = fenceUntrusted("a".repeat(500), 100);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(300);
  });
  it("管理範囲の目印を無害化する（本文の書き換え位置を乗っ取られない）", () => {
    const out = fenceUntrusted(`${MANAGED_END} ${MANAGED_BEGIN}`, 1000);
    expect(out).not.toContain(MANAGED_END);
    expect(out).not.toContain(MANAGED_BEGIN);
  });
});

describe("applyManagedBlock", () => {
  const block = (s: string) => `${MANAGED_BEGIN}\n${s}\n${MANAGED_END}`;
  it("目印の間だけを置き換え、外側（利用者の編集）は残す", () => {
    const body = `before\n${block("old")}\nafter`;
    expect(applyManagedBlock(body, block("new"))).toBe(`before\n${block("new")}\nafter`);
  });
  it("目印が無ければ末尾に足す", () => {
    expect(applyManagedBlock("hello", block("n"))).toBe(`hello\n\n${block("n")}`);
  });
  it("2 回適用しても同じ（冪等）", () => {
    const once = applyManagedBlock(`x\n${block("old")}`, block("n"));
    expect(applyManagedBlock(once, block("n"))).toBe(once);
  });
  it("全体が上限を超えるなら、管理範囲の外側を削らず例外にせず、上限に収める", () => {
    const out = applyManagedBlock("z".repeat(MAX_PR_BODY_CHARS + 10), block("n"));
    expect(out.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    expect(out).toContain(MANAGED_BEGIN);
  });
});

describe("renderInitialBlock", () => {
  it("状態は作業中で、目印で囲まれ、タスク ID を含む", () => {
    const b = renderInitialBlock("T1");
    expect(b.startsWith(MANAGED_BEGIN)).toBe(true);
    expect(b.endsWith(MANAGED_END)).toBe(true);
    expect(b).toContain("T1");
  });
});

describe("renderReportBlock", () => {
  it("状態・検証結果・コミットを含み、目印で囲まれる", () => {
    const b = renderReportBlock(base, { showCost: false });
    expect(b.startsWith(MANAGED_BEGIN)).toBe(true);
    expect(b.endsWith(MANAGED_END)).toBe(true);
    expect(b).toContain("COMPLETED");
    expect(b).toContain("npm test");
    expect(b).toContain("a".repeat(40));
  });

  it("モデルの要約・検証出力・警告はコードフェンスに入る", () => {
    const b = renderReportBlock(
      { ...base, summary: "# injected\n@everyone", warnings: ["w <script>"] },
      { showCost: false },
    );
    expect(b).toMatch(/```\n# injected\n@everyone\n```/);
    expect(b).toMatch(/```\nw <script>\n```/);
  });

  it("費用は showCost のときだけ載せる", () => {
    const r = { ...base, costUsd: 1.2345 };
    expect(renderReportBlock(r, { showCost: false })).not.toMatch(/1\.23/);
    expect(renderReportBlock(r, { showCost: true })).toMatch(/1\.23/);
  });

  it("head が検証済みの SHA と違うときは警告を載せる", () => {
    const b = renderReportBlock(
      { ...base, headSha: "b".repeat(40), headMatches: false },
      { showCost: false },
    );
    expect(b).toMatch(/head/i);
    expect(b).toContain("b".repeat(40));
  });

  it("未解決事項: 検証していない・失敗したコマンドがあれば列挙する", () => {
    const b = renderReportBlock(
      {
        ...base,
        verified: false,
        results: [{ argv: ["npm", "test"], exitCode: 1, timedOut: false, output: "FAIL" }],
      },
      { showCost: false },
    );
    expect(b).toMatch(/exit 1/);
  });

  it("巨大な入力でも上限に収まる", () => {
    const huge = "x".repeat(200_000);
    const b = renderReportBlock(
      {
        ...base,
        summary: huge,
        warnings: Array.from({ length: 200 }, () => huge),
        results: Array.from({ length: 50 }, () => ({
          argv: ["c"],
          exitCode: 1,
          timedOut: false,
          output: huge,
        })),
      },
      { showCost: true },
    );
    expect(b.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS - 2000);
    expect(b.startsWith(MANAGED_BEGIN)).toBe(true);
    expect(b.endsWith(MANAGED_END)).toBe(true);
  });
  it("SHA の形でない commitSha / headSha（Markdown のリンクなど）は本文に出さない", () => {
    const evil = "a](https://evil.example/x)";
    const out = renderReportBlock({ ...base, commitSha: evil, headSha: evil }, { showCost: false });
    expect(out).not.toContain("evil.example");
    expect(out).toContain("Verification:");
  });

  it("Reason は改行してからフェンスで囲む", () => {
    const out = renderReportBlock({ ...base, reason: "boom" }, { showCost: false });
    expect(out).toMatch(/\nReason:\n\n```\nboom\n```\n/);
  });

  it("コマンド名の改行は 1 つの空白にし、200 文字に切る", () => {
    const argv = ["echo", "a\n## injected\r\nb", "x".repeat(500)];
    const out = renderReportBlock(
      { ...base, results: [{ argv, exitCode: 1, timedOut: false, output: "bad" }] },
      { showCost: false },
    );
    const line = out.split("\n").find((l) => l.startsWith("- `echo")) ?? "";
    expect(line).toContain("echo a ## injected b ");
    expect(out).not.toMatch(/^## injected/m);
    expect(line.length).toBeLessThan(260);
  });
});
