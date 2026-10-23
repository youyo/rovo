import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, loginAs, taskPath, test } from "./fixtures";
import { readState } from "./state";

// README 用のスクリーンショット（英語の表示、幅 1280、Light / Dark）。
// 実行は mise run docs:screenshots。保存先は docs/assets/screenshots/（ROVO_DOCS_SHOTS_DIR で変えられる）。
// データは撮影専用の架空のもの（docs-global-setup.ts）。画像の中身は比較しない。
test.use({ lang: "en" });
const s = readState();

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.ROVO_DOCS_SHOTS_DIR ?? resolve(here, "../../../docs/assets/screenshots");

async function settle(page: Page) {
  await expect(page.locator(".console h1")).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const scheme of ["light", "dark"] as const) {
  test(`README: dashboard task view (${scheme})`, async ({ page }) => {
    mkdirSync(outDir, { recursive: true });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await loginAs(page, s.users.alice, taskPath(s.tasks.running as string));
    await settle(page);
    // 台本のイベントと終端の取り込みは非同期なので、揃うまで開き直す（走行中は 1 件、手順は 5 件以上）
    await expect(async () => {
      await page.reload();
      await settle(page);
      await expect(page.locator(".day-summary")).toContainText("Running 1");
      expect(await page.locator("ol.steps li.step").count()).toBeGreaterThanOrEqual(5);
    }).toPass({ timeout: 60_000 });
    await page.screenshot({ path: join(outDir, `dashboard-${scheme}.png`) });
  });
}
