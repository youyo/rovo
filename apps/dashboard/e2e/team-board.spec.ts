import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, loginAs, rail, taskPath, test } from "./fixtures";
import { readState } from "./state";

// チームボード（チームで何も選んでいないときの中央）。実ブラウザ + 実 gateway。
const s = readState();
const id = (k: string) => s.tasks[k] as string;
const DAY_MS = 24 * 3_600_000;

const openTeam = async (page: Page) => {
  await page.getByRole("button", { name: "チーム" }).click();
  await expect(page.locator("[data-teamboard]")).toBeVisible();
};

/**
 * 偽 GitHub の PR の URL は github.com の形でないため、gateway の応答では pr が落ちる（契約は GitHub の PR の URL だけを許す）。
 * 待ちの PR のリンクを確かめるため、概要の応答の「レビュー待ちのタスク」にだけ、開いた PR を足す。
 * 完了 → 索引への反映は非同期なので、リンクが出るまで開き直す。
 */
const PR_NUMBER = 4242;
async function installOpenPr(page: Page) {
  await page.route(/\/dashboard\/api\/overview/, async (route) => {
    const res = await route.fetch({
      headers: { ...route.request().headers(), "sec-fetch-site": "same-origin" },
    });
    const body = (await res.json()) as { tasks: { task_id: string; pr: unknown }[] };
    for (const t of body.tasks) {
      if (t.task_id === id("review")) {
        t.pr = {
          number: PR_NUMBER,
          url: `https://github.com/acme/widgets/pull/${PR_NUMBER}`,
          draft: false,
          merged: false,
          state: "open",
        };
      }
    }
    await route.fulfill({
      status: res.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}
const waitForPrLink = async (page: Page) => {
  await expect(async () => {
    await page.reload();
    await page.getByRole("button", { name: "チーム" }).click();
    await expect(page.locator("a.tb-pr").first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
};

const person = (page: Page, login: string) => page.locator(`li.tb-person[data-login="${login}"]`);

/** 横にはみ出していない（ページ全体と、ボードの中の各行・表） */
async function expectNoHorizontalScroll(page: Page) {
  const m = await page.evaluate(() => {
    const over = (el: Element) => el.scrollWidth > el.clientWidth + 1;
    return {
      doc: document.documentElement.scrollWidth - window.innerWidth,
      board: over(document.querySelector("[data-teamboard]") as Element),
      rows: [...document.querySelectorAll("li.tb-person, .tb-repos")].filter(over).length,
      col: over(document.querySelector(".console-col") as Element),
    };
  });
  expect(m.doc, "ページ全体の横スクロール").toBeLessThanOrEqual(0);
  expect(m.board, "ボード").toBe(false);
  expect(m.rows, "行・表").toBe(0);
  expect(m.col, "中央の領域").toBe(false);
}

test("(TB1) チームで何も選んでいないときはボード。マイタスクはコンソールのまま", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  // マイタスク: 今までどおり（最新の走行中のコンソール）
  await expect(page.getByRole("heading", { level: 1, name: "手順が長いタスク" })).toBeVisible();
  await expect(page.locator("[data-teamboard]")).toHaveCount(0);

  await openTeam(page);
  await expect(page.locator(".console h1")).toHaveCount(0);
  // 見出しに期間（いま / 今日）
  await expect(page.locator("#tb-people-h")).toHaveText("いま");
  await expect(page.locator("#tb-repos-h")).toContainText("リポジトリ別");
  await expect(page.locator("#tb-repos-h")).toContainText("今日");
  // レール・帯・ステータスバーはそのまま
  await expect(page.locator("nav.rail")).toBeVisible();
  await expect(page.locator(".tlband .tl-scroll").first()).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();

  // マイタスクへ戻すとコンソール
  await page.getByRole("button", { name: "マイタスク" }).click();
  await expect(page.locator("[data-teamboard]")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "手順が長いタスク" })).toBeVisible();
});

test("(TB2) いま: 閲覧者が先頭で人ごとに 1 行。走行の数はレールの走行中の行と一致し、タスクを押すとコンソールになる。戻るとボード", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await openTeam(page);
  const logins = await page
    .locator("li.tb-person")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-login")));
  expect(logins[0]).toBe(s.users.alice.login);
  expect(logins).toContain(s.users.bob.login);
  expect(logins.slice(1)).toEqual([...logins.slice(1)].sort());
  await expect(page.locator("li.tb-person[data-viewer='true']")).toHaveAttribute(
    "data-login",
    s.users.alice.login,
  );

  // 走行の数 = レールにある、その人の走行中（終端でない）の行の数
  for (const user of [s.users.alice, s.users.bob]) {
    const railRunning = await page
      .locator("a.rail-row")
      .evaluateAll(
        (els, login) =>
          els.filter(
            (e) =>
              e.querySelector(".rail-login")?.textContent === login &&
              ["RUNNING", "VERIFYING", "RECOVERING", "CREATING"].includes(
                e.getAttribute("data-status") ?? "",
              ),
          ).length,
        user.login,
      );
    expect(railRunning).toBeGreaterThan(0);
    await expect(person(page, user.login).locator('[data-stat="running"] .tb-stat-n')).toHaveText(
      String(railRunning),
    );
  }
  // 行の下に走行中のタスク（最大 3 件、残りは +n）。bob は 1 件
  const bobTasks = person(page, s.users.bob.login).locator("a.tb-task");
  await expect(bobTasks).toHaveCount(1);
  await expect(bobTasks.first()).toContainText("bob のタスク");
  await expect(bobTasks.first()).toHaveAttribute("data-mark", "running");
  expect(await person(page, s.users.alice.login).locator("a.tb-task").count()).toBeLessThanOrEqual(
    3,
  );
  await expect(person(page, s.users.alice.login).locator("[data-more]")).toHaveText(/^\+\d+$/);
  // 今日の完了・失敗
  await expect(
    person(page, s.users.alice.login).locator('[data-stat="done"] .tb-stat-n'),
  ).not.toHaveText("0");
  await expect(
    person(page, s.users.alice.login).locator('[data-stat="failed"] .tb-stat-n'),
  ).not.toHaveText("0");

  // タスクを押す → コンソール（URL はそのタスク。レールで選択中）
  await bobTasks.first().click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(id("bob"))}$`));
  await expect(page.getByRole("heading", { level: 1, name: "bob のタスク" })).toBeVisible();
  await expect(page.locator("[data-teamboard]")).toHaveCount(0);
  await expect(rail(page, id("bob"))).toHaveAttribute("aria-current", "true");

  // ブラウザの戻る = 何も選んでいない状態に戻る → ボード
  await page.goBack();
  await expect(page.locator("[data-teamboard]")).toBeVisible();
  await expect(page.locator(".console h1")).toHaveCount(0);
});

test("(TB2b) タスクを選んでいるとき、タブの「チーム」をもう一度押すとボードに戻る", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await openTeam(page);
  await rail(page, id("done")).click();
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  await page.getByRole("button", { name: "チーム" }).click();
  await expect(page.locator("[data-teamboard]")).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await expect(page.locator(".console h1")).toHaveCount(0);
  await expect(rail(page, id("done"))).not.toHaveAttribute("aria-current", "true");
  // 「いま」の小見出しは行の中に無い（区画の見出しだけ）。「今日」は残る
  await expect(page.locator("#tb-people-h")).toHaveText("いま");
  await expect(page.locator('[data-group="now"] .tb-cap')).toHaveCount(0);
  await expect(page.locator('[data-group="day"] .tb-cap').first()).toHaveText("今日");
});

test("(TB3) リポジトリ別: 今日の件数・走行・待ちの PR（レビュー待ちの PR のリンク）", async ({
  page,
}) => {
  await installOpenPr(page);
  await loginAs(page, s.users.alice);
  await openTeam(page);
  await waitForPrLink(page);
  const head = await page.locator(".tb-repos thead th").allTextContents();
  expect(head).toEqual(["リポジトリ", "今日の件数", "待ちの PR"]);
  const widgets = page.locator('.tb-repos tr[data-repo="acme/widgets"]');
  await expect(widgets).toBeVisible();
  await expect(widgets.locator(".tb-count")).not.toHaveText("0");
  await expect(widgets.locator(".tb-repo-run")).toContainText("走行");
  // レビュー待ちのタスクの PR。GitHub の PR へのリンク（別タブ・opener なし）
  const pr = widgets.locator("a.tb-pr");
  await expect(pr.first()).toBeVisible();
  await expect(pr.first()).toHaveText(/^#\d+$/);
  await expect(pr.first()).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/acme\/widgets\/pull\/\d+$/,
  );
  await expect(pr.first()).toHaveAttribute("rel", /noopener/);
  await expect(pr.first()).toHaveAttribute("target", "_blank");
});

test("(TB4) 権限の無いリポジトリのタスクは、見えない人のボードに出ない", async ({ page }) => {
  await loginAs(page, s.users.bob);
  await openTeam(page);
  const board = page.locator("[data-teamboard]");
  await expect(person(page, s.users.bob.login)).toBeVisible();
  await expect(board).not.toContainText(s.marks.secretTitle);
  await expect(board).not.toContainText("acme/secret");
  // alice の行はあるが、見えるタスク（widgets）の分だけ
  await expect(person(page, s.users.alice.login)).toBeVisible();
});

test("(TB5) 過去の日: 走行中の欄を出さず、その日の完了・失敗・費用だけ", async ({ page }) => {
  // ブラウザだけ 1 日先の時計にする → テストのタスクは「前の日」になる
  await page.clock.setFixedTime(Date.now() + DAY_MS);
  await loginAs(page, s.users.alice);
  await page.getByRole("button", { name: "チーム" }).click();
  await page.getByRole("button", { name: "前の日" }).click();
  await expect(page.locator("[data-teamboard]")).toBeVisible();
  await expect(page.locator("#tb-people-h")).toHaveText("この日");
  await expect(page.locator("#tb-repos-h")).toContainText("この日");
  await expect(page.locator('[data-stat="running"]')).toHaveCount(0);
  await expect(page.locator('[data-stat="asking"]')).toHaveCount(0);
  await expect(page.locator("a.tb-task")).toHaveCount(0);
  await expect(page.locator(".tb-repo-run")).toHaveCount(0);
  await expect(page.locator('[data-group="now"]')).toHaveCount(0);
  const alice = person(page, s.users.alice.login);
  await expect(alice.locator('[data-stat="done"] .tb-stat-n')).not.toHaveText("0");
  await expect(alice.locator(".tb-cost")).toBeVisible();
  await expect(page.locator(".tb-repos thead th").nth(1)).toHaveText("この日の件数");
});

for (const scheme of ["light", "dark"] as const) {
  test(`(TB6) 幅 360px で横スクロールが出ない（${scheme}）。数字は記号の列に畳む`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 360, height: 800 });
    await installOpenPr(page);
    await loginAs(page, s.users.alice);
    await openTeam(page);
    await waitForPrLink(page);
    await expect(person(page, s.users.bob.login)).toBeVisible();
    await expectNoHorizontalScroll(page);
    // 狭い幅では文字を畳む（読み上げと title には残す）。記号（形）と数字は見える
    const stat = person(page, s.users.alice.login).locator('[data-stat="running"]');
    await expect(stat.locator("svg.mark-sym")).toBeVisible();
    await expect(stat.locator(".tb-stat-n")).toBeVisible();
    await expect(stat).toHaveAttribute("title", /^走行 \d+$/);
    const labelBox = await stat.locator(".tb-stat-label").boundingBox();
    expect(labelBox === null || labelBox.width <= 2).toBe(true);
    // 表の PR のリンクも幅の中
    await expect(page.locator("a.tb-pr").first()).toBeVisible();
  });
}

test("(TB7) 広い幅（1280px）では文字ラベルが見える", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginAs(page, s.users.alice);
  await openTeam(page);
  const alice = person(page, s.users.alice.login);
  await expect(alice.locator('[data-stat="running"] .tb-stat-label')).toBeVisible();
  await expect(alice.locator('[data-stat="running"] .tb-stat-label')).toHaveText("走行");
  await expect(alice.locator('[data-stat="done"] .tb-stat-label')).toHaveText("完了");
  await expectNoHorizontalScroll(page);
});

// 見た目の確認用のスクリーンショット（ROVO_SHOTS_DIR。無ければ test-results の下）。画像の中身は比較しない
for (const scheme of ["light", "dark"] as const) {
  for (const width of [1280, 360]) {
    test(`(TB8) スクリーンショット: チームボード ${scheme} ${width}px`, async ({
      page,
    }, testInfo) => {
      const dir = process.env.ROVO_SHOTS_DIR ?? testInfo.outputPath("shots");
      mkdirSync(dir, { recursive: true });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: width === 360 ? 900 : 800 });
      await loginAs(page, s.users.alice);
      await openTeam(page);
      await expect(person(page, s.users.bob.login)).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(dir, `team-board-${scheme}-${width}.png`),
        fullPage: width === 360,
      });
    });
  }
}
