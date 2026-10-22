import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 配色のトークン（B 制御卓）。色は :root のトークンに置き、コンポーネントの CSS・TSX に直接の色を書かない。
 * ライト（paper）が既定、ダーク（indigo）は prefers-color-scheme: dark で切り替える。
 */
const SRC = join(import.meta.dirname, "..", "src");
const css = readFileSync(join(SRC, "style.css"), "utf8");

/** 対応する閉じ括弧までのブロックの中身を返す（CSS のネストは 2 段まで） */
function blockAfter(text: string, head: RegExp): string {
  const m = head.exec(text);
  if (!m) throw new Error(`${head} が無い`);
  let depth = 0;
  const start = m.index + m[0].length;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      if (depth === 0) return text.slice(start, i);
      depth--;
    }
  }
  throw new Error("閉じていない");
}

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g))
    out[m[1] as string] = (m[2] as string).trim();
  return out;
}

const darkMedia = blockAfter(css, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/);
const light = tokens(blockAfter(css, /(^|\n):root\s*\{/));
const dark = tokens(blockAfter(darkMedia, /:root\s*\{/));

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const COLOR_TOKENS = [
  "bg",
  "fg",
  "dim",
  "faint",
  "line",
  "panel",
  "sel",
  "screen",
  "screen-fg",
  "prompt",
  "accent",
  "link",
  "mute",
  "fail",
  "bar",
  "bar2",
  "on-bar",
];

describe("配色のトークン", () => {
  it("ライト（paper）の指定値: 地・墨・藍・失敗", () => {
    expect(light.bg?.toLowerCase()).toBe("#e3e6e9");
    expect(light.fg?.toLowerCase()).toBe("#1e2932");
    expect(light.accent?.toLowerCase()).toBe("#2d4ba0");
    expect(light.fail?.toLowerCase()).toBe("#b83a1e");
    expect(light.screen?.toLowerCase()).toBe("#f6f7f8");
  });

  it("ダーク（indigo）の指定値: 地・文字・白緑・失敗。prefers-color-scheme: dark で切り替える", () => {
    expect(dark.bg?.toLowerCase()).toBe("#1b2238");
    expect(dark.fg?.toLowerCase()).toBe("#dce4ee");
    expect(dark.accent?.toLowerCase()).toBe("#7fd6b5");
    expect(dark.fail?.toLowerCase()).toBe("#ff8e72");
    expect(dark.screen?.toLowerCase()).toBe("#141a2c");
  });

  it("ライト・ダークとも、同じ名前のトークンが全部ある。color-scheme も宣言している", () => {
    for (const name of COLOR_TOKENS) {
      expect(light[name], `light --${name}`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(dark[name], `dark --${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(css).toMatch(/color-scheme:\s*light/);
    expect(darkMedia).toMatch(/color-scheme:\s*dark/);
  });

  // 文字の色 × 地の色。小さな dim・faint の文字も 4.5:1 以上
  const onBackgrounds = ["bg", "panel", "sel"];
  const textOnBackground = ["fg", "dim", "faint", "link", "accent", "fail", "mute"];
  const onScreen = ["screen-fg", "faint", "prompt", "fail", "dim", "accent", "link"];

  for (const [theme, t] of [
    ["ライト", light],
    ["ダーク", dark],
  ] as const) {
    it(`${theme}: 文字のコントラストは 4.5:1 以上（地・見出しの面・選択行）`, () => {
      for (const bg of onBackgrounds) {
        for (const fg of textOnBackground) {
          const r = contrast(t[fg] as string, t[bg] as string);
          expect(r, `${theme} --${fg} on --${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${theme}: 画面（screen）の上の文字のコントラストは 4.5:1 以上`, () => {
      for (const fg of onScreen) {
        const r = contrast(t[fg] as string, t.screen as string);
        expect(r, `${theme} --${fg} on --screen = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme}: ステータスバーの文字は 4.5:1 以上`, () => {
      for (const bg of ["bar", "bar2"]) {
        const r = contrast(t["on-bar"] as string, t[bg] as string);
        expect(r, `${theme} --on-bar on --${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("画面（screen）は暗くない面ではなく、ライトでは明るい面・ダークでは暗い面（トークンで決まる）", () => {
    expect(luminance(light.screen as string)).toBeGreaterThan(0.8);
    expect(luminance(dark.screen as string)).toBeLessThan(0.05);
  });
});

describe("色の直書きをしない", () => {
  const HEX_OR_FN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/;

  it("style.css は、トークンの定義（:root）の外に色の値を書かない", () => {
    const stripped = css
      .replace(darkMedia, "")
      .replace(/(^|\n):root\s*\{[^}]*\}/, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const hit = stripped.split("\n").filter((l) => HEX_OR_FN.test(l));
    expect(hit, `直書きの色: ${hit.join(" | ")}`).toEqual([]);
  });

  it("TSX / TS のコンポーネントにも色を直書きしない（fill / stroke / style）", () => {
    for (const f of readdirSync(SRC).filter((f) => /\.tsx?$/.test(f))) {
      const code = readFileSync(join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const hit = code.split("\n").filter((l) => !l.trim().startsWith("//") && HEX_OR_FN.test(l));
      expect(hit, `${f}: ${hit.join(" | ")}`).toEqual([]);
    }
  });
});

describe("動きの抑制", () => {
  it("prefers-reduced-motion では脈動・カーソルの点滅を止める", () => {
    const reduced = blockAfter(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
    expect(reduced).toMatch(/\.pulse[^{]*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.cursor[^{]*\{[^}]*animation:\s*none/);
  });

  it("抑制の指定は、抑える側の元の指定より後ろに書く（同じ重みなので、前に書くと効かない）", () => {
    const at = css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    for (const sel of [".pulse", ".cursor"]) {
      const base = css.search(new RegExp(`(^|\\n)\\${sel}\\s*\\{`));
      expect(base, `${sel} の元の指定`).toBeGreaterThanOrEqual(0);
      expect(at, `${sel} より後ろ`).toBeGreaterThan(base);
    }
  });
});
