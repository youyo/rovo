import { describe, expect, it } from "vitest";
import { buildProgressTail, normalizeCommandProgress, STRUCTURED_LIMITS } from "../src";

// 秘密の検出に反応しないよう、明らかな偽物を組み立てる
const GHP = `ghp_${"a1B2".repeat(9)}`;
const BEGIN = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
const END = ["-----END", "OPENSSH PRIVATE KEY-----"].join(" ");

describe("buildProgressTail（実行中の途中の出力を、出してよい形にする）", () => {
  it("最後の改行より後（未完の行）は出さない。改行が 1 つも無ければ空", () => {
    expect(buildProgressTail(["one\ntwo\npart"])).toBe("one\ntwo\n");
    expect(buildProgressTail(["no newline yet"])).toBe("");
  });

  it("stdout → stderr の順に、それぞれの未完の行を落としてから連結する", () => {
    expect(buildProgressTail(["out1\nout-part", "err1\nerr-part"])).toBe("out1\n\nerr1\n");
  });

  it("閉じていない -----BEGIN があれば、そこから先は出さない。閉じていれば鍵ごとマスクされる", () => {
    const open = `before\n${BEGIN}\nAAAABBBBCCCC\nDDDD\n`;
    expect(buildProgressTail([open])).toBe("before\n");
    const closed = buildProgressTail([`before\n${BEGIN}\nAAAABBBBCCCC\n${END}\nafter\n`]);
    expect(closed).not.toContain("AAAABBBBCCCC");
    expect(closed).toContain("after");
  });

  it("2,000 字に切る前の窓全体にマスクをかける（切ってからマスクすると、境目で割れた秘密が素通りする）", () => {
    // 切り取り位置（末尾から 2,000 字）の手前に ghp_ の頭が、内側に残りの部分が来る
    const tailPart = "z".repeat(1990);
    const text = `${"a".repeat(500)} ${GHP} ${tailPart}\n`;
    const cutAt = text.length - STRUCTURED_LIMITS.outputTail;
    expect(text.indexOf(GHP)).toBeLessThan(cutAt);
    expect(text.indexOf(GHP) + GHP.length).toBeGreaterThan(cutAt);
    const out = buildProgressTail([text]);
    expect(out.length).toBeLessThanOrEqual(STRUCTURED_LIMITS.outputTail);
    expect(out).not.toContain(GHP.slice(-20));
    expect(out).not.toContain(GHP.slice(10));
  });

  it("ANSI を先に除くので、色コードで割った秘密もマスクされる", () => {
    const split = `${GHP.slice(0, 10)}\u001b[0m${GHP.slice(10)}\n`;
    const out = buildProgressTail([split]);
    expect(out).not.toContain(GHP.slice(12));
    expect(out).not.toContain("\u001b");
  });

  it("末尾 2,000 字に収める", () => {
    const out = buildProgressTail(["line\n".repeat(2000)]);
    expect(out.length).toBeLessThanOrEqual(STRUCTURED_LIMITS.outputTail);
    expect(out.endsWith("line\n")).toBe(true);
  });
});

describe("normalizeCommandProgress", () => {
  const base = { command: "pnpm test", startedAt: 1_700_000_000_000 };

  it("command・cwd・開始時刻・出力の末尾だけを返し、未知の項目は落とす", () => {
    expect(
      normalizeCommandProgress({ ...base, cwd: "apps/gateway", outputTail: "ok\n", extra: "x" }),
    ).toEqual({
      type: "command_progress",
      command: "pnpm test",
      cwd: "apps/gateway",
      startedAt: 1_700_000_000_000,
      outputTail: "ok\n",
    });
  });

  it("出力の末尾の秘密はマスクされ、制御文字は除かれる", () => {
    const e = normalizeCommandProgress({
      ...base,
      outputTail: `x ${GHP} \u001b[31mred\u001b[0m\n`,
    });
    expect(JSON.stringify(e)).not.toContain(GHP);
    expect(e?.outputTail).toContain("red");
    expect(e?.outputTail).not.toContain("\u001b");
  });

  it("command が無い・startedAt が数でないものは捨てる。ended: true は通す", () => {
    expect(normalizeCommandProgress({ startedAt: 1 })).toBeUndefined();
    expect(normalizeCommandProgress({ command: "ls", startedAt: "x" })).toBeUndefined();
    expect(normalizeCommandProgress({ ...base, ended: true })?.ended).toBe(true);
    expect(normalizeCommandProgress({ ...base, ended: "yes" })?.ended).toBeUndefined();
  });
});
