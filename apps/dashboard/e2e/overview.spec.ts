import { expect, loginAs, openDrawer, rail, taskPath, test } from "./fixtures";
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
  await expect(page.locator(".tlband .tl-scroll").first()).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();
  // 予算の内訳（自分・全員）は「内訳」の引き出しの中
  await openDrawer(page);
  await expect(page.locator('[data-budget="me"]')).toBeVisible();
  await expect(page.locator('[data-budget="all"]')).toBeVisible();
});

test("(2) 全員 / 自分の切り替え: 自分にすると他人のタスクが消える", async ({ page }) => {
  await loginAs(page, s.users.bob);
  const bobRow = rail(page, s.tasks.bob as string);
  const aliceRow = rail(page, s.tasks.done as string);
  const all = page.getByRole("button", { name: "全員" });
  const me = page.getByRole("button", { name: "自分" });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(bobRow).toBeVisible();
  await expect(aliceRow).toBeVisible();

  await me.click();
  await expect(me).toHaveAttribute("aria-pressed", "true");
  await expect(all).toHaveAttribute("aria-pressed", "false");
  await expect(aliceRow).toHaveCount(0);
  await expect(bobRow).toBeVisible();

  await all.click();
  await expect(aliceRow).toBeVisible();
});

test("(3) レールの行のリンクで詳細へ行ける", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await rail(page, s.tasks.done as string).click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(s.tasks.done as string)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
});

test("(9) 状態が DOM の属性とアクセシブルな名前で判別できる（色に頼らない）", async ({ page }) => {
  await loginAs(page, s.users.alice);
  const done = page.locator(`a[data-task="${s.tasks.done}"]`);
  const failed = page.locator(`a[data-task="${s.tasks.failed}"]`);
  await expect(done).toHaveAttribute("data-status", "COMPLETED");
  await expect(done).toHaveAttribute("data-mark", "done");
  await expect(failed).toHaveAttribute("data-status", "FAILED");
  await expect(failed).toHaveAttribute("data-mark", "failed");
  // アクセシブルな名前に題名と状態の文字が入る
  await expect(done).toHaveAccessibleName(/完了したタスク（.*完了、/);
  await expect(failed).toHaveAccessibleName(/失敗したタスク（.*失敗、/);
  // レールでも状態は文字で出る（印は装飾。読み上げ用の文字を持つ）
  await expect(rail(page, s.tasks.done as string).locator(".sr-only")).toHaveText("完了");
  await expect(rail(page, s.tasks.failed as string).locator(".sr-only")).toHaveText("失敗");
  await expect(rail(page, s.tasks.failed as string).locator(".rail-mark")).toHaveText("✕");
  // 印の形が属性で違う（塗り・縁）。色を無視しても、文字と形で区別できる
  const mark = (id: string) =>
    page.locator(`a[data-task="${id}"] rect[data-mark]`).getAttribute("class");
  const running = await mark(s.tasks.running as string);
  expect(running).toContain("mk--dashed");
  expect(await mark(s.tasks.done as string)).toContain("mk--solid");
  // 凡例（内訳の引き出し）にも状態の文字がある
  await openDrawer(page);
  await expect(page.getByRole("list", { name: "凡例" })).toContainText("完了");
  await expect(page.getByRole("list", { name: "凡例" })).toContainText("失敗");
});
