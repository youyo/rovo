import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, taskPath, test } from "./fixtures";
import { readState } from "./state";

// 未ログインの画面（ログインのカード）。実ブラウザで、未ログインの開き方・ログイン失敗からの戻り・狭い幅を確かめる。
const s = readState();
const LOGIN = "/dashboard/auth/login";

async function settle(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: "Rovo ダッシュボード" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("(LG1) 未ログインで開くと、ロゴ・見出し・説明・ボタンのログイン画面が出る。ヘッダにログインのリンクは重複しない", async ({
  page,
}) => {
  await page.goto("/dashboard/");
  await settle(page);
  const logo = page.locator("section.login img.brand-mark");
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute("src", "/dashboard/assets/brand/rovo-mark.svg");
  // 画像が実際に読めている（壊れた画像ではない）
  expect(await logo.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator("section.login")).toContainText(
    "自分とチームのタスクの進み具合・ログ・費用",
  );
  await expect(page.locator("section.login")).toContainText(
    "許可された GitHub のアカウント・組織だけがログインできます。",
  );
  const links = page.getByRole("link", { name: "GitHub でログイン" });
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute("href", LOGIN);
  await expect(page.locator("header a")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("(LG2) タスク詳細の URL で開くと説明が変わり、ボタンの href に return_to が付く", async ({
  page,
}) => {
  const path = taskPath(s.tasks.done as string);
  await page.goto(path);
  await settle(page);
  await expect(page.locator("section.login")).toContainText(
    "ログインすると、このタスクの詳細を見られます。",
  );
  await expect(page.getByRole("link", { name: "GitHub でログイン" })).toHaveAttribute(
    "href",
    `${LOGIN}?return_to=${encodeURIComponent(path)}`,
  );
});

test("(LG3) ?login_error=denied で文が出て、URL からクエリが消える。未知の値は何も出さずクエリだけ消える", async ({
  page,
}) => {
  await page.goto("/dashboard/?login_error=denied");
  await settle(page);
  await expect(page.getByRole("alert")).toHaveText(
    "このアカウントはログインを許可されていません。管理者に確認してください。",
  );
  await expect.poll(() => new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).pathname).toBe("/dashboard/");

  await page.goto("/dashboard/?login_error=%3Cb%3Eevil%3C%2Fb%3E");
  await settle(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("evil");
  await expect.poll(() => new URL(page.url()).search).toBe("");
});

test("(LG4) 3 種の login_error（invalid・unavailable）の文", async ({ page }) => {
  await page.goto("/dashboard/?login_error=invalid");
  await expect(page.getByRole("alert")).toHaveText(
    "ログインの手順が途中で切れました。もう一度ログインしてください。",
  );
  await page.goto("/dashboard/?login_error=unavailable");
  await expect(page.getByRole("alert")).toHaveText(
    "GitHub に接続できませんでした。少し待ってからもう一度お試しください。",
  );
});

test("(LG5) /me を確認できないときは「確認できませんでした」＋再読み込み＋ログインのボタン。再読み込みで /me を取り直す", async ({
  page,
}) => {
  let fail = true;
  let calls = 0;
  await page.route("**/dashboard/api/me", async (route) => {
    calls += 1;
    if (fail) await route.fulfill({ status: 503, body: "{}" });
    else await route.continue();
  });
  await page.goto("/dashboard/");
  await expect(page.getByRole("alert")).toContainText("ログインの状態を確認できませんでした。");
  await expect(page.getByRole("link", { name: "GitHub でログイン" })).toHaveAttribute(
    "href",
    LOGIN,
  );
  fail = false;
  const before = calls;
  await page.getByRole("button", { name: "再読み込み" }).click();
  // 取り直して未ログイン（401）の画面になる
  await settle(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => calls).toBeGreaterThan(before);
});

test("(LG6) キーボードは、ヘッダの言語の切り替え（2 つ）の次にログインのボタンへ着き、フォーカスの輪が見える", async ({
  page,
}) => {
  await page.goto("/dashboard/");
  await settle(page);
  // 先頭はヘッダの言語の切り替え（EN・日本語）。その次がログインのボタン
  await page.keyboard.press("Tab");
  await expect(page.locator("header .lang button").first()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("header .lang button").nth(1)).toBeFocused();
  await page.keyboard.press("Tab");
  const link = page.getByRole("link", { name: "GitHub でログイン" });
  await expect(link).toBeFocused();
  const outline = await link.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: Number.parseFloat(cs.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThan(0);
});

test("(LG7) 360px 幅で横スクロールが出ない（通常・login_error 付き・確認できない状態）", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const noOverflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
  await page.goto("/dashboard/");
  await settle(page);
  expect(await noOverflow()).toBe(true);
  await page.goto(`${taskPath(s.tasks.done as string)}?login_error=unavailable`);
  await settle(page);
  expect(await noOverflow()).toBe(true);
  await page.route("**/dashboard/api/me", (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.goto("/dashboard/?login_error=denied");
  await expect(page.getByRole("button", { name: "再読み込み" })).toBeVisible();
  expect(await noOverflow()).toBe(true);
});

for (const scheme of ["light", "dark"] as const) {
  for (const [label, size] of [
    ["desktop", { width: 1280, height: 800 }],
    ["360", { width: 360, height: 740 }],
  ] as const) {
    test(`(LG8) スクリーンショット: ${scheme} ${label} のログイン画面`, async ({
      page,
    }, testInfo) => {
      const dir = process.env.ROVO_SHOTS_DIR ?? testInfo.outputPath("shots");
      mkdirSync(dir, { recursive: true });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.setViewportSize(size);
      await page.goto("/dashboard/?login_error=denied");
      await settle(page);
      await expect(page.getByRole("alert")).toBeVisible();
      await page.screenshot({ path: join(dir, `login-${scheme}-${label}.png`), fullPage: true });
    });
  }
}
