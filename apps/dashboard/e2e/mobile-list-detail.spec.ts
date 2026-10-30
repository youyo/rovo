import type { Page } from "@playwright/test";
import { expect, loginAs, rail, test } from "./fixtures";
import { readState } from "./state";

// モバイル幅（720px 以下）の一覧と詳細の切り替え。ログインは広い幅で済ませてから幅を変える。
const s = readState();
const id = (k: string) => s.tasks[k] as string;

async function narrow(page: Page, width = 390) {
  await page.setViewportSize({ width, height: 844 });
  // 狭い形への切り替えは matchMedia の通知で描き直してから。描き直しの前に見ると広い形のまま
  await expect(page.locator("header button.lang-one")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("(L1) 390px: 一覧（/dashboard）はレールだけで、詳細は出ない。レールの高さは絞らない", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await narrow(page);
  await expect(page.locator("nav.rail")).toBeVisible();
  await expect(page.locator(".console")).toHaveCount(0);
  await expect(page.locator("button.back-to-list")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/dashboard/");
  // 一覧だけの画面は、レールの高さを 240px に絞らずページのスクロールに任せる
  await expect(page.locator("nav.rail")).toHaveCSS("max-height", "none");
});

test("(L2) 390px: 行を押すと詳細だけになり「← 一覧」がある。押すと一覧に戻り、履歴は積まれない。戻るでも一覧", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await narrow(page);
  await rail(page, id("running")).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/tasks/${id("running")}`));
  await expect(page.locator(".console h1")).toBeVisible();
  await expect(page.locator("nav.rail")).toHaveCount(0);
  // 詳細だけの画面は帯（工場の 1 行もタイムラインも）を出さない
  await expect(page.locator(".tlband, section[data-factory]")).toHaveCount(0);
  const back = page.getByRole("button", { name: "← 一覧" });
  await expect(back).toBeVisible();
  const lengthWithDetail = await page.evaluate(() => history.length);

  // 「← 一覧」で一覧に戻る。履歴は [一覧, 詳細, 一覧] にならない（ブラウザの戻るで詳細に戻らない）
  await back.click();
  await expect(page.locator("nav.rail")).toBeVisible();
  await expect(page.locator(".console")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/dashboard/");
  expect(
    await page.evaluate(() => (history.state as { from?: string } | null)?.from),
  ).toBeUndefined();
  // 直前に開いていた行が見える位置にあって focus されている
  await expect(rail(page, id("running"))).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(lengthWithDetail);
  // 進むで詳細に戻れる（履歴は一覧と詳細の 2 つのまま）
  await page.goForward();
  await expect(page.locator(".console h1")).toBeVisible();
});

test("(L2b) 390px: 詳細の URL を直接開いたときの「← 一覧」は一覧へ移り、ブラウザの戻るで詳細に戻れる", async ({
  page,
}) => {
  await loginAs(page, s.users.alice, `/dashboard/tasks/${id("running")}`);
  await narrow(page);
  await page.getByRole("button", { name: "← 一覧" }).click();
  await expect(page.locator("nav.rail")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/dashboard/");
  await page.goBack();
  await expect(page.locator(".console h1")).toBeVisible();
});

test("(L3) 390px: 狭い幅のレールの所要時間は短い表記（M:SS / N s）", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await narrow(page);
  const times = await page.locator("a.rail-row .rail-time").allTextContents();
  expect(times.length).toBeGreaterThan(0);
  for (const t of times) expect(t).toMatch(/^(\d+s|\d+:\d{2}(:\d{2})?)$/);
});

test("(L4) 1280px: 従来どおり一覧と詳細が並ぶ。「← 一覧」は無い", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("nav.rail")).toBeVisible();
  await expect(page.locator(".console h1")).toBeVisible();
  await expect(page.locator("button.back-to-list")).toHaveCount(0);
  await rail(page, id("running")).click();
  await expect(page.locator("nav.rail")).toBeVisible();
  await expect(page.locator(".console h1")).toBeVisible();
  await expect(page.locator("button.back-to-list")).toHaveCount(0);
});

const overflowOf = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));

test("(L5) 390px: 詳細の工程の段は 4 つとも見え、補足の文字は出ず、横にはみ出さない", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await narrow(page);
  await rail(page, id("running")).click();
  await expect(page.locator(".console h1")).toBeVisible();
  const jobs = page.locator("[data-band] .job");
  await expect(jobs).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(jobs.nth(i)).toBeVisible();
    await expect(jobs.nth(i).locator("small")).toBeHidden();
    const box = await jobs.nth(i).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  }
  const band = await overflowOf(page, "[data-band]");
  expect(band.sw).toBeLessThanOrEqual(band.cw);
  const doc = await overflowOf(page, "html");
  expect(doc.sw).toBeLessThanOrEqual(doc.cw);
});

test("(L6) 390px: チームの一覧もレールの高さを絞らず、ボードが一覧の下にある", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await narrow(page);
  await page.getByRole("button", { name: "チーム", exact: true }).click();
  const board = page.locator("[data-teamboard]");
  await expect(board).toBeVisible();
  await expect(page.locator("nav.rail")).toHaveCSS("max-height", "none");
  const r = await page.locator("nav.rail").boundingBox();
  const b = await board.boundingBox();
  expect(r && b && b.y >= r.y + r.height - 1).toBe(true);
});

test("(L7) 1280px: 工程の段は従来どおり補足の文字が出る", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".console h1")).toBeVisible();
  const smalls = page.locator("[data-band] .job small");
  await expect(smalls).toHaveCount(4);
  for (let i = 0; i < 4; i++) await expect(smalls.nth(i)).toBeVisible();
});
