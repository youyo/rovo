import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, loginAs, rail, taskPath, test } from "./fixtures";
import { readState } from "./state";

const s = readState();

const FAMILIES = ["IBM Plex Sans JP", "JetBrains Mono"];

/** 必要な書体（本文 IBM Plex Sans JP・ログ JetBrains Mono の 400 / 700）が読み込み済みになるまで待つ。読み込みの途中で次のページへ移らないため */
async function waitFontsLoaded(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      [
        '400 1em "IBM Plex Sans JP"',
        '700 1em "IBM Plex Sans JP"',
        '400 1em "JetBrains Mono"',
        '700 1em "JetBrains Mono"',
      ].map((f) => document.fonts.load(f, "Aa")),
    );
    await document.fonts.ready;
  });
  for (const f of [
    '400 1em "IBM Plex Sans JP"',
    '700 1em "IBM Plex Sans JP"',
    '400 1em "JetBrains Mono"',
    '700 1em "JetBrains Mono"',
  ]) {
    expect(await page.evaluate((x) => document.fonts.check(x, "Aa"), f), f).toBe(true);
  }
}

type Woff = { url: string; bytes: number; type: string };

test("(11) 書体は同梱のものが同一オリジンから読まれ、外部ホストへの要求は 0 件", async ({
  page,
  net,
}, testInfo) => {
  const fonts: Woff[] = [];
  page.on("response", async (res) => {
    if (!res.url().endsWith(".woff2")) return;
    const body = await res.body().catch(() => Buffer.alloc(0));
    fonts.push({
      url: res.url(),
      bytes: body.length,
      type: res.headers()["content-type"] ?? "",
    });
  });

  await loginAs(page, s.users.alice);
  await expect(rail(page, s.tasks.done as string)).toBeVisible();
  // コンソールとステータスバーまで描き終えてから待つ（これらが使う書体の読み込みを、次の移動で中断しない）
  await expect(page.locator(".console h1")).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();
  await waitFontsLoaded(page);
  const firstPaintFonts = fonts.map((f) => ({ ...f }));
  // 詳細（画面の出力）
  await page.goto(taskPath(s.tasks.done as string));
  await expect(page.locator("pre.output")).toBeVisible();
  await waitFontsLoaded(page);

  const loaded = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => f.family.replace(/["']/g, "")),
  );
  for (const family of FAMILIES) {
    expect(loaded, `${family} が読み込まれていない`).toContain(family);
  }

  expect(fonts.length).toBeGreaterThan(0);
  const origin = new URL(s.baseUrl).origin;
  for (const f of fonts) {
    expect(f.url.startsWith(`${origin}/dashboard/assets/`), f.url).toBe(true);
    expect(f.type, f.url).toMatch(/font\/woff2|application\/(font-woff2|octet-stream)/);
    expect(f.bytes, f.url).toBeGreaterThan(1000);
  }
  // 書体は本文の IBM Plex Sans JP とログの JetBrains Mono だけ（旧い書体は読まない）
  expect(loaded.filter((f) => !FAMILIES.includes(f))).toEqual([]);
  // unicode-range の分割: 全部は読まない（dist には 200 個ほどある。使う文字を含む分割だけ読む）
  const bundled = readdirSync(join(import.meta.dirname, "..", "dist", "assets")).filter((f) =>
    f.endsWith(".woff2"),
  ).length;
  expect(fonts.length).toBeLessThan(bundled / 2);

  expect(net.external, "外部ホストへの要求").toEqual([]);
  for (const u of net.urls) {
    expect(new URL(u).hostname, u).toBe("127.0.0.1");
  }
  expect(net.urls.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u))).toBe(false);

  const sum = (list: Woff[]) => list.reduce((n, f) => n + f.bytes, 0);
  testInfo.annotations.push({
    type: "font-bytes",
    description: `最初の一覧で ${firstPaintFonts.length} ファイル ${sum(firstPaintFonts)} バイト、詳細まで含めて ${fonts.length} ファイル ${sum(fonts)} バイト`,
  });
  console.log(
    `[fonts] 最初の一覧: ${firstPaintFonts.length} ファイル ${sum(firstPaintFonts)} バイト / 詳細まで: ${fonts.length} ファイル ${sum(fonts)} バイト`,
  );
});
