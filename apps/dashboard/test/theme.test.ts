import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 配色のトークン（GitHub Actions 型）。色は :root のトークンに置き、コンポーネントの CSS・TSX に直接の色を書かない。
 * ライトが既定（背景 #f6f8fa・カード #fff）、ダークは GitHub のダーク（背景 #0d1117・カード #161b22）に寄せ、prefers-color-scheme: dark で切り替える。
 * ログの箱（--screen）はライトでも暗い面（#0d1117）。
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
  "ok",
  "run",
  "run-ring",
  "wait",
  "skip",
  "on-mark",
  "now-bg",
  "now-line",
  "bar",
  "bar2",
  "on-bar",
  "log-dim",
  "log-line",
  "log-hover",
  "log-ok",
  "log-bad",
  "log-run",
  "log-info",
  "person-0",
  "person-1",
  "person-2",
  "person-3",
  "person-4",
  "person-5",
  "on-person",
];

describe("配色のトークン", () => {
  it("ライトの指定値: 背景・カード・文字・薄い文字・線・成功・失敗・実行中・レビュー待ち・ログ", () => {
    expect(light.bg?.toLowerCase()).toBe("#f6f8fa");
    expect(light.panel?.toLowerCase()).toBe("#ffffff");
    expect(light.fg?.toLowerCase()).toBe("#1f2328");
    expect(light.dim?.toLowerCase()).toBe("#59636e");
    expect(light.line?.toLowerCase()).toBe("#d1d9e0");
    expect(light.ok?.toLowerCase()).toBe("#1a7f37");
    expect(light.fail?.toLowerCase()).toBe("#cf222e");
    expect(light.run?.toLowerCase()).toBe("#9a6700");
    expect(light["run-ring"]?.toLowerCase()).toBe("#bf8700");
    expect(light.wait?.toLowerCase()).toBe("#0969da");
    expect(light.screen?.toLowerCase()).toBe("#0d1117");
    expect(light["screen-fg"]?.toLowerCase()).toBe("#e6edf3");
  });

  it("ダークの指定値（GitHub のダーク）: 背景・カード・線・文字。prefers-color-scheme: dark で切り替える", () => {
    expect(dark.bg?.toLowerCase()).toBe("#0d1117");
    expect(dark.panel?.toLowerCase()).toBe("#161b22");
    expect(dark.line?.toLowerCase()).toBe("#30363d");
    expect(dark.fg?.toLowerCase()).toBe("#e6edf3");
  });

  it("ライト・ダークとも、同じ名前のトークンが全部ある。color-scheme も宣言している", () => {
    for (const name of COLOR_TOKENS) {
      expect(light[name], `light --${name}`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(dark[name], `dark --${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(css).toMatch(/color-scheme:\s*light/);
    expect(darkMedia).toMatch(/color-scheme:\s*dark/);
  });

  it("書体: 本文は IBM Plex Sans JP、ログ・コマンド・数字は JetBrains Mono（トークン --font / --mono）", () => {
    const rootBlock = blockAfter(css, /(^|\n):root\s*\{/);
    expect(rootBlock).toMatch(/--font:\s*"IBM Plex Sans JP"/);
    expect(rootBlock).toMatch(/--mono:\s*"JetBrains Mono"/);
    expect(css).not.toMatch(/M PLUS 1 Code/);
  });

  // 文字の色 × 地の色。小さな dim の文字も 4.5:1 以上
  const onBackgrounds = ["bg", "panel", "sel"];
  const textOnBackground = ["fg", "dim", "link", "accent", "fail", "mute"];
  // 状態の色の文字（成功・実行中・レビュー待ち）は、地とカードの上
  const statusText = ["ok", "run", "wait"];
  const onScreen = ["screen-fg", "log-dim", "prompt", "log-ok", "log-bad", "log-run", "log-info"];

  for (const [theme, t] of [
    ["ライト", light],
    ["ダーク", dark],
  ] as const) {
    it(`${theme}: 文字のコントラストは 4.5:1 以上（地・カード・選択行）`, () => {
      for (const bg of onBackgrounds) {
        for (const fg of textOnBackground) {
          const r = contrast(t[fg] as string, t[bg] as string);
          expect(r, `${theme} --${fg} on --${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const bg of ["bg", "panel"]) {
        for (const fg of statusText) {
          const r = contrast(t[fg] as string, t[bg] as string);
          expect(r, `${theme} --${fg} on --${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${theme}: 「いま」の行（黄色の注意の枠）の文字は 4.5:1 以上`, () => {
      const r = contrast(t.fg as string, t["now-bg"] as string);
      expect(r, `${theme} --fg on --now-bg = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: ログの箱の上の文字のコントラストは 4.5:1 以上`, () => {
      for (const fg of onScreen) {
        const r = contrast(t[fg] as string, t.screen as string);
        expect(r, `${theme} --${fg} on --screen = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      const hover = contrast(t["log-dim"] as string, t["log-hover"] as string);
      expect(hover, `${theme} --log-dim on --log-hover`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: ステータスバーの文字は 4.5:1 以上`, () => {
      for (const bg of ["bar", "bar2"]) {
        const r = contrast(t["on-bar"] as string, t[bg] as string);
        expect(r, `${theme} --on-bar on --${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme}: 工場の帯の人の色（--person-0〜5）の上の頭文字（--on-person）は 4.5:1 以上`, () => {
      for (let i = 0; i < 6; i++) {
        const r = contrast(t["on-person"] as string, t[`person-${i}`] as string);
        expect(r, `${theme} --on-person on --person-${i} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });

    it(`${theme}: 人の色は 6 色とも違う`, () => {
      const colors = Array.from({ length: 6 }, (_, i) => t[`person-${i}`]?.toLowerCase());
      expect(new Set(colors).size).toBe(6);
    });

    it(`${theme}: 状態の丸（塗り）の中の記号（--on-mark）は、丸の色の上で 3:1 以上（記号は文字ではなく図形）`, () => {
      for (const fill of ["ok", "fail", "wait", "run-ring", "skip"]) {
        const r = contrast(t["on-mark"] as string, t[fill] as string);
        expect(r, `${theme} --on-mark on --${fill} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("ログの箱はライトでも暗い面（トークンで決まる）。ダークの地とも見分けがつく", () => {
    expect(luminance(light.screen as string)).toBeLessThan(0.05);
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
  it("prefers-reduced-motion では回る輪（実行中）の回転・カーソルの点滅を止める。回る輪は破線の輪にする", () => {
    const reduced = blockAfter(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
    expect(reduced).toMatch(/\.spin[^{]*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.cursor[^{]*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.mark-ring--arc[^{]*\{[^}]*stroke-dasharray/);
  });

  it("回る輪は 1 周 1 秒の線形の回転（rovo-spin）", () => {
    expect(css).toMatch(/\.spin\s*\{[^}]*animation:\s*rovo-spin\s+1s\s+linear\s+infinite/);
    expect(css).toMatch(/@keyframes rovo-spin\s*\{[^}]*rotate\(360deg\)/);
  });

  it("抑制の指定は、抑える側の元の指定より後ろに書く（同じ重みなので、前に書くと効かない）", () => {
    const at = css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    for (const sel of [".spin", ".cursor"]) {
      const base = css.search(new RegExp(`(^|\\n)\\${sel}\\s*\\{`));
      expect(base, `${sel} の元の指定`).toBeGreaterThanOrEqual(0);
      expect(at, `${sel} より後ろ`).toBeGreaterThan(base);
    }
  });
});

describe("工場の断面図の CSS（factory-scene.css。遅延読み込みの別チャンク）", () => {
  const fx = readFileSync(join(SRC, "factory-scene.css"), "utf8");
  const fxDark = blockAfter(fx, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/);
  const fxLight = tokens(blockAfter(fx, /(^|\n):root\s*\{/));
  const fxNight = tokens(blockAfter(fxDark, /:root\s*\{/));

  it("色はトークン（:root の --fx-*）の定義の中だけ。夜の工場は prefers-color-scheme: dark の :root で上書き", () => {
    const HEX_OR_FN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/;
    const stripped = fx
      .replace(fxDark, "")
      .replace(/(^|\n):root\s*\{[^}]*\}/, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const hit = stripped.split("\n").filter((l) => HEX_OR_FN.test(l));
    expect(hit, `直書きの色: ${hit.join(" | ")}`).toEqual([]);
    expect(Object.keys(fxLight).length).toBeGreaterThan(20);
    for (const name of Object.keys(fxLight)) expect(name).toMatch(/^fx-/);
    for (const name of Object.keys(fxNight)) expect(fxLight[name], `--${name}`).toBeDefined();
  });

  it("夜の工場: 空は暗く、窓とランプの明かりは明るい", () => {
    for (const name of ["fx-sky1", "fx-sky2"]) {
      expect(luminance(fxNight[name] as string), name).toBeLessThan(0.05);
      expect(luminance(fxLight[name] as string), name).toBeGreaterThan(0.5);
    }
    for (const name of ["fx-cwin", "fx-gl1", "fx-beam"])
      expect(luminance(fxNight[name] as string), name).toBeGreaterThan(0.4);
  });

  it("使っている --fx-* のトークンはすべて定義がある", () => {
    for (const m of fx.matchAll(/var\(--(fx-[a-z0-9]+)\)/g))
      expect(fxLight[m[1] as string], `--${m[1]}`).toBeDefined();
  });

  it("動き（animation）は prefers-reduced-motion: no-preference の中だけ（reduce ではすべて止まる）", () => {
    const motion = blockAfter(fx, /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/);
    expect(motion).toMatch(/animation:/);
    expect(fx.replace(motion, "")).not.toMatch(/animation(-[a-z]+)?:/);
    expect(fx.replace(motion, "")).not.toMatch(/@keyframes/);
  });
});
