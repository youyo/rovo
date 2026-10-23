import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, LANG_STORAGE_KEY, loginAs, taskPath, test } from "./fixtures";
import { readState } from "./state";

// 表示言語（既定は英語。ブラウザの言語は見ない）。playwright.config は locale: "ja-JP" なので、
// 日本語のブラウザで開いても英語で出ることも確かめられる。最初に日本語を保存する既定のフィクスチャは外す。
test.use({ lang: null });
const s = readState();

const htmlLang = (page: Page) => page.evaluate(() => document.documentElement.lang);
const saved = (page: Page) => page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY);
const switcher = (page: Page) => page.locator("header .lang");

async function settle(page: Page) {
  await expect(page.locator(".console h1")).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("(I1) 初回は英語で出る（ブラウザが日本語でも）。html の lang と title も英語。切り替えは未ログインの画面にも出る", async ({
  page,
}) => {
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { level: 1, name: "Rovo Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  await expect(page.locator("section.login")).toContainText(
    "Sign in to see progress, logs and costs for your tasks and your team's.",
  );
  expect(await htmlLang(page)).toBe("en");
  await expect(page).toHaveTitle("Rovo Dashboard");
  expect(await saved(page)).toBeNull(); // 選ぶまでは何も保存しない
  await expect(switcher(page).getByRole("button", { name: "EN" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(switcher(page).getByRole("button", { name: "日本語" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("(I2) 未ログインで日本語に切り替えると文言・html の lang・title が変わり、読み直しても日本語のまま", async ({
  page,
}) => {
  await page.goto("/dashboard/");
  await switcher(page).getByRole("button", { name: "日本語" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Rovo ダッシュボード" })).toBeVisible();
  await expect(page.getByRole("link", { name: "GitHub でログイン" })).toBeVisible();
  expect(await htmlLang(page)).toBe("ja");
  await expect(page).toHaveTitle("Rovo ダッシュボード");
  expect(await saved(page)).toBe("ja");

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Rovo ダッシュボード" })).toBeVisible();
  expect(await htmlLang(page)).toBe("ja");
  await expect(page).toHaveTitle("Rovo ダッシュボード");

  await switcher(page).getByRole("button", { name: "EN" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Rovo Dashboard" })).toBeVisible();
  expect(await saved(page)).toBe("en");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Rovo Dashboard" })).toBeVisible();
});

test("(I3) ログイン後の画面: 英語で出て、日本語に切り替えると文言が変わり、再読み込み後も日本語のまま。英語へ戻せる", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await settle(page);
  // 英語（既定）
  const scope = page.locator("header fieldset.seg:not(.lang)");
  await expect(scope.getByRole("button", { name: "My tasks" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(scope.getByRole("button", { name: "Team" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Details" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous day" })).toBeVisible();
  expect(await htmlLang(page)).toBe("en");

  // 日本語へ
  await switcher(page).getByRole("button", { name: "日本語" }).click();
  await expect(scope.getByRole("button", { name: "マイタスク" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("navigation", { name: "タスク" })).toBeVisible();
  await expect(page.getByRole("button", { name: "内訳" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
  await expect(page.getByRole("button", { name: "前の日" })).toBeVisible();
  expect(await htmlLang(page)).toBe("ja");
  await expect(page).toHaveTitle("Rovo ダッシュボード");
  expect(await saved(page)).toBe("ja");

  // 再読み込みしても日本語（localStorage）。ログインの Cookie は残っている
  await page.reload();
  await settle(page);
  await expect(page.getByRole("button", { name: "マイタスク" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "タスク" })).toBeVisible();
  expect(await htmlLang(page)).toBe("ja");

  // 英語へ戻す
  await switcher(page).getByRole("button", { name: "EN" }).click();
  await expect(page.getByRole("button", { name: "My tasks" })).toBeVisible();
  expect(await htmlLang(page)).toBe("en");
  await page.reload();
  await settle(page);
  await expect(page.getByRole("button", { name: "My tasks" })).toBeVisible();
});

test("(I4) 英語でも子やユーザーのデータは訳さず、状態は英語の語で出る。日付・金額は英語の書式", async ({
  page,
}) => {
  await loginAs(page, s.users.alice, taskPath(s.tasks.done as string));
  await settle(page);
  const head = page.locator(".console .con-head");
  await expect(head).toContainText("Status");
  await expect(head).toContainText("Repository");
  await expect(head).toContainText("Cost");
  await expect(head).not.toContainText("状態");
  // 金額は $ と小数点
  await expect(head.locator(".meta-item", { hasText: "Cost" })).toContainText(/\$\d/);
  // 日付の見出し（10月23日 ではなく October 23 の形）
  await page.goto("/dashboard/");
  await settle(page);
  await expect(page.locator(".day-summary")).toContainText(/^[A-Z][a-z]+ \d{1,2}\s/);
  await expect(page.locator(".day-summary")).not.toContainText("月");
});

test("(I5) スクリーンショット（ライト）: 英語のタスク画面・英語のログイン画面・日本語のタスク画面", async ({
  page,
}, testInfo) => {
  const dir = process.env.ROVO_SHOTS_DIR ?? testInfo.outputPath("shots");
  mkdirSync(dir, { recursive: true });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });

  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { level: 1, name: "Rovo Dashboard" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(dir, "i18n-en-login.png"), fullPage: true });

  await loginAs(page, s.users.alice, taskPath(s.tasks.done as string));
  await settle(page);
  await page.screenshot({ path: join(dir, "i18n-en-task.png"), fullPage: true });

  await switcher(page).getByRole("button", { name: "日本語" }).click();
  await expect(page.getByRole("button", { name: "マイタスク" })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: join(dir, "i18n-ja-task.png"), fullPage: true });
});
