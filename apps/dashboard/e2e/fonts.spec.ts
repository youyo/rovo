import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, loginAs, taskPath, test } from "./fixtures";
import { readState } from "./state";

const s = readState();

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
  await expect(page.locator(`tr[data-task-id="${s.tasks.done}"]`)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const firstPaintFonts = fonts.map((f) => ({ ...f }));
  // 詳細（出力の枠は JetBrains Mono）
  await page.goto(taskPath(s.tasks.done as string));
  await expect(page.locator("pre.output")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const loaded = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => f.family.replace(/["']/g, "")),
  );
  for (const family of ["Familjen Grotesk", "Zen Kaku Gothic New", "JetBrains Mono"]) {
    expect(loaded, `${family} が読み込まれていない`).toContain(family);
  }

  expect(fonts.length).toBeGreaterThan(0);
  const origin = new URL(s.baseUrl).origin;
  for (const f of fonts) {
    expect(f.url.startsWith(`${origin}/dashboard/assets/`), f.url).toBe(true);
    expect(f.type, f.url).toMatch(/font\/woff2|application\/(font-woff2|octet-stream)/);
    expect(f.bytes, f.url).toBeGreaterThan(1000);
  }
  // unicode-range の分割: 全部は読まない（dist には 370 個ほどある。使う文字を含む分割だけ読む）
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
