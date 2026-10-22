import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 狭い幅（360px）で崩れないための CSS の指定。jsdom は寸法を持たないので、
 * 指定そのもの（折り返す・縮められる・はみ出さない）を style.css から読んで確かめる（実機の寸法は e2e/layout.spec.ts）。
 */
const css = readFileSync(join(import.meta.dirname, "..", "src", "style.css"), "utf8");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** セレクタ 1 つだけの規則の本体（グループ化された規則や @media の中は拾わない） */
function body(selector: string): string {
  const m = new RegExp(`(?:^|\\n)${escape(selector)}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`${selector} の規則が無い`);
  return m[1] as string;
}

describe("予算の欄（幅 360px でも横にはみ出さず、数値が重ならない）", () => {
  it("1 行は「名前（折り返せる）と値（折り返さない）」を両端に置く。細い罫線で区切る", () => {
    const row = body(".budget-row");
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/justify-content:\s*space-between/);
    expect(row).toMatch(/border-top:\s*1px solid var\(--line\)/);
    expect(row).toMatch(/gap:\s*\d+px\s+\d+px/);
  });

  it("名前は縮められて、長ければ折り返す（値を押し出さない）", () => {
    const dt = body(".budget-row dt");
    expect(dt).toMatch(/min-width:\s*0/);
    expect(dt).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("値は縮めず・折り返さず、桁をそろえる（等幅の数字。重ならない）", () => {
    const dd = body(".budget-value");
    expect(dd).toMatch(/flex:\s*none/);
    expect(dd).toMatch(/white-space:\s*nowrap/);
    expect(dd).toMatch(/text-align:\s*right/);
    expect(dd).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("欄は縮められる（min-width: 0）。引き出しの列の最小幅は 360px の画面の中に収まる", () => {
    expect(body(".panel")).toMatch(/min-width:\s*0/);
    const min = Number(/minmax\((\d+)px/.exec(body(".drawer-grid"))?.[1]);
    // 360 - 画面の左右の余白 16 * 2（720px 以下）- 引き出しの左右の余白 16 * 2 - 罫線 2
    expect(min).toBeLessThanOrEqual(360 - 32 - 32 - 2);
  });

  it("色・余白・書体は既存のトークン（var(--...)）だけを使う", () => {
    for (const sel of [".budget-row", ".budget-row dt", ".budget-value", ".budget-row--all"]) {
      expect(body(sel), sel).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb|hsl/);
    }
    expect(body(".budget-row dt")).toMatch(/color:\s*var\(--dim\)/);
    expect(body(".budget-row--all")).toMatch(/var\(--/);
  });
});

describe("状態の印（SVG の記号）の大きさと色", () => {
  it("大きさは文字の高さに近い（1.1em 前後）。縮まない", () => {
    const m = body(".mark-sym");
    const w = Number(/width:\s*([\d.]+)em/.exec(m)?.[1]);
    const h = Number(/height:\s*([\d.]+)em/.exec(m)?.[1]);
    expect(w).toBeGreaterThanOrEqual(1);
    expect(w).toBeLessThanOrEqual(1.3);
    expect(h).toBe(w);
    expect(m).toMatch(/flex:\s*none/);
    expect(m).toMatch(/stroke:\s*currentColor/);
  });

  it("色は tone ごとに既存のトークンだけ（青=accent、オレンジ=fail、灰=mute、墨=fg）", () => {
    expect(body(".mark-sym--blue")).toMatch(/color:\s*var\(--accent\)/);
    expect(body(".mark-sym--orange")).toMatch(/color:\s*var\(--fail\)/);
    expect(body(".mark-sym--gray")).toMatch(/color:\s*var\(--mute\)/);
    expect(body(".mark-sym--ink")).toMatch(/color:\s*var\(--fg\)/);
  });

  it("レールの行は印と文字を縦の中央にそろえる（印が文字より上に飛び出さない）", () => {
    expect(body(".rail-row")).toMatch(/align-items:\s*center/);
  });

  it("脈動（.pulse）は動きだけ。形は記号が持つ（点の見た目を持たない）", () => {
    const pulse = body(".pulse");
    expect(pulse).toMatch(/animation:\s*rovo-beat/);
    expect(pulse).not.toMatch(/border-radius|background/);
  });
});
