import { expect, loginAs, rail, taskPath, test } from "./fixtures";
import { readState } from "./state";

// 日をまたいだ「待ち」（レールの「日付別 / 要対応」）。完了したタスクの PR は自動で Ready になる（レビュー・マージ待ち）。
const s = readState();

test("(waiting) 「待ち」タブを開くとレビュー待ちのタスクが出て、押すとコンソールにそのタスクが出る", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  const done = s.tasks.review as string;
  const tabs = page.locator("fieldset.rail-tabs");
  await expect(tabs.getByRole("button", { name: "日付別" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const waitingTab = tabs.getByRole("button", { name: /^要対応/ });

  // 自動の Ready は完了のあとに非同期で索引へ届くので、待ちに現れるまで開き直す
  await expect(async () => {
    await page.reload();
    await waitingTab.click();
    await expect(rail(page, done)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });

  await expect(waitingTab).toHaveAttribute("aria-pressed", "true");
  await expect(waitingTab).toHaveText(/^要対応 \d+\+?$/);
  // 待ちにあるのは入力待ちとレビュー待ちだけ。走行中・失敗は出ない
  await expect(rail(page, s.tasks.running as string)).toHaveCount(0);
  await expect(rail(page, s.tasks.failed as string)).toHaveCount(0);

  // 行を押すとコンソールにそのタスクが出る（既存の選択の仕組み。ページは読み直さない）
  await rail(page, done).click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(done)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "レビュー待ちのタスク" })).toBeVisible();
  await expect(rail(page, done)).toHaveAttribute("aria-current", "true");
  await expect(waitingTab).toHaveAttribute("aria-pressed", "true");

  // 「日付別」に戻すと日のタスクが出る
  await tabs.getByRole("button", { name: "日付別" }).click();
  await expect(rail(page, s.tasks.running as string)).toBeVisible();
});
