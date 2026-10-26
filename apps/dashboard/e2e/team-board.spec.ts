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
          url: `https://github.com/example-org/widgets/pull/${PR_NUMBER}`,
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
  const widgets = page.locator('.tb-repos tr[data-repo="example-org/widgets"]');
  await expect(widgets).toBeVisible();
  await expect(widgets.locator(".tb-count")).not.toHaveText("0");
  await expect(widgets.locator(".tb-repo-run")).toContainText("走行");
  // レビュー待ちのタスクの PR。GitHub の PR へのリンク（別タブ・opener なし）
  const pr = widgets.locator("a.tb-pr");
  await expect(pr.first()).toBeVisible();
  await expect(pr.first()).toHaveText(/^#\d+$/);
  await expect(pr.first()).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/example-org\/widgets\/pull\/\d+$/,
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
  await expect(board).not.toContainText("example-org/secret");
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
  await expect(page.locator(".tb-repos thead th").nth(1)).toHaveText("件数");
});

const monthSection = (page: Page) => page.locator("[data-month]");

test("(TB9) 今月の費用: 見出しに今月、閲覧者が先頭で人ごとに 1 行、割合とペースが文字でも分かる", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await openTeam(page);
  const sec = monthSection(page);
  await expect(sec).toBeVisible();
  await expect(sec.locator("h2")).toContainText("今月");
  const logins = await sec
    .locator("li.tb-month-row")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-login")));
  expect(logins[0]).toBe(s.users.alice.login);
  expect(logins).toContain(s.users.bob.login);
  expect(logins.slice(1)).toEqual([...logins.slice(1)].sort());
  await expect(sec.locator("li.tb-month-row[data-viewer='true']")).toHaveAttribute(
    "data-login",
    s.users.alice.login,
  );
  // alice は完了したタスクの費用がある。共通の上限に対する割合とペースは文字で出る（色や棒だけに頼らない）
  const alice = sec.locator(`li.tb-month-row[data-login="${s.users.alice.login}"]`);
  await expect(alice.locator(".tb-month-amount")).toContainText("$");
  await expect(alice.locator(".tb-month-amount")).toContainText("/");
  await expect(alice.locator(".tb-month-ratio")).toHaveText(/^\d+%$/);
  await expect(alice.locator(".tb-month-pace")).toHaveText(/^[▲▼] ペース(速め|遅め)$/);
  // 本人の予算の欄だけにある情報（残り・予約・あと何件）は、ここには無い
  await expect(sec).not.toContainText(/残り|予約|あと\s*\d+\s*件/);
});

test("(TB9b) ペース速め: 上限に対して月の経過より多く使っていると ▲ と文字で出る", async ({
  page,
}) => {
  // 表示のロジックを確かめるため、応答の人ごとの費用だけを大きくする（上限は gateway の値のまま）
  await page.route(/\/dashboard\/api\/overview/, async (route) => {
    const res = await route.fetch({
      headers: { ...route.request().headers(), "sec-fetch-site": "same-origin" },
    });
    const body = (await res.json()) as {
      month: { by_owner?: { login: string; task_cost_usd: number; consult_cost_usd: number }[] };
    };
    for (const o of body.month.by_owner ?? []) {
      if (o.login === s.users.alice.login) o.task_cost_usd = 99;
    }
    await route.fulfill({
      status: res.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await loginAs(page, s.users.alice);
  await openTeam(page);
  const alice = monthSection(page).locator(`li.tb-month-row[data-login="${s.users.alice.login}"]`);
  await expect(alice.locator(".tb-month-pace")).toHaveText("▲ ペース速め");
  await expect(alice.locator(".tb-month-pace")).toHaveAttribute("data-pace", "fast");
});

test("(TB10) 権限の無いタスクは 1 行にまとまり、持ち主の login は画面にも応答にも出ない", async ({
  page,
}) => {
  const bodies: string[] = [];
  page.on("response", async (res) => {
    if (/\/dashboard\/api\//.test(res.url())) bodies.push(await res.text().catch(() => ""));
  });
  await loginAs(page, s.users.bob);
  await openTeam(page);
  const sec = monthSection(page);
  await expect(sec.locator(`li.tb-month-row[data-login="${s.users.bob.login}"]`)).toBeVisible();
  // secret の持ち主（carol）は見えるタスクが無いので、行にも出ない。権限の無い分は件数と額だけ
  await expect(sec.locator("[data-month-hidden]")).toHaveText(/^権限の無いタスク \d+ 件 \$/);
  await expect(sec.locator(`li.tb-month-row[data-login="${s.users.carol.login}"]`)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(s.users.carol.login);
  await expect(page.locator("body")).not.toContainText(s.marks.secretTitle);
  // API の応答にも出ない（画面に描かない場所も含む）
  await expect.poll(() => bodies.some((b) => b.includes('"by_owner"'))).toBe(true);
  expect(bodies.some((b) => b.includes(s.users.carol.login))).toBe(false);
});

test("(TB10b) 権限のある人（alice）には、持ち主の行があり、権限の無い行は出ない", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await openTeam(page);
  await expect(
    monthSection(page).locator(`li.tb-month-row[data-login="${s.users.carol.login}"]`),
  ).toBeVisible();
  await expect(monthSection(page).locator("[data-month-hidden]")).toHaveCount(0);
});

test("(TB11) 過去の日に送っても、今月の費用は今月のまま", async ({ page }) => {
  await page.clock.setFixedTime(Date.now() + DAY_MS);
  await loginAs(page, s.users.alice);
  await page.getByRole("button", { name: "チーム" }).click();
  await page.getByRole("button", { name: "前の日" }).click();
  await expect(page.locator("#tb-people-h")).toHaveText("この日");
  const sec = monthSection(page);
  await expect(sec).toBeVisible();
  await expect(sec.locator("h2")).toContainText("今月");
  const alice = sec.locator(`li.tb-month-row[data-login="${s.users.alice.login}"]`);
  await expect(alice.locator(".tb-month-amount")).toContainText("$");
  await expect(alice.locator(".tb-month-ratio")).toHaveText(/^\d+%$/);
});

const flowSection = (page: Page) => page.locator("[data-flow]");

/** 今日の分（完了 2 件・失敗 1 件以上）が索引に入るまで開き直す（完了 → 索引への反映は非同期） */
async function waitForFlowToday(page: Page) {
  await expect(async () => {
    const last = flowSection(page).locator("[data-day]").last();
    await expect(last).toBeVisible({ timeout: 3_000 });
    const done = Number(await last.getAttribute("data-completed"));
    const failed = Number(await last.getAttribute("data-failed"));
    if (done < 2 || failed < 1) {
      await page.reload();
      await page.getByRole("button", { name: "チーム" }).click();
    }
    expect(done).toBeGreaterThanOrEqual(2);
    expect(failed).toBeGreaterThanOrEqual(1);
  }).toPass({ timeout: 60_000 });
}

/** 横軸のラベルが重ならず、区画の幅の中に収まっている */
async function expectAxisInside(page: Page) {
  const boxes = await flowSection(page)
    .locator("[data-axis-label]")
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { l: r.left, r: r.right };
      }),
    );
  const sec = await flowSection(page).boundingBox();
  if (!sec) throw new Error("区画の位置が取れない");
  for (const b of boxes) {
    expect(b.l).toBeGreaterThanOrEqual(sec.x - 1);
    expect(b.r).toBeLessThanOrEqual(sec.x + sec.width + 1);
  }
  for (let i = 1; i < boxes.length; i++) {
    expect((boxes[i] as { l: number }).l, "ラベルが重なっている").toBeGreaterThan(
      (boxes[i - 1] as { r: number }).r,
    );
  }
}

/** グラフ（SVG）が区画の幅の中に収まり、棒がすべて SVG の中にある */
async function expectFlowChartInside(page: Page) {
  const r = await flowSection(page).evaluate((el) => {
    const svg = el.querySelector("svg.tb-flow-chart")?.getBoundingClientRect();
    const sec = el.getBoundingClientRect();
    const bars = [...el.querySelectorAll("[data-day] rect")].map((b) => b.getBoundingClientRect());
    return {
      svgL: svg?.left ?? 0,
      svgR: svg?.right ?? 0,
      secL: sec.left,
      secR: sec.right,
      barL: Math.min(...bars.map((b) => b.left)),
      barR: Math.max(...bars.map((b) => b.right)),
    };
  });
  expect(r.svgL).toBeGreaterThanOrEqual(r.secL - 1);
  expect(r.svgR).toBeLessThanOrEqual(r.secR + 1);
  expect(r.barL, "棒が左にはみ出している").toBeGreaterThanOrEqual(r.svgL - 1);
  expect(r.barR, "棒が右にはみ出している").toBeLessThanOrEqual(r.svgR + 1);
}

test("(TB12d) 成果の推移: 1280px ではグラフが区画の幅の大部分（90% 以上）を使う", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, s.users.alice);
  await openTeam(page);
  await expect(flowSection(page).locator("[data-day]")).toHaveCount(14);
  const w = await flowSection(page).evaluate((el) => ({
    svg: el.querySelector("svg.tb-flow-chart")?.getBoundingClientRect().width ?? 0,
    body: el.querySelector(".tb-flow-body")?.getBoundingClientRect().width ?? 1,
  }));
  expect(w.svg / w.body, "グラフの幅 / 区画の幅").toBeGreaterThanOrEqual(0.9);
  await expectFlowChartInside(page);
  await expectAxisInside(page);
});

test("(TB12e) 成果の推移: 360px ではグラフも横軸もはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await loginAs(page, s.users.alice);
  await openTeam(page);
  await expect(flowSection(page).locator("[data-day]")).toHaveCount(14);
  await expectFlowChartInside(page);
  await expectAxisInside(page);
  await expectNoHorizontalScroll(page);
});

test("(TB12) 成果の推移: 区画、14 日分の棒、横軸の日付、失敗の棒の形、失敗率の件数、脚注", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, s.users.alice);
  await openTeam(page);
  const sec = flowSection(page);
  await expect(sec).toBeVisible();
  await expect(sec.locator("h2")).toContainText("成果の推移");
  await expect(sec.locator("h2")).toContainText("14");
  await waitForFlowToday(page);
  const days = sec.locator("[data-day]");
  await expect(days).toHaveCount(14);
  const dates = await days.evaluateAll((els) => els.map((e) => e.getAttribute("data-day")));
  expect(dates).toEqual([...dates].sort());
  // 今日（UTC）が最後の日
  expect(dates[13]).toBe(new Date().toISOString().slice(0, 10));
  // 横軸: 14 日前・1 週間前・今日のラベルが見え、棒の日付と一致する（ja は 10/25 の形）
  const short = (d: string | null) => {
    const [, m, dd] = (d ?? "").split("-");
    return `${Number(m)}/${Number(dd)}`;
  };
  const labels = sec.locator("[data-axis-label]");
  await expect(labels).toHaveCount(3);
  await expect(labels.nth(0)).toBeVisible();
  await expect(labels.nth(0)).toHaveText(short(dates[0] ?? null));
  await expect(labels.nth(1)).toHaveText(short(dates[7] ?? null));
  await expect(labels.nth(2)).toHaveText(short(dates[13] ?? null));
  // 間引いた日も読み上げの名前に日付と件数がある
  await expect(days.nth(3)).toHaveAttribute(
    "aria-label",
    /^\d{4}-\d{2}-\d{2}: 完了 0 件、失敗 0 件$/,
  );
  // 失敗のある日（今日）: 失敗の棒が完了の棒と形（斜線の塗り）で区別でき、見える大きさがある
  const today = days.last();
  const fail = today.locator("[data-fail-mark]");
  await expect(fail).toHaveCount(1);
  await expect(fail).toHaveAttribute("fill", /^url\(#/);
  const done = today.locator(".tb-flow-bar");
  expect(await done.evaluate((e) => getComputedStyle(e).fill)).not.toMatch(/^url/);
  const fb = await fail.boundingBox();
  const db = await done.boundingBox();
  expect(fb && fb.width > 2 && fb.height > 2).toBe(true);
  // 件数に比例: 完了が多い分、完了の棒の方が高く、同じ基線に立つ
  expect(fb && db && db.height > fb.height).toBe(true);
  expect(fb && db && Math.abs(fb.y + fb.height - (db.y + db.height)) < 1).toBe(true);
  // 凡例に、完了と失敗の見本（形）
  await expect(sec.locator(".tb-flow-legend")).toContainText("完了");
  await expect(sec.locator(".tb-flow-legend")).toContainText("失敗");
  await expect(sec.locator(".tb-flow-legend svg.tb-flow-key")).toHaveCount(2);
  // 失敗率は % と件数の併記
  await expect(sec.locator("[data-flow-rate] dd")).toHaveText(/^\d+% \(\d+ \/ \d+\)$/);
  await expect(sec.locator("[data-flow-median]")).toBeVisible();
  await expect(sec.locator("[data-flow-merged]")).toBeVisible();
  await expect(sec.locator("[data-flow-note]")).toHaveText(
    "rovo でマージした分だけ。GitHub で直接マージした分は入らない",
  );
  await expectAxisInside(page);
});

test("(TB12b) 過去の日に送っても、成果の推移は直近 14 日のまま", async ({ page }) => {
  await page.clock.setFixedTime(Date.now() + DAY_MS);
  await loginAs(page, s.users.alice);
  await page.getByRole("button", { name: "チーム" }).click();
  await page.getByRole("button", { name: "前の日" }).click();
  await expect(page.locator("#tb-people-h")).toHaveText("この日");
  await waitForFlowToday(page);
  const sec = flowSection(page);
  await expect(sec.locator("h2")).toContainText("成果の推移");
  await expect(sec.locator("[data-day]")).toHaveCount(14);
  await expect(sec.locator("[data-axis-label]")).toHaveCount(3);
  await expect(sec.locator("[data-day]").last()).toHaveAttribute(
    "data-day",
    new Date().toISOString().slice(0, 10),
  );
});

test("(TB12c) 権限の無いタスクの持ち主の login は、成果の推移にも画面にも応答にも出ない", async ({
  page,
}) => {
  const bodies: string[] = [];
  page.on("response", async (res) => {
    if (/\/dashboard\/api\//.test(res.url())) bodies.push(await res.text().catch(() => ""));
  });
  await loginAs(page, s.users.bob);
  await openTeam(page);
  await expect(flowSection(page)).toBeVisible();
  await expect.poll(() => bodies.some((b) => b.includes('"flow"'))).toBe(true);
  await expect(page.locator("body")).not.toContainText(s.users.carol.login);
  await expect(page.locator("body")).not.toContainText(s.marks.secretTitle);
  expect(bodies.some((b) => b.includes(s.users.carol.login))).toBe(false);
  expect(bodies.some((b) => b.includes(s.marks.secretTitle))).toBe(false);
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
    // 今月の費用の区画も幅の中（行は折り返す）
    await expect(monthSection(page).locator("li.tb-month-row").first()).toBeVisible();
    const monthOver = await monthSection(page).evaluate((el) => ({
      sec: el.scrollWidth > el.clientWidth + 1,
      rows: [...el.querySelectorAll("li.tb-month-row")].filter(
        (r) => r.scrollWidth > r.clientWidth + 1,
      ).length,
    }));
    expect(monthOver.sec, "今月の費用の区画").toBe(false);
    expect(monthOver.rows, "今月の費用の行").toBe(0);
    // 成果の推移の区画も幅の中。横軸のラベルは重ならずはみ出さない
    await expect(flowSection(page).locator("[data-day]")).toHaveCount(14);
    await expect(flowSection(page).locator("[data-axis-label]").first()).toBeVisible();
    const flowOver = await flowSection(page).evaluate((el) => ({
      sec: el.scrollWidth > el.clientWidth + 1,
      inner: [...el.querySelectorAll(".tb-flow-plot, .tb-flow-stats, .tb-flow-legend")].filter(
        (r) => r.scrollWidth > r.clientWidth + 1,
      ).length,
    }));
    expect(flowOver.sec, "成果の推移の区画").toBe(false);
    expect(flowOver.inner, "成果の推移の中").toBe(0);
    await expectAxisInside(page);
    await expectFlowChartInside(page);
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
      await expect(monthSection(page)).toBeVisible();
      await waitForFlowToday(page);
      await flowSection(page).scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(dir, `team-board-${scheme}-${width}.png`),
        fullPage: width === 360,
      });
    });
  }
}
