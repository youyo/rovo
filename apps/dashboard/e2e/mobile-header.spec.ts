import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, loginAs, test } from "./fixtures";
import { readState } from "./state";

// モバイル幅（720px 以下）のヘッダーと上部の詰め。ログインは広い幅で済ませてから幅を変える
// （狭い幅では利用者名がアバターに畳まれるので、loginAs の「名前が見える」待ちを使えない）。
const s = readState();

async function settle(page: Page) {
  await expect(page.locator(".console h1, [data-teamboard], nav.rail").first()).toBeVisible();
  // 狭い形への切り替えは matchMedia の通知で描き直してから。描き直しの前に測ると広い形の高さになる
  const width = page.viewportSize()?.width ?? 0;
  if (width <= 720) await expect(page.locator("header button.lang-one")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const width of [360, 390]) {
  test(`(M1) ${width}px: ヘッダーは 2 行（高さ 120px 以下）で横スクロールが出ない。言語は 1 つのボタン`, async ({
    page,
  }) => {
    await loginAs(page, s.users.alice);
    await page.setViewportSize({ width, height: 844 });
    await settle(page);

    const header = page.locator("header.top");
    // 幅を変えた直後は組み替えの途中を測ることがあるので、落ち着くまで測り直す（折り返したままなら待っても落ちる）
    await expect
      .poll(async () => (await header.boundingBox())?.height ?? Number.POSITIVE_INFINITY, {
        message: "ヘッダーの高さ",
      })
      .toBeLessThanOrEqual(120);
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.view);

    // 「Rovo」の文字は見えない形で残る。要約の件数は隠れ、日付は残る
    await expect(header.locator(".brand-name")).toHaveText("Rovo");
    expect((await header.locator(".brand-name").boundingBox())?.width).toBeLessThanOrEqual(1);
    await expect(header.locator(".day-summary > span").first()).toBeVisible();
    await expect(header.locator(".day-summary > span").nth(1)).toBeHidden();

    // 言語: 日本語のときは「EN」1 つ。押すと英語になり、今度は「日本語」
    await expect(header.locator("fieldset.lang")).toBeHidden();
    await header.getByRole("button", { name: "EN" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await header.getByRole("button", { name: "日本語" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  });

  test(`(M2) ${width}px: アバターを開くとログアウトが見えて押せる。ログアウトで未ログインの画面に戻る`, async ({
    page,
  }) => {
    await loginAs(page, s.users.alice);
    await page.setViewportSize({ width, height: 844 });
    await settle(page);

    const avatar = page.locator("header .user-menu summary");
    await expect(avatar).toHaveAttribute("aria-label", s.users.alice.login);
    const out = page.locator("header").getByRole("button", { name: "ログアウト" });
    await expect(out).toBeHidden();
    await avatar.click();
    await expect(out).toBeVisible();
    await expect(page.locator("header .user-menu p")).toContainText(s.users.alice.login);
    await out.click();
    await expect(page.getByRole("link", { name: "GitHub でログイン" })).toBeVisible();
  });

  test(`(M3) ${width}px: タイムラインは 3 時間ごと（520px 以下は 6 時間ごと）の文字だけ。グリッドは毎時`, async ({
    page,
  }) => {
    await loginAs(page, s.users.alice);
    await page.getByRole("button", { name: "チーム" }).click();
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".tlband")).toBeVisible();
    const labels = page.locator(".lbl--axis");
    expect(await labels.count()).toBeGreaterThan(0);
    const visible = await labels.evaluateAll((els) =>
      els.map((el) => ({
        shown: getComputedStyle(el).display !== "none",
        h3: el.hasAttribute("data-h3"),
        h6: el.hasAttribute("data-h6"),
      })),
    );
    for (const l of visible) expect(l.shown).toBe(width <= 520 ? l.h6 : l.h3);
    // 日付の行は隠さない（◀ ▶）
    await expect(page.getByRole("button", { name: "前の日" })).toBeVisible();
  });
}

test("(M4) 1280px: 従来どおりセグメントの言語切り替えと利用者名が見える。タブに件数", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await page.setViewportSize({ width: 1280, height: 800 });
  const header = page.locator("header.top");
  await expect(header.locator("fieldset.lang").getByRole("button", { name: "EN" })).toBeVisible();
  await expect(
    header.locator("fieldset.lang").getByRole("button", { name: "日本語" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    header.locator(".user").getByText(s.users.alice.login, { exact: true }),
  ).toBeVisible();
  await expect(header.locator("details")).toHaveCount(0);
  await expect(header.locator(".brand")).toContainText("Rovo");
  await expect(header.locator(".day-summary > span").nth(1)).toBeVisible();
  // レールのタブ: 「日付別 N」
  await expect(page.locator("fieldset.rail-tabs button").first()).toHaveText(/^日付別 \d+$/);
});

test("(M5) スクリーンショット: 390px と 1280px のマイタスクとチーム", async ({
  page,
}, testInfo) => {
  const dir = process.env.ROVO_SHOTS_DIR ?? testInfo.outputPath("shots");
  mkdirSync(dir, { recursive: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loginAs(page, s.users.alice);
  for (const [width, height] of [
    [390, 844],
    [1280, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.getByRole("button", { name: "マイタスク" }).click();
    await settle(page);
    await page.screenshot({ path: join(dir, `${width}-me.png`), fullPage: true });
    await page.getByRole("button", { name: "チーム" }).click();
    await settle(page);
    await page.screenshot({ path: join(dir, `${width}-team.png`), fullPage: true });
  }
});
