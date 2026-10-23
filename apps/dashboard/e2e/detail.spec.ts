import { emit } from "./api";
import { apiCalls, expect, loginAs, setGitHubUser, taskPath, test } from "./fixtures";
import { readState } from "./state";

const s = readState();
const id = (k: string) => s.tasks[k] as string;

test("(3) 詳細に、帯・進み具合・出力の枠・Draft PR の枠が出る", async ({ page }) => {
  await loginAs(page, s.users.alice, taskPath(id("done")));
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  // 準備 → 実行 → 検証 → 完了の帯
  const band = page.locator("[data-band]");
  await expect(band).toBeVisible();
  await expect(band.locator("li")).toHaveCount(4);
  await expect(band).toHaveAccessibleName(/段階: .*準備.*実行.*検証.*完了/);
  await expect(page.locator(".now-line")).toBeVisible();
  // 進み具合（人の言葉の手順）。seq が付く
  const steps = page.locator("ol.steps li.step");
  await expect(steps.first()).toBeVisible();
  // 台本のイベントの取り込みは非同期なので、揃うまで開き直す
  await expect(async () => {
    await page.reload();
    await expect(steps.first()).toBeVisible();
    expect(await steps.count(), await page.locator("ol.steps").innerText()).toBeGreaterThanOrEqual(
      3,
    );
  }).toPass({ timeout: 60_000 });
  await expect(steps.first()).toHaveAttribute("data-seq", /^\d+$/);
  // 出力の枠（暗い枠。末尾と、秘密を伏せている注記）
  await expect(page.locator("pre.output")).toContainText("PASS all");
  await expect(page.locator(".output-note")).toContainText("秘密は伏せて表示しています");
  await expect(page.locator("[data-pr]")).toBeVisible();
});

test("(4) 実行中のタスクの詳細で、手順が自動更新で増える", async ({ page }) => {
  await page.clock.install();
  await loginAs(page, s.users.alice, taskPath(id("grow")));
  const steps = page.locator("ol.steps li.step");
  await expect(steps.first()).toBeVisible();
  const before = await steps.count();

  await emit(s.baseUrl, id("grow"), "command", { command: "grow-second", exitCode: 0 });
  await emit(s.baseUrl, id("grow"), "command", { command: "grow-third", exitCode: 0 });
  // 5 秒の自動更新を進める（実時間では待たない）。取り込みの遅れに備えて繰り返す
  await expect(async () => {
    await page.clock.runFor(5_000);
    expect(await steps.count()).toBeGreaterThanOrEqual(before + 2);
  }).toPass({ timeout: 60_000 });
  await expect(page.locator("ol.steps")).toContainText("grow-third");
  // いまの手順（最後）に印が付く
  await expect(page.locator('li.step[data-current="true"]')).toHaveCount(1);
});

test("(5) 自動更新を切ると取りに行かない。今すぐ更新では取れる。入れ直すと再開する", async ({
  page,
  net,
}) => {
  await page.clock.install();
  await loginAs(page, s.users.alice, taskPath(id("paused")));
  await expect(page.locator("ol.steps li.step").first()).toBeVisible();
  const detail = new RegExp(`/dashboard/api/tasks/${id("paused")}$`);
  const events = new RegExp(`/dashboard/api/tasks/${id("paused")}/events$`);
  const calls = () => apiCalls(net, detail) + apiCalls(net, events);

  // 入っている間は 5 秒ごとに取る
  const start = calls();
  await expect(async () => {
    await page.clock.runFor(5_000);
    expect(calls()).toBeGreaterThan(start);
  }).toPass({ timeout: 30_000 });

  const toggle = page.getByRole("checkbox", { name: "自動で更新する" });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  const settled = calls();
  await page.clock.runFor(120_000);
  expect(calls(), "切ったあとに要求が出ている").toBe(settled);
  // 台本を足しても、切っている間は画面に出ない
  await emit(s.baseUrl, id("paused"), "command", { command: "paused-second", exitCode: 0 });
  await page.clock.runFor(30_000);
  await expect(page.locator("ol.steps")).not.toContainText("paused-second");

  // 今すぐ更新は取れる
  await expect(async () => {
    await page.getByRole("button", { name: "今すぐ更新" }).click();
    await expect(page.locator("ol.steps")).toContainText("paused-second", { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });

  // 入れ直すと自動更新が戻る
  await toggle.check();
  const resumed = calls();
  await expect(async () => {
    await page.clock.runFor(5_000);
    expect(calls()).toBeGreaterThan(resumed);
  }).toPass({ timeout: 30_000 });
});

test("(8) prefers-reduced-motion では実行中の輪が回らない（通常は回る。止めたときは破線の輪）", async ({
  page,
}) => {
  const pulse = page.locator(".console .state-name .spin");
  const animation = () => pulse.evaluate((el) => getComputedStyle(el).animationName);
  const dash = () =>
    pulse.locator(".mark-ring--arc").evaluate((el) => getComputedStyle(el).strokeDasharray);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await loginAs(page, s.users.alice, taskPath(id("running")));
  await expect(pulse).toBeVisible();
  expect(await animation()).toBe("rovo-spin");
  const arc = await dash();

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animation()).toBe("none");
  // 止めた輪は破線の輪（4 分の 3 の弧とは別の形）
  expect(await dash()).not.toBe(arc);
  // 開き直しても同じ
  await page.reload();
  await expect(pulse).toBeVisible();
  expect(await animation()).toBe("none");
});

test("(10) 未ログインで詳細を開く → ログイン → 同じ詳細に戻る", async ({ page }) => {
  await page.goto(taskPath(id("done")));
  await expect(page.getByText("ログインすると、このタスクの詳細を見られます。")).toBeVisible();
  await expect(page.getByText("完了したタスク")).toHaveCount(0);

  await setGitHubUser(s.users.alice);
  await page.getByRole("link", { name: "GitHub でログイン" }).click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(id("done"))}$`));
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
});
