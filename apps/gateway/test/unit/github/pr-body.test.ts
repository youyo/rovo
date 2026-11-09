import { describe, expect, it } from "vitest";
import {
  applyManagedBlock,
  fenceUntrusted,
  LEGACY_BEGIN,
  LEGACY_END,
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
    const out = fenceUntrusted(
      `${LEGACY_END} ${LEGACY_BEGIN} <!-- rovo:end task=T1 --> <!--rovo:begin task=T1 -->`,
      1000,
    );
    expect(out).not.toContain(LEGACY_END);
    expect(out).not.toContain(LEGACY_BEGIN);
    expect(out).not.toContain("<!-- rovo:end task=T1 -->");
    expect(out).not.toMatch(/<!--\s*rovo:/i);
    // 目印は無害化されるが、目印の後ろの元の本文（task=T1 -->）は残ることを確かめる
    expect(out).toContain("end task=T1 -->");
    expect(out).toContain("begin task=T1 -->");
  });
});

describe("applyManagedBlock", () => {
  const sec = (id: string, s: string) =>
    `<!-- rovo:begin task=${id} -->\n## rovo — task ${id}\n${s}\n<!-- rovo:end task=${id} -->`;
  const legacy = (s: string) => `${LEGACY_BEGIN}\n${s}\n${LEGACY_END}`;
  const root = { isRoot: true };
  const cont = { isRoot: false };

  it("自分の id の節だけを置き換え、外側（利用者の編集）と他タスクの節は残す", () => {
    const body = `before\n${sec("A", "a-old")}\nmid\n${sec("B", "b-old")}\nafter`;
    const out = applyManagedBlock(body, sec("B", "b-new"), "B", cont);
    expect(out).toBe(`before\n${sec("A", "a-old")}\nmid\n${sec("B", "b-new")}\nafter`);
    const out2 = applyManagedBlock(body, sec("A", "a-new"), "A", root);
    expect(out2).toBe(`before\n${sec("A", "a-new")}\nmid\n${sec("B", "b-old")}\nafter`);
  });
  it("根のタスクは、自分の節が無ければ旧形式の 1 組を書き換える", () => {
    const body = `before\n${legacy("old")}\nafter`;
    expect(applyManagedBlock(body, sec("A", "n"), "A", root)).toBe(
      `before\n${sec("A", "n")}\nafter`,
    );
  });
  it("根のタスクは、目印が何も無ければ末尾に足す", () => {
    expect(applyManagedBlock("hello", sec("A", "n"), "A", root)).toBe(`hello\n\n${sec("A", "n")}`);
  });
  it("積み足しは、旧形式の 1 組に触らず、その後ろに節を足す", () => {
    const body = `before\n${legacy("old")}\nafter`;
    const out = applyManagedBlock(body, sec("B", "n"), "B", cont);
    expect(out).toContain(legacy("old"));
    expect(out.indexOf(sec("B", "n"))).toBeGreaterThan(out.indexOf(LEGACY_END));
    expect(out.startsWith(`before\n${legacy("old")}`)).toBe(true);
    expect(out.endsWith("after")).toBe(true);
    expect(applyManagedBlock(out, sec("B", "n"), "B", cont)).toBe(out);
  });
  it("積み足しは、最後の rovo の目印（新形式）の直後に足す", () => {
    const body = `x\n${sec("A", "a")}\ny\n${sec("B", "b")}\nz`;
    const out = applyManagedBlock(body, sec("C", "c"), "C", cont);
    expect(out).toBe(`x\n${sec("A", "a")}\ny\n${sec("B", "b")}\n\n${sec("C", "c")}\nz`);
  });
  it("積み足しは、目印が 1 つも無ければ末尾に足す", () => {
    expect(applyManagedBlock("hello", sec("B", "n"), "B", cont)).toBe(`hello\n\n${sec("B", "n")}`);
  });
  it("2 回適用しても同じ（冪等）", () => {
    const once = applyManagedBlock(`x\n${sec("A", "old")}`, sec("A", "n"), "A", root);
    expect(applyManagedBlock(once, sec("A", "n"), "A", root)).toBe(once);
  });
  it("全体が上限を超えるなら、外側を使って例外にせず、上限に収める", () => {
    const out = applyManagedBlock("z".repeat(MAX_PR_BODY_CHARS + 10), sec("A", "n"), "A", root);
    expect(out.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    expect(out).toContain("<!-- rovo:begin task=A -->");
  });
  it("上限を超えると、前の節が古い順に短い形に縮み、今の節は完全なまま", () => {
    const full = (id: string) =>
      renderReportBlock(
        {
          ...base,
          taskId: id,
          summary: `first line of ${id}\n${"s".repeat(9000)}`,
          results: [
            { argv: ["npm", "test"], exitCode: 1, timedOut: false, output: "o".repeat(3000) },
          ],
        },
        { showCost: false },
      );
    let body = "user text";
    const ids = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"];
    for (const [i, id] of ids.entries()) {
      body = applyManagedBlock(body, full(id), id, { isRoot: i === 0 });
      expect(body.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    }
    expect(body.startsWith("user text")).toBe(true);
    // 今の節は完全
    expect(body).toContain(full("T7"));
    // 最も古い節は縮んでいる（目印は残る）
    expect(body).toContain("<!-- rovo:begin task=T1 -->");
    expect(body).toContain("<!-- rovo:end task=T1 -->");
    expect(body).not.toContain(full("T1"));
    // 縮んだ形は状態・検証・head・summary の先頭 1 行を残す
    const t1 = body.slice(
      body.indexOf("<!-- rovo:begin task=T1 -->"),
      body.indexOf("<!-- rovo:end task=T1 -->"),
    );
    expect(t1).toContain("## rovo — task T1");
    expect(t1).toContain("COMPLETED");
    expect(t1).toContain("Verification:");
    expect(t1).toContain(`PR head: \`${"a".repeat(40)}\``);
    expect(t1).toContain("first line of T1");
    expect(t1).not.toContain("sssss");
    expect(t1).not.toContain("ooooo");
    // 全部の節の目印が残る
    for (const id of ids) expect(body).toContain(`<!-- rovo:end task=${id} -->`);
  });
  it("それでも収まらなければ、前の節は目印と見出しだけになる", () => {
    let body = "";
    const many = Array.from({ length: 250 }, (_, i) => `K${i}`);
    for (const [i, id] of many.entries()) {
      body = applyManagedBlock(
        body,
        renderReportBlock({ ...base, taskId: id, summary: "y".repeat(300) }, { showCost: false }),
        id,
        { isRoot: i === 0 },
      );
      expect(body.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    }
    expect(body).toContain(
      "<!-- rovo:begin task=K0 -->\n## rovo — task K0\n<!-- rovo:end task=K0 -->",
    );
    expect(body).toContain("<!-- rovo:end task=K249 -->");
    expect(body).toContain("y".repeat(300));
  });
});

describe("renderInitialBlock", () => {
  it("状態は作業中で、目印で囲まれ、タスク ID を含む", () => {
    const b = renderInitialBlock("T1");
    expect(b.startsWith("<!-- rovo:begin task=T1 -->\n## rovo — task T1")).toBe(true);
    expect(b.endsWith("<!-- rovo:end task=T1 -->")).toBe(true);
    expect(b).toContain("T1");
  });
  it("積み足しの節には Continues task の行が入る", () => {
    expect(renderInitialBlock("T2", { continuesTask: "T1" })).toContain("Continues task T1");
    expect(renderInitialBlock("T1")).not.toContain("Continues task");
  });
  it("id が許す文字以外なら拒否する", () => {
    expect(() => renderInitialBlock("a b")).toThrow();
    expect(() => renderInitialBlock("a-->")).toThrow();
  });
});

describe("renderReportBlock", () => {
  it("状態・検証結果・コミットを含み、目印で囲まれる", () => {
    const b = renderReportBlock(base, { showCost: false });
    expect(b.startsWith("<!-- rovo:begin task=T1 -->\n## rovo — task T1")).toBe(true);
    expect(b.endsWith("<!-- rovo:end task=T1 -->")).toBe(true);
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
    expect(b.startsWith("<!-- rovo:begin task=T1 -->")).toBe(true);
    expect(b.endsWith("<!-- rovo:end task=T1 -->")).toBe(true);
  });
  it("積み足しの節の見出しと Continues task", () => {
    const b = renderReportBlock(
      { ...base, taskId: "T2", continuesTask: "T1" },
      { showCost: false },
    );
    expect(b).toContain("## rovo — task T2\nContinues task T1\n");
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
