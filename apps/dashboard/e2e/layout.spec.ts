import type { Page } from "@playwright/test";
import { expect, loginAs, taskPath, test } from "./fixtures";
import { LONG_STEPS, readState } from "./state";

// ワークスペースの高さ（制御卓: 広い画面はビューポートいっぱい、スマホ幅は縦に積んでページがスクロール）。
const s = readState();
const id = (k: string) => s.tasks[k] as string;

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} の位置が取れない`);
  return b;
};

/** 台本のイベントの取り込みは非同期なので、手順が揃うまで開き直す */
async function waitSteps(page: Page) {
  const steps = page.locator("ol.steps li.step");
  await expect(async () => {
    await page.reload();
    await expect(steps.first()).toBeVisible();
    expect(await steps.count()).toBeGreaterThanOrEqual(LONG_STEPS);
  }).toPass({ timeout: 60_000 });
}

test("(23) 背の高い画面: ステータスバーがビューポートの下端、レールとコンソールが残りの高さを埋め、画面だけがスクロールする", async ({
  page,
}) => {
  await loginAs(page, s.users.alice, taskPath(id("long")));
  for (const height of [1000, 1400]) {
    await page.setViewportSize({ width: 1280, height });
    await page.goto(taskPath(id("long")));
    await waitSteps(page);
    const bar = await box(page, ".statusbar");
    const consoleBox = await box(page, ".console");
    const railBox = await box(page, "nav.rail");
    // 下に大きな空きが無い（下の余白を除いて下端）
    expect(bar.y + bar.height, `高さ ${height}`).toBeGreaterThanOrEqual(height - 40);
    expect(bar.y + bar.height).toBeLessThanOrEqual(height);
    // コンソールとレールはステータスバーの手前まで埋める
    expect(consoleBox.y + consoleBox.height).toBeGreaterThanOrEqual(bar.y - 24);
    expect(railBox.y + railBox.height).toBeGreaterThanOrEqual(bar.y - 24);
    // ページ全体はスクロールしない。スクロールするのは画面（screen）だけ
    const doc = await page.evaluate(() => ({
      doc: document.documentElement.scrollHeight,
      view: window.innerHeight,
    }));
    expect(doc.doc).toBeLessThanOrEqual(doc.view);
    const screen = await page.locator(".screen").evaluate((el) => ({
      h: el.scrollHeight,
      c: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(screen.overflowY).toMatch(/auto|scroll/);
    // 画面は残りの高さを埋める（中身が短くても縮まない）。1000px の高さでは中身があふれて内部でスクロールする
    expect(screen.c).toBeGreaterThan(height === 1000 ? 400 : 700);
    if (height === 1000) expect(screen.h).toBeGreaterThan(screen.c);
    expect(await page.locator("nav.rail").evaluate((el) => getComputedStyle(el).overflowY)).toMatch(
      /auto|scroll/,
    );
  }
});

test("(24) スマホ幅では縦に積み、高さを固定せずページ全体がスクロールする", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await loginAs(page, s.users.alice, taskPath(id("long")));
  await expect(page.locator(".screen")).toBeVisible();
  const doc = await page.evaluate(() => ({
    doc: document.documentElement.scrollHeight,
    view: window.innerHeight,
  }));
  expect(doc.doc).toBeGreaterThan(doc.view);
  const railBox = await box(page, "nav.rail");
  const consoleBox = await box(page, ".console");
  expect(railBox.y + railBox.height).toBeLessThanOrEqual(consoleBox.y + 1);
  expect((await box(page, ".screen")).height).toBeGreaterThan(250);
});
