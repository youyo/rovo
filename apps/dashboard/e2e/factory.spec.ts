import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, loginAs, rail, taskPath, test } from "./fixtures";
import { readState } from "./state";

// 今日の一覧の帯「Rovo の工場」（docs/specs/dashboard-factory.md）。断面図は遅延読み込みの別チャンク。
const s = readState();
const id = (k: string) => s.tasks[k] as string;
const band = (page: Page) => page.locator("section[data-factory]");
const rovo = (page: Page, taskId: string) =>
  page.locator(`section[data-factory] a[data-task="${taskId}"]`);

/** CSP の違反を記録する（securitypolicyviolation とコンソールの報告） */
async function watchCsp(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) seen.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return seen;
}

test("(F1) 今日は工場の帯。自分の Rovo が部屋にいて、押すとそのタスクが選ばれる。CSP の違反は出ない", async ({
  page,
}) => {
  const csp = await watchCsp(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginAs(page, s.users.alice);
  await expect(band(page)).toBeVisible();
  // マイタスク（既定）でも工場を出す。タイムラインの帯は出さない
  await expect(page.locator(".tlband")).toHaveCount(0);
  const running = rovo(page, id("running"));
  await expect(running).toBeVisible();
  await expect(running).toHaveAttribute("data-room", /^(prep|code)$/);
  // 失敗したタスクは工場に入らない
  await expect(rovo(page, id("failed"))).toHaveCount(0);
  // 断面図の CSS は別ファイルで読まれ、断面図の高さは上限の 300px（背の高い画面）
  const box = await page.locator(".fx-stage").boundingBox();
  expect(box?.height).toBe(300);
  const fxCss = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href")),
  );
  expect(fxCss.some((h) => /\/dashboard\/assets\/factory-scene-.+\.css$/.test(h ?? ""))).toBe(true);
  // 押すとそのタスクを選ぶ（ページを読み直さない）
  // Rovo は待機の動作で動き続けるので、動かない当たり判定（.fx-hit）を押す
  await running.locator(".fx-hit").click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(id("running"))}$`));
  await expect(page.getByRole("heading", { level: 1, name: "実行中のタスク" })).toBeVisible();
  await expect(rail(page, id("running"))).toHaveAttribute("aria-current", "true");
  expect(csp).toEqual([]);
});

test("(F2) 過去の日は今のタイムラインの帯（チームのとき）。工場は出さない", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await expect(band(page)).toBeVisible();
  await page.getByRole("button", { name: "チーム" }).click();
  await page.getByRole("button", { name: "前の日" }).click();
  await expect(page).toHaveURL(/\?day=\d{4}-\d{2}-\d{2}$/);
  await expect(page.locator(".tlband")).toHaveAttribute("aria-label", "この日のタイムライン");
  await expect(band(page)).toHaveCount(0);
  await page.getByRole("button", { name: "今日へ" }).click();
  await expect(band(page)).toBeVisible();
  await expect(page.locator(".tlband")).toHaveCount(0);
});

test("(F3) たたむと部屋ごとの人数の 1 行になり、リロードしても保たれる", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await expect(page.locator(".fx-stage svg.fx-svg")).toBeVisible();
  const toggle = page.locator("button[data-factory-toggle]");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const summary = page.locator("[data-factory-summary]");
  await expect(summary).toBeVisible();
  await expect(page.locator(".fx-stage")).toHaveCount(0);
  // 1 行（帯の高さが低い）
  const h = (await band(page).boundingBox())?.height ?? 0;
  expect(h).toBeLessThan(60);
  const code = Number(await summary.locator('[data-room="code"]').getAttribute("data-n"));
  const prep = Number(await summary.locator('[data-room="prep"]').getAttribute("data-n"));
  expect(code + prep).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator("[data-factory-summary]")).toBeVisible();
  await expect(page.locator(".fx-stage")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.locator(".fx-stage svg.fx-svg")).toBeVisible();
});

test("(F4) 狭い幅（390px）は断面図を出さず、人数の 1 行の簡略版", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, s.users.alice);
  await expect(page.locator("[data-factory-summary]")).toBeVisible();
  await expect(page.locator("button[data-factory-toggle]")).toHaveCount(0);
  await expect(page.locator(".fx-stage")).toHaveCount(0);
  // 横スクロールが出ない
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("(F5) 見えないタスクは工場に入らず、DOM にも出ない。件数だけ", async ({ page }) => {
  await loginAs(page, s.users.bob);
  await page.getByRole("button", { name: "チーム" }).click();
  // 見えるタスクの Rovo は出ている（検査が空振りしない。準備の部屋は定員を超えるので +n のタイルもある）
  await expect(rovo(page, id("running"))).toBeVisible();
  await expect(band(page).locator("[data-factory-more]")).toBeVisible();
  const html = await band(page).innerHTML();
  for (const k of ["secret", "carol"]) expect(html, k).not.toContain(id(k));
  expect(html).not.toContain(s.marks.secretTitle);
  expect(html).not.toContain(s.users.carol.login);
  await expect(band(page).locator("[data-factory-hidden]")).toBeVisible();
});

test("(F6) prefers-reduced-motion では工場の動きが止まる（ふだんは動く）", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await expect(page.locator(".fx-stage svg.fx-svg")).toBeVisible();
  const running = () =>
    page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest?.(".fx-stage"))
          .length,
    );
  await expect.poll(running).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(running).toBe(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`(F7) スクリーンショット: ${scheme} の工場の帯（チーム）`, async ({ page }, testInfo) => {
    const dir = process.env.ROVO_SHOTS_DIR ?? testInfo.outputPath("shots");
    mkdirSync(dir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await loginAs(page, s.users.alice);
    await page.getByRole("button", { name: "チーム" }).click();
    await expect(rovo(page, id("running"))).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await band(page).screenshot({ path: join(dir, `${scheme}-factory.png`) });
    await page.screenshot({ path: join(dir, `${scheme}-factory-page.png`) });
  });
}
