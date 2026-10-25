import { expect, loginAs, rail, taskPath, test } from "./fixtures";
import { readState } from "./state";

const s = readState();

// 詳細（/tasks/<id>）だけに一致する。events（/tasks/<id>/events）には一致しない
const DETAIL = /\/dashboard\/api\/tasks\/[^/?]+(\?.*)?$/;
const CLOUDFLARE = /\/dashboard\/api\/cloudflare/;

/** 解放するまで応答を返さない（実サーバーへの要求を止めておく）。遅い応答の再現 */
async function hold(page: import("@playwright/test").Page, match: RegExp) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(match, async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  return release;
}

test("(L1) 詳細の応答が遅くても、一覧（レール・帯・ステータスバー）が先に出て、コンソールの場所だけ読み込み中。チームのボードは詳細を待たない", async ({
  page,
}) => {
  const release = await hold(page, DETAIL);
  await loginAs(page, s.users.alice);
  await expect(rail(page, s.tasks.done as string)).toBeVisible();
  // マイタスク: 詳細が遅いと、コンソールの場所だけ読み込み中（詳細が届くまでは、一覧の行の情報だけの見出し = preview）
  await expect(page.locator(".console-col")).toContainText("読み込み中");
  await expect(page.locator(".console[data-preview]")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".console[data-preview] h1")).toBeVisible();
  await expect(page.locator(".console .now-line")).toHaveCount(0);
  // マイタスクでは時刻の帯を出さない。チームに切り替えると、詳細が遅いままでも帯とボードが先に出る
  await expect(page.locator(".tlband")).toHaveCount(0);
  await page.getByRole("button", { name: "チーム" }).click();
  await expect(page.locator(".tlband .tl-scroll").first()).toBeVisible();
  await expect(page.locator(".statusbar [data-sb='budget-me']")).toContainText("今月");
  await expect(page.locator("[data-teamboard]")).toBeVisible();
  await expect(page.locator(".console-col")).not.toContainText("読み込み中");
  // レールで選ぶと、その詳細が届くまでコンソールの場所だけ読み込み中（preview の見出し）
  await rail(page, s.tasks.running as string).click();
  await expect(page.locator(".console-col")).toContainText("読み込み中");
  await expect(page.locator(".console[data-preview]")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".console[data-preview] h1")).toBeVisible();
  await expect(page.locator(".console .now-line")).toHaveCount(0);
  release();
  await expect(page.locator(".console .now-line")).toBeVisible();
  await expect(page.locator(".console[data-preview]")).toHaveCount(0);
});

test("(L2) Cloudflare の応答が遅くても、一覧とコンソールが先に出て、バーの Cloudflare の場所だけ読み込み中", async ({
  page,
}) => {
  const release = await hold(page, CLOUDFLARE);
  await loginAs(page, s.users.alice);
  await expect(rail(page, s.tasks.done as string)).toBeVisible();
  await expect(page.locator(".console h1")).toBeVisible();
  await expect(page.locator(".statusbar [data-sb='cloudflare']")).toContainText("読み込み中");
  release();
  await expect(page.locator(".statusbar [data-sb='cloudflare']")).not.toContainText("読み込み中");
});

test("(L3) タスクの URL: 詳細が遅くても、ヘッダ・予算・Cloudflare・コンソールの読み込み中が出る（画面全体は止まらない）", async ({
  page,
}) => {
  const release = await hold(page, DETAIL);
  await loginAs(page, s.users.alice, taskPath(s.tasks.done as string));
  await expect(page.locator("header.top fieldset.seg:not(.lang)")).toBeVisible();
  await expect(page.locator(".statusbar [data-sb='budget-me']")).toContainText("今月");
  await expect(page.locator(".console-col")).toContainText("読み込み中");
  release();
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  await expect(rail(page, s.tasks.done as string)).toBeVisible();
});

test("(L4) 詳細は、開いた最初の取得だけ ?fresh=1。自動更新のポーリングには付かない（D6）", async ({
  page,
}) => {
  const detailUrls: string[] = [];
  page.on("request", (req) => {
    if (DETAIL.test(req.url())) detailUrls.push(new URL(req.url()).search);
  });
  await page.clock.install();
  await loginAs(page, s.users.alice, taskPath(s.tasks.grow as string));
  await expect(page.locator(".console h1")).toBeVisible();
  await expect(async () => {
    await page.clock.runFor(5_000);
    expect(detailUrls.length).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 60_000 });
  expect(detailUrls[0]).toBe("?fresh=1");
  expect(detailUrls.slice(1).every((q) => q === "")).toBe(true);
});
