import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 狭い幅（360px）で崩れないための CSS の指定。jsdom は寸法を持たないので、
 * 指定そのもの（折り返す・縮められる・はみ出さない）を style.css から読んで確かめる（実機の寸法は e2e/layout.spec.ts）。
 */
const css = readFileSync(join(import.meta.dirname, "..", "src", "style.css"), "utf8");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** セレクタ 1 つだけの規則の本体（グループ化された規則や @media の中は拾わない） */
function body(selector: string): string {
  const m = new RegExp(`(?:^|\\n)${escapeRe(selector)}\\s*\\{([^}]*)\\}`).exec(css);
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

  it("色は tone ごとにトークンだけ（緑=ok、赤=fail、黄=run-ring、青=wait、灰=skip）", () => {
    expect(body(".mark-sym--ok")).toMatch(/color:\s*var\(--ok\)/);
    expect(body(".mark-sym--bad")).toMatch(/color:\s*var\(--fail\)/);
    expect(body(".mark-sym--run")).toMatch(/color:\s*var\(--run-ring\)/);
    expect(body(".mark-sym--wait")).toMatch(/color:\s*var\(--wait\)/);
    expect(body(".mark-sym--skip")).toMatch(/color:\s*var\(--skip\)/);
  });

  it("レールの行は印と文字を縦の中央にそろえる（印が文字より上に飛び出さない）", () => {
    expect(body(".rail-row")).toMatch(/align-items:\s*center/);
  });

  it("回転（.spin）は動きだけ。形は記号が持つ（点の見た目を持たない）", () => {
    const spin = body(".spin");
    expect(spin).toMatch(/animation:\s*rovo-spin/);
    expect(spin).not.toMatch(/border-radius|background/);
  });
});

describe("レールの行（2 行）・数字の右揃え", () => {
  it("行は「印・題名・所要」の 1 行目と、2 行目（rail-meta）の格子。印と題名は縦の中央", () => {
    const row = body(".rail-row");
    expect(row).toMatch(/display:\s*grid/);
    expect(row).toMatch(/align-items:\s*center/);
    expect(body(".rail-meta")).toMatch(/grid-column:\s*2\s*\/\s*4/);
  });

  it("選んだ行は左に青い線（wait のトークン）", () => {
    expect(body('.rail-row[data-selected="true"]')).toMatch(/border-left-color:\s*var\(--wait\)/);
  });

  it("所要と費用は、数字の右揃え（tabular-nums）で JetBrains Mono", () => {
    for (const sel of [".rail-time", ".rail-cost"]) {
      const b = body(sel);
      expect(b, sel).toMatch(/font-variant-numeric:\s*tabular-nums/);
      expect(b, sel).toMatch(/text-align:\s*right/);
      expect(b, sel).toMatch(/font-family:\s*var\(--mono\)/);
    }
  });
});

describe("段階の図・ログの箱", () => {
  it("段階の線（band-edge）は灰、済んだ区間（.done）は緑（ok）", () => {
    expect(body(".band-edge")).toMatch(/background:\s*var\(--line\)/);
    expect(body(".band-edge.done")).toMatch(/background:\s*var\(--ok\)/);
  });

  it("「いま」の行は黄色の注意の枠（now-bg / now-line のトークン）", () => {
    const b = body(".now-line");
    expect(b).toMatch(/background:\s*var\(--now-bg\)/);
    expect(b).toMatch(/border:\s*1px solid var\(--now-line\)/);
  });

  it("ログの箱は暗い面（screen）。ステップの所要は右寄せで数字をそろえる", () => {
    expect(body(".logbox")).toMatch(/background:\s*var\(--screen\)/);
    const dur = body(".step-dur");
    expect(dur).toMatch(/text-align:\s*right/);
    expect(dur).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("出力の行番号は CSS の counter（文字列に混ぜない）", () => {
    expect(css).toMatch(/\.out-line::before\s*\{[^}]*counter-increment:\s*ln/);
    expect(body(".output")).toMatch(/counter-reset:\s*ln/);
  });

  it("本文は IBM Plex Sans JP、ログは JetBrains Mono（トークン経由）", () => {
    expect(body("body")).toMatch(/font-family:\s*var\(--font\)/);
    expect(css).toMatch(/\n\.screen\s*\{[^}]*font-family:\s*var\(--mono\)/);
  });
});

describe("チームボード（幅 360px でも横にはみ出さない）", () => {
  it("人の行は折り返せて、名前は縮めて省略する。数字は桁をそろえる", () => {
    expect(body(".tb-row")).toMatch(/flex-wrap:\s*wrap/);
    const login = body(".tb-login-text");
    expect(login).toMatch(/min-width:\s*0/);
    expect(login).toMatch(/text-overflow:\s*ellipsis/);
    expect(body(".tb-task-title")).toMatch(/text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.tb-stat-n,[^{]*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });

  it("リポジトリの表は幅を固定し、長い名前は折り返す", () => {
    expect(body(".tb-repos")).toMatch(/table-layout:\s*fixed/);
    expect(body(".tb-repos")).toMatch(/width:\s*100%/);
    expect(css).toMatch(/\.tb-repos td\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("720px 以下では統計の文字を畳み（読み上げには残す）、記号と数字だけにする", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 720px) {\n  .tb-section"));
    expect(narrow).toMatch(/\.tb-stat-label\s*\{[^}]*clip-path:\s*inset\(50%\)/);
  });
});
