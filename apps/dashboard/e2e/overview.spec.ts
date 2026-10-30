import {
  expect,
  loginAs,
  openDrawer,
  rail,
  tallScreen,
  taskPath,
  test,
  withBudgetBinding,
} from "./fixtures";
import { readState } from "./state";

const s = readState();

test("(1) 偽 GitHub でログインすると一覧が出る（127.0.0.1 の __Host- / Secure の Cookie が通る）", async ({
  page,
  context,
}) => {
  await loginAs(page, s.users.alice);
  await expect(page.getByRole("navigation", { name: "タスク" })).toBeVisible();
  for (const key of ["done", "failed", "running"]) {
    await expect(rail(page, s.tasks[key] as string)).toBeVisible();
  }
  const session = (await context.cookies()).find((c) => c.name === "__Host-rovo_dash");
  expect(session, "セッション Cookie").toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.secure).toBe(true);
  // 見本の構成: ヘッダの要約・今日のタイムライン（細い帯）・レール・コンソール・ステータスバー
  await expect(page.locator(".day-summary")).toBeVisible();
  // 今日はマイタスク（既定）でもチームでも工場の帯（時刻の帯は過去の日のチームだけ）
  await expect(page.locator("section[data-factory]")).toBeVisible();
  await expect(page.locator(".tlband")).toHaveCount(0);
  await page.getByRole("button", { name: "チーム" }).click();
  await expect(page.locator("section[data-factory]")).toBeVisible();
  await expect(page.locator(".tlband")).toHaveCount(0);
  await expect(page.locator(".statusbar")).toBeVisible();
  // 予算の内訳（自分・全員を 1 つの欄に）は「内訳」の引き出しの中
  await openDrawer(page);
  await expect(page.locator('[data-budget="month"]')).toBeVisible();
});

test("(2) チーム / マイタスクの切り替え: 最初は「マイタスク」で他人のタスクが無く、「チーム」にすると出る", async ({
  page,
}) => {
  await loginAs(page, s.users.bob);
  const bobRow = rail(page, s.tasks.bob as string);
  const aliceRow = rail(page, s.tasks.done as string);
  const all = page.getByRole("button", { name: "チーム" });
  const me = page.getByRole("button", { name: "マイタスク" });
  // 既定は「マイタスク」
  await expect(me).toHaveAttribute("aria-pressed", "true");
  await expect(all).toHaveAttribute("aria-pressed", "false");
  await expect(bobRow).toBeVisible();
  await expect(aliceRow).toHaveCount(0);

  // マイタスクでは依頼者を出さない。並びは「マイタスク」が先
  await expect(page.locator(".rail-owner")).toHaveCount(0);
  expect(await page.locator("fieldset.seg:not(.lang) button").allTextContents()).toEqual([
    "マイタスク",
    "チーム",
  ]);

  await all.click();
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(me).toHaveAttribute("aria-pressed", "false");
  await expect(aliceRow).toBeVisible();
  await expect(bobRow).toBeVisible();
  // チーム表示のときだけ、行に依頼者（頭文字の丸と login）
  await expect(aliceRow.locator(".rail-owner .rail-avatar")).toBeVisible();
  await expect(aliceRow.locator(".rail-owner .rail-login")).not.toHaveText("");

  await me.click();
  await expect(aliceRow).toHaveCount(0);
  await expect(bobRow).toBeVisible();
});

test("(3) レールの行のリンクで詳細へ行ける", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await rail(page, s.tasks.done as string).click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(s.tasks.done as string)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
});

test("(9) 状態が DOM の属性とアクセシブルな名前で判別できる（色に頼らない）", async ({ page }) => {
  // 今日の工場の Rovo: 部屋は data-room と名前の文字で分かる（人の色だけに頼らず、頭文字のバッジもある）
  await tallScreen(page);
  await loginAs(page, s.users.alice);
  const rovo = page.locator(`section[data-factory] a[data-task="${s.tasks.running}"]`);
  await expect(rovo).toHaveAttribute("data-room", /^(prep|code)$/);
  await expect(rovo).toHaveAccessibleName(/実行中のタスク（.*・(準備|コーディング)）/);
  await expect(rovo.locator(".fx-badge")).toHaveText(s.users.alice.login.slice(0, 1).toUpperCase());
  // 時刻の帯の棒（a[data-task]）は過去の日のチームのときだけ出る。ブラウザだけ 1 日先の時計にして、テストのタスクを「前の日」にする
  await page.clock.setFixedTime(Date.now() + 24 * 3_600_000);
  await page.reload();
  await page.getByRole("button", { name: "チーム" }).click();
  await page.getByRole("button", { name: "前の日" }).click();
  const done = page.locator(`.tlband a[data-task="${s.tasks.done}"]`);
  const failed = page.locator(`.tlband a[data-task="${s.tasks.failed}"]`);
  await expect(done).toHaveAttribute("data-status", "COMPLETED");
  await expect(done).toHaveAttribute("data-mark", "done");
  await expect(failed).toHaveAttribute("data-status", "FAILED");
  await expect(failed).toHaveAttribute("data-mark", "failed");
  // アクセシブルな名前に題名と状態の文字が入る
  await expect(done).toHaveAccessibleName(/完了したタスク（.*完了、/);
  await expect(failed).toHaveAccessibleName(/失敗したタスク（.*失敗、/);
  // レールの印は SVG の記号。名前（aria-label）と形（data-shape）を持つ
  const railMark = (id: string) => rail(page, id).locator("svg.mark-sym");
  await expect(railMark(s.tasks.done as string)).toHaveAttribute("aria-label", "完了");
  await expect(railMark(s.tasks.failed as string)).toHaveAttribute("aria-label", "失敗");
  await expect(railMark(s.tasks.failed as string)).toHaveAttribute("data-shape", "cross");
  // 印の形が属性で違う（塗り・縁）。色を無視しても、文字と形で区別できる
  const mark = (id: string) =>
    page.locator(`.tlband a[data-task="${id}"] rect[data-mark]`).getAttribute("class");
  const running = await mark(s.tasks.running as string);
  expect(running).toContain("mk--dashed");
  expect(await mark(s.tasks.done as string)).toContain("mk--solid");
  // 凡例（内訳の引き出し）にも状態の文字がある
  await openDrawer(page);
  await expect(page.getByRole("list", { name: "凡例" })).toContainText("完了");
  await expect(page.getByRole("list", { name: "凡例" })).toContainText("失敗");
});

test("(1b) あと何件: ふだん（b >= h）は同時と予算の件数を並べる", async ({ page }) => {
  // E2E の gateway は予算の方が少ない（b < h）ので、b >= h は応答の差し替えで作る
  await withBudgetBinding(page, {
    max_concurrent_tasks: 19,
    concurrency_limit: 2,
    running_slots: 0,
    startable: 2,
  });
  await loginAs(page, s.users.alice);
  await expect(page.locator('.statusbar [data-sb="budget-left"]')).toContainText("同時にあと 2 件");
  await openDrawer(page);
  await expect(page.locator("[data-budget-startable]")).toHaveText(
    "同時に 2 件始められます（予算では 19 件分）。",
  );
});

test("(1c) 予算が件数を決めているとき（b < h）: 欄は「予算の残りで、あと N 件」、バーは「予算であと N 件」", async ({
  page,
}) => {
  await withBudgetBinding(page, {
    max_concurrent_tasks: 1,
    concurrency_limit: 10,
    running_slots: 0,
    startable: 1,
  });
  await loginAs(page, s.users.alice);
  await expect(page.locator('.statusbar [data-sb="budget-left"]')).toContainText("予算であと 1 件");
  await openDrawer(page);
  await expect(page.locator("[data-budget-startable]")).toHaveText(
    "予算の残りで、あと 1 件始められます。",
  );
});

test("(1d) 予算が 0 件分のとき: 「予算の残りが足りないため、新しいタスクは始められません」", async ({
  page,
}) => {
  await withBudgetBinding(page, {
    max_concurrent_tasks: 0,
    concurrency_limit: 10,
    running_slots: 0,
    startable: 0,
  });
  await loginAs(page, s.users.alice);
  await openDrawer(page);
  await expect(page.locator("[data-budget-startable]")).toHaveText(
    "予算の残りが足りないため、新しいタスクは始められません。",
  );
});
