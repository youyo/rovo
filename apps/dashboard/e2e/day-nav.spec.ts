import { expect, loginAs, rail, test } from "./fixtures";
import { readState } from "./state";

const s = readState();

const DAY_MS = 24 * 3_600_000;

function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function heading(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

test("(day-1) 今日では「次の日」が押せない。「前の日」で URL と見出しが昨日になり、「次の日」で今日に戻る", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  const next = page.getByRole("button", { name: "次の日" });
  const prev = page.getByRole("button", { name: "前の日" });
  await expect(next).toBeDisabled();
  await expect(prev).toBeEnabled();
  await expect(page.getByRole("button", { name: "今日へ" })).toHaveCount(0);
  await expect(page.locator(".day-summary")).toContainText(heading(Date.now()));
  await expect(rail(page, s.tasks.done as string)).toBeVisible();

  await prev.click();
  await expect(page).toHaveURL(new RegExp(`\\?day=${ymd(Date.now() - DAY_MS)}$`));
  await expect(page.locator(".day-summary")).toContainText(heading(Date.now() - DAY_MS));
  // 昨日にはタスクが無い（テストのタスクは今日作った）。文言は「この日」向け
  await expect(rail(page, s.tasks.done as string)).toHaveCount(0);
  await expect(page.getByText("この日のタスクはありません。").first()).toBeVisible();
  await expect(next).toBeEnabled();
  await expect(page.getByRole("button", { name: "今日へ" })).toBeVisible();

  await next.click();
  await expect(page).not.toHaveURL(/day=/);
  await expect(next).toBeDisabled();
  await expect(rail(page, s.tasks.done as string)).toBeVisible();
});

test("(day-2) 日付が進んだ画面（ブラウザの時計を 1 日進める）で「前の日」を押すと、その日のタスクが出る。共有 URL で同じ日が開く", async ({
  page,
}) => {
  // ブラウザだけ 1 日先の時計にする → 画面の「今日」は明日、globalSetup で作ったタスクは「前の日」になる
  await page.clock.setFixedTime(Date.now() + DAY_MS);
  await loginAs(page, s.users.alice);
  await expect(page.getByRole("button", { name: "次の日" })).toBeDisabled();
  await expect(rail(page, s.tasks.done as string)).toHaveCount(0);
  // 今日は工場の帯
  await expect(page.locator("section[data-factory]")).toBeVisible();

  await page.getByRole("button", { name: "前の日" }).click();
  await expect(page.locator("section[data-factory]")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`\\?day=${ymd(Date.now())}$`));
  await expect(page.locator(".day-summary")).toContainText(heading(Date.now()));
  await expect(rail(page, s.tasks.done as string)).toBeVisible();
  await page.getByRole("button", { name: "チーム" }).click();
  await expect(page.locator(".tlband .tl-scroll").first()).toBeVisible();
  // 過去の日はいまの破線を出さない
  await expect(page.locator(".tlband [data-now]")).toHaveCount(0);

  // チーム / マイタスクの切り替えと両立し、リロードしても同じ日（URL が持つ）
  await page.getByRole("button", { name: "マイタスク" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?day=${ymd(Date.now())}$`));
  await expect(rail(page, s.tasks.done as string)).toBeVisible();
  await page.reload();
  await expect(rail(page, s.tasks.done as string)).toBeVisible();

  // 今日へ
  await page.getByRole("button", { name: "今日へ" }).click();
  await expect(page).not.toHaveURL(/day=/);
  await expect(rail(page, s.tasks.done as string)).toHaveCount(0);
});

test("(day-task) /dashboard/tasks/<id> は一覧でそのタスクを選んだ状態で開く。表示する日はそのタスクが始まった日。URL はそのまま", async ({
  page,
}) => {
  const done = s.tasks.done as string;
  // 今日始まったタスク: 今日の表示、レールで選択中、「詳細を開く」は無い
  await loginAs(page, s.users.alice, `/dashboard/tasks/${done}`);
  await expect(page).toHaveURL(new RegExp(`/dashboard/tasks/${done}$`));
  await expect(page.locator("nav.rail")).toBeVisible();
  await expect(rail(page, done)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  await expect(page.getByRole("link", { name: "詳細を開く" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "次の日" })).toBeDisabled();
  await expect(page.locator(".day-summary")).toContainText(heading(Date.now()));

  // ブラウザの時計を 1 日進める → そのタスクは「前の日」に始まったことになり、その日の一覧で開く
  await page.clock.setFixedTime(Date.now() + DAY_MS);
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/dashboard/tasks/${done}$`));
  await expect(page.locator(".day-summary")).toContainText(heading(Date.now()));
  await expect(rail(page, done)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  await expect(page.getByRole("button", { name: "今日へ" })).toBeVisible();
  await expect(page.getByRole("button", { name: "次の日" })).toBeEnabled();

  // 日を送ると一覧の URL になり、戻るで元のタスクの表示に戻る
  await page.getByRole("button", { name: "今日へ" }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/dashboard/tasks/${done}$`));
  await expect(rail(page, done)).toHaveAttribute("aria-current", "true");
});

test("(day-3) 狭い画面（360px）でもヘッダーが横にあふれない", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await loginAs(page, s.users.alice);
  // ログイン後の戻り先はパスだけなので、ログインしてから日付つきの URL を開く（共有 URL と同じ）
  await page.goto(`/dashboard/?day=${ymd(Date.now() - DAY_MS)}`);
  await expect(page.getByRole("button", { name: "前の日" })).toBeVisible();
  await expect(page.getByRole("button", { name: "今日へ" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
