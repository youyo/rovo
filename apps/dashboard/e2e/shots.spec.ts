import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, loginAs, taskPath, test } from "./fixtures";
import { readState } from "./state";

// 見た目の確認用のスクリーンショット（ダーク・ライト × 一覧・詳細、スマホ幅の一覧）。
// 保存先は環境変数 ROVO_SHOTS_DIR（無ければ test-results の下）。画像の中身は比較しない。
const s = readState();

async function settle(page: Page) {
  await expect(page.locator(".console h1")).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const scheme of ["light", "dark"] as const) {
  test(`(22) スクリーンショット: ${scheme} の一覧・詳細・スマホ幅の一覧`, async ({
    page,
  }, testInfo) => {
    const dir = process.env.ROVO_SHOTS_DIR ?? testInfo.outputPath("shots");
    mkdirSync(dir, { recursive: true });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });

    await loginAs(page, s.users.alice);
    await settle(page);
    await page.screenshot({ path: join(dir, `${scheme}-overview.png`), fullPage: true });

    await page.goto(taskPath(s.tasks.done as string));
    await settle(page);
    await page.screenshot({ path: join(dir, `${scheme}-detail.png`), fullPage: true });

    // 幅 1,200px の詳細（ステータスバーが 1 行に収まる幅）
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(taskPath(s.tasks.done as string));
    await settle(page);
    await page.screenshot({ path: join(dir, `${scheme}-detail-1200.png`), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard/");
    // 狭い幅の一覧はレールだけ（詳細は出ない）
    await expect(page.locator("nav.rail")).toBeVisible();
    await expect(page.locator(".statusbar")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(dir, `${scheme}-mobile-overview.png`), fullPage: true });

    // 引き出しを開いた状態（内訳）
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "内訳" }).click();
    await expect(page.locator(".drawer")).toBeVisible();
    await page.screenshot({ path: join(dir, `${scheme}-drawer.png`), fullPage: true });
  });
}
