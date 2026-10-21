import { describe, expect, it } from "vitest";
import { runDeterministicRules } from "../../src/policy-engine";
import {
  BENIGN_SAMPLES,
  type DeterministicExpectation,
  INJECTION_SAMPLES,
  type SampleKind,
} from "../support/injection-samples";

/** 決定論ルールだけを通したときの、サンプルの最も強い判定 */
function deterministicVerdict(text: string): DeterministicExpectation {
  const findings = runDeterministicRules(text);
  if (findings.some((f) => f.verdict === "block")) return "block";
  if (findings.length > 0) return "caution";
  return "none";
}

const KINDS: SampleKind[] = [
  "override",
  "evaluator_target",
  "hidden",
  "tool_or_exfil",
  "role_spoofing",
];

describe("注入サンプルの構成（acceptance.md 13 節）", () => {
  it.each(["ja", "en"] as const)(
    "%s: 注入サンプルが 10 件以上、通常のページが 10 件以上",
    (lang) => {
      expect(INJECTION_SAMPLES.filter((s) => s.lang === lang).length).toBeGreaterThanOrEqual(10);
      expect(BENIGN_SAMPLES.filter((s) => s.lang === lang).length).toBeGreaterThanOrEqual(10);
    },
  );

  it.each(["ja", "en"] as const)(
    "%s: 5 つの種類（命令の上書き・評価器を狙う・隠す・ツール/送信・役割偽装）がそろう",
    (lang) => {
      for (const kind of KINDS) {
        expect(
          INJECTION_SAMPLES.some((s) => s.lang === lang && s.kind === kind),
          `${lang}/${kind}`,
        ).toBe(true);
      }
    },
  );

  it("id が重複しない。本文は空でない", () => {
    const ids = [...INJECTION_SAMPLES, ...BENIGN_SAMPLES].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of [...INJECTION_SAMPLES, ...BENIGN_SAMPLES]) {
      expect(s.text.length, s.id).toBeGreaterThan(0);
    }
  });

  it("実在しうる宛先を含まない（予約済みの .example だけ）", () => {
    for (const s of [...INJECTION_SAMPLES, ...BENIGN_SAMPLES]) {
      for (const m of s.text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        expect(m[1]?.endsWith(".example"), `${s.id}: ${m[1]}`).toBe(true);
      }
    }
  });
});

describe("決定論ルールの期待値（サンプルごと）", () => {
  it.each(INJECTION_SAMPLES)("注入 $id: $deterministic", (s) => {
    expect(deterministicVerdict(s.text)).toBe(s.deterministic);
  });

  it.each(BENIGN_SAMPLES)("通常 $id: $deterministic", (s) => {
    expect(deterministicVerdict(s.text)).toBe(s.deterministic);
  });
});

describe("決定論ルールの検出率と誤検知率（モデルを除く。M9 の実機の比較の基準線）", () => {
  const rate = (xs: { deterministic: DeterministicExpectation }[]) =>
    xs.filter((x) => x.deterministic !== "none").length / xs.length;

  it.each(["ja", "en"] as const)("%s: 検出率と誤検知率を計算し、基準線を下回らない", (lang) => {
    const inj = INJECTION_SAMPLES.filter((s) => s.lang === lang);
    const ben = BENIGN_SAMPLES.filter((s) => s.lang === lang);
    const actualDetect =
      inj.filter((s) => deterministicVerdict(s.text) !== "none").length / inj.length;
    const actualFalsePositive =
      ben.filter((s) => deterministicVerdict(s.text) !== "none").length / ben.length;
    console.info(
      `[injection-samples] ${lang}: 検出率 ${(actualDetect * 100).toFixed(0)}% (${inj.length} 件)、誤検知率 ${(actualFalsePositive * 100).toFixed(0)}% (${ben.length} 件)`,
    );
    // 期待値の表から出した率と、実測が一致する（ルールを変えたら表を更新する）
    expect(actualDetect).toBe(rate(inj));
    expect(actualFalsePositive).toBe(rate(ben));
    // 基準線（実測: ja 検出 64% / 誤検知 30%、en 検出 64% / 誤検知 33%。en は 2026-10-22 に、宛先のない changelog の行を通常サンプルに足した）。ルールを直して悪化させない。
    // en の検出率は 64%（7/11）で、基準線 0.6 との余裕はサンプル 1 件分しかない。1 件取りこぼすと 55% で落ちる。
    // 誤検知率の上限 0.4 は、実測（ja 30% / en 33%）に近い値。
    // サンプルを増やしたり入れ替えたりするときは、実測を見てこの基準線を見直す（引き上げるのはよいが、下げない）。
    expect(actualDetect).toBeGreaterThanOrEqual(0.6);
    expect(actualFalsePositive).toBeLessThanOrEqual(0.4);
  });
});
