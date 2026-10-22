import { expect, loginAs, taskPath, test } from "./fixtures";
import { readState } from "./state";

const s = readState();

test("(1) 偽 GitHub でログインすると一覧が出る（127.0.0.1 の __Host- / Secure の Cookie が通る）", async ({
  page,
  context,
}) => {
  await loginAs(page, s.users.alice);
  await expect(page.getByRole("heading", { level: 2, name: "タスク" })).toBeVisible();
  for (const key of ["done", "failed", "running"]) {
    await expect(page.locator(`tr[data-task-id="${s.tasks[key]}"]`)).toBeVisible();
  }
  const session = (await context.cookies()).find((c) => c.name === "__Host-rovo_dash");
  expect(session, "セッション Cookie").toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.secure).toBe(true);
  // 見本の構成: 今日のタイムライン・表・予算・モデル別の費用
  await expect(page.locator("svg.tl, .tl-scroll").first()).toBeVisible();
  await expect(page.locator('[data-budget="me"]')).toBeVisible();
  await expect(page.locator('[data-budget="all"]')).toBeVisible();
});

test("(2) 全員 / 自分の切り替え: 自分にすると他人のタスクが消える", async ({ page }) => {
  await loginAs(page, s.users.bob);
  const bobRow = page.locator(`tr[data-task-id="${s.tasks.bob}"]`);
  const aliceRow = page.locator(`tr[data-task-id="${s.tasks.done}"]`);
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

test("(3) 行のリンクで詳細へ行ける（題名のリンク）", async ({ page }) => {
  await loginAs(page, s.users.alice);
  await page.locator(`tr[data-task-id="${s.tasks.done}"] td.title a`).click();
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
  // 表でも状態は文字で出る
  await expect(page.locator(`tr[data-task-id="${s.tasks.done}"] .status`)).toHaveText("完了");
  await expect(page.locator(`tr[data-task-id="${s.tasks.failed}"] .status`)).toHaveText("失敗");
  // 印の形が属性で違う（塗り・縁）。色を無視しても、文字と形で区別できる
  const mark = (id: string) =>
    page.locator(`tr[data-task-id="${id}"] rect[data-mark]`).getAttribute("class");
  const running = await mark(s.tasks.running as string);
  expect(running).toContain("mk--dashed");
  expect(await mark(s.tasks.done as string)).toContain("mk--solid");
  // 凡例にも状態の文字がある
  await expect(page.getByRole("list", { name: "凡例" })).toContainText("完了");
  await expect(page.getByRole("list", { name: "凡例" })).toContainText("失敗");
});
