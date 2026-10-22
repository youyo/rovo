import type { Page } from "@playwright/test";
import { expect, loginAs, rail, taskPath, test } from "./fixtures";
import { readState } from "./state";

const s = readState();

// 詳細（/tasks/<id>）だけに一致する。events（/tasks/<id>/events）には一致しない
const DETAIL = /\/dashboard\/api\/tasks\/[^/?]+(\?.*)?$/;

const navCount = (page: Page) =>
  page.evaluate(() => performance.getEntriesByType("navigation").length);
const marker = (page: Page) =>
  page.evaluate(() => (window as unknown as { __marker?: number }).__marker);
// 読み直すと消える目印
const setMarker = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __marker: number }).__marker = 1;
  });

test("(sw-1) レールで別のタスクを押すと、ページを読み直さず URL・選択・コンソールが変わる。戻る・進むで追従する", async ({
  page,
}) => {
  const done = s.tasks.done as string;
  const failed = s.tasks.failed as string;
  await loginAs(page, s.users.alice);
  await page.getByRole("button", { name: "全員" }).click();
  await setMarker(page);
  const before = await navCount(page);

  await rail(page, done).click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(done)}$`));
  await expect(rail(page, done)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();

  await rail(page, failed).click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(failed)}$`));
  await expect(rail(page, failed)).toHaveAttribute("aria-current", "true");
  await expect(rail(page, done)).not.toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { level: 1, name: "失敗したタスク" })).toBeVisible();

  // ページは読み直されていない
  expect(await navCount(page)).toBe(before);
  expect(await marker(page)).toBe(1);

  // ブラウザの戻るで前のタスクに戻り、進むで元に戻る
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${taskPath(done)}$`));
  await expect(rail(page, done)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`${taskPath(failed)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "失敗したタスク" })).toBeVisible();
  expect(await marker(page)).toBe(1);
});

test("(sw-2) タイムラインの棒でも、ページを読み直さずに切り替わる", async ({ page }) => {
  const done = s.tasks.done as string;
  await loginAs(page, s.users.alice);
  await page.getByRole("button", { name: "全員" }).click();
  await setMarker(page);
  await page.locator(`a[data-task="${done}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(done)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  expect(await marker(page)).toBe(1);
});

test("(sw-3) ?fresh=1 は、URL を直接開いたときの最初の取得だけ。画面の中での切り替えと戻るには付かない", async ({
  page,
}) => {
  const done = s.tasks.done as string;
  const failed = s.tasks.failed as string;
  const urls: string[] = [];
  page.on("request", (req) => {
    if (DETAIL.test(req.url())) {
      const u = new URL(req.url());
      urls.push(`${u.pathname.split("/").pop()}${u.search}`);
    }
  });
  await loginAs(page, s.users.alice, taskPath(done));
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  expect(urls[0]).toBe(`${done}?fresh=1`);

  await page.getByRole("button", { name: "全員" }).click();
  urls.length = 0;
  await rail(page, failed).click();
  await expect(page.getByRole("heading", { level: 1, name: "失敗したタスク" })).toBeVisible();
  expect(urls.length).toBeGreaterThanOrEqual(1);
  expect(urls.every((u) => u === failed)).toBe(true);

  urls.length = 0;
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  expect(urls.length).toBeGreaterThanOrEqual(1);
  expect(urls.every((u) => u === done)).toBe(true);
});

test("(sw-4) 修飾キー付きのクリックは同じタブで切り替えず、新しいタブで開く", async ({
  page,
  context,
}) => {
  const done = s.tasks.done as string;
  await loginAs(page, s.users.alice);
  await page.getByRole("button", { name: "全員" }).click();
  const url = page.url();
  const popup = context.waitForEvent("page");
  await rail(page, done).click({ modifiers: ["ControlOrMeta"] });
  const tab = await popup;
  await expect(tab).toHaveURL(new RegExp(`${taskPath(done)}$`));
  expect(page.url()).toBe(url);
  await tab.close();
});
