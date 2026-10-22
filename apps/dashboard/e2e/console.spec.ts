import type { Page } from "@playwright/test";
import { emit } from "./api";
import { expect, loginAs, openDrawer, rail, taskPath, test } from "./fixtures";
import { LONG_STEPS, readState } from "./state";

// 「B 制御卓」の骨格と、コンソールの流れ（実ブラウザ）。
const s = readState();
const id = (k: string) => s.tasks[k] as string;

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} の位置が取れない`);
  return b;
};

/** 台本のイベントの取り込みは非同期なので、手順が揃うまで開き直す */
async function openLong(page: Page) {
  await loginAs(page, s.users.alice, taskPath(id("long")));
  const steps = page.locator("ol.steps li.step");
  await expect(async () => {
    await page.reload();
    await expect(steps.first()).toBeVisible();
    expect(await steps.count()).toBeGreaterThanOrEqual(LONG_STEPS);
  }).toPass({ timeout: 60_000 });
}

const metrics = (page: Page) =>
  page.locator(".screen").evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
    client: el.clientHeight,
    following: el.getAttribute("data-following"),
  }));
const atBottom = (m: { top: number; height: number; client: number }) =>
  m.height - m.top - m.client <= 24;

test("(12) 一覧の骨格: ヘッダ → 細いタイムライン帯 → レールとコンソール → ステータスバー。コンソールは最新の走行中", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  await expect(page.locator(".day-summary")).toHaveText(
    /\d+月\d+日\s+\d+ 件\s+マージ \d+\s+走行中 \d+/,
  );
  const header = await box(page, "header.top");
  const band = await box(page, ".tlband");
  const railBox = await box(page, "nav.rail");
  const consoleBox = await box(page, ".console");
  const bar = await box(page, ".statusbar");

  // 縦の並び
  expect(band.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  expect(railBox.y).toBeGreaterThanOrEqual(band.y + band.height - 1);
  expect(consoleBox.y).toBeGreaterThanOrEqual(band.y + band.height - 1);
  expect(bar.y).toBeGreaterThanOrEqual(consoleBox.y + consoleBox.height - 1);
  // 横の並び: レールが左、コンソールが右
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(consoleBox.x + 1);
  // タイムラインは細い帯（48px 前後）
  expect(band.height).toBeGreaterThan(30);
  expect(band.height).toBeLessThanOrEqual(64);

  // 一覧のコンソールは最新の走行中。レールで選択中。個別ページへの「詳細を開く」リンクは無い（一覧がそのまま詳細）
  await expect(page.getByRole("heading", { level: 1, name: "手順が長いタスク" })).toBeVisible();
  await expect(page.getByRole("link", { name: "詳細を開く" })).toHaveCount(0);
  await expect(rail(page, id("long"))).toHaveAttribute("aria-current", "true");
  // タスクの URL（MCP の dashboard_url）を開いても、同じ骨格
  await page.goto(taskPath(id("long")));
  for (const sel of ["header.top", ".tlband", "nav.rail", ".console", ".statusbar"]) {
    await expect(page.locator(sel).first(), sel).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "詳細を開く" })).toHaveCount(0);
});

test("(13) ステータスバーに今月の自分・全員・モデル別・Cloudflare。「内訳」で引き出しを開閉できる（情報は消えない）", async ({
  page,
}) => {
  await loginAs(page, s.users.alice);
  const bar = page.locator(".statusbar");
  await expect(bar.locator('[data-sb="budget-me"]')).toContainText("今月");
  await expect(bar.locator('[data-sb="budget-left"]')).toContainText("残り");
  await expect(bar.locator('[data-sb="budget-all"]')).toContainText("全員");
  await expect(bar.locator('[data-sb="cloudflare"]')).toBeVisible();

  const button = page.getByRole("button", { name: "内訳" });
  const drawer = page.locator(".drawer");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-budget="month"]')).toContainText("今月の予算と実績");
  await expect(drawer.locator('[data-budget="month"]')).toContainText("全員の実績");
  await expect(drawer.locator("[data-models]")).toBeVisible();
  await expect(drawer.locator("[data-cloudflare]")).toBeVisible();
  await button.click();
  await expect(drawer).toBeHidden();
});

test("(14) レールの選択: 選んだ行の左にアクセント線。行を押すとそのタスクのコンソールになり、見出しにリポジトリ・モデル・費用・PR が出る", async ({
  page,
}) => {
  await loginAs(page, s.users.alice, taskPath(id("done")));
  const selected = rail(page, id("done"));
  const other = rail(page, id("failed"));
  await expect(selected).toHaveAttribute("aria-current", "true");
  const shadow = (loc: typeof selected) => loc.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(await shadow(selected)).toMatch(/3px/);
  expect(await shadow(other)).toBe("none");
  // 行にはツールチップ（title）を付けない。リポジトリ・モデル・費用はコンソールの見出しに出る
  await expect(selected).not.toHaveAttribute("title", /.+/);
  const head = page.locator(".con-head");
  await expect(head).toContainText("acme/widgets");
  await expect(head).toContainText("$");
  await expect(head.locator("[data-model]")).toBeVisible();
  await expect(head.locator("[data-pr]")).toBeVisible();

  await other.click();
  await expect(page).toHaveURL(new RegExp(`${taskPath(id("failed"))}$`));
  await expect(page.getByRole("heading", { level: 1, name: "失敗したタスク" })).toBeVisible();
  await expect(rail(page, id("failed"))).toHaveAttribute("aria-current", "true");
});

test("(15) ダーク・ライトの配色: prefers-color-scheme で paper / indigo のトークンに切り替わる", async ({
  page,
}) => {
  const colors = () =>
    page.evaluate(() => {
      const cs = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        const c = getComputedStyle(el);
        return { bg: c.backgroundColor, fg: c.color };
      };
      return { body: cs("body"), screen: cs(".screen"), bar: cs(".statusbar") };
    });

  await page.emulateMedia({ colorScheme: "light" });
  await loginAs(page, s.users.alice, taskPath(id("done")));
  await expect(page.locator(".screen")).toBeVisible();
  const light = await colors();
  expect(light.body.bg).toBe("rgb(227, 230, 233)");
  expect(light.body.fg).toBe("rgb(30, 41, 50)");
  expect(light.screen.bg).toBe("rgb(246, 247, 248)");
  expect(light.bar.bg).toBe("rgb(30, 41, 50)");

  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await colors();
  expect(dark.body.bg).toBe("rgb(27, 34, 56)");
  expect(dark.body.fg).toBe("rgb(220, 228, 238)");
  expect(dark.screen.bg).toBe("rgb(20, 26, 44)");
  expect(dark.bar.bg).toBe("rgb(46, 58, 97)");
  // 失敗の色もトークン（ライト #B83A1E / ダーク #FF8E72）
  await page.goto(taskPath(id("failed")));
  await expect(page.locator(".band-item--stopped")).toBeVisible();
  const stopped = () =>
    page.locator(".band-item--stopped").evaluate((el) => getComputedStyle(el).color);
  expect(await stopped()).toBe("rgb(255, 142, 114)");
  await page.emulateMedia({ colorScheme: "light" });
  expect(await stopped()).toBe("rgb(184, 58, 30)");
});

test("(16) 段階の帯: 到達した段階はアクセント、止まった段階 stopped_phase は失敗色", async ({
  page,
}) => {
  await loginAs(page, s.users.alice, taskPath(id("failed")));
  const stopped = page.locator("[data-band] li[data-state='stopped']");
  await expect(stopped).toHaveCount(1);
  const bar = (loc: ReturnType<Page["locator"]>) =>
    loc.locator(".band-bar").evaluate((el) => getComputedStyle(el).backgroundColor);
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  );
  const fail = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--fail").trim(),
  );
  expect(accent).not.toBe(fail);
  // 止まった段階だけ失敗色の線（色の値はトークンから）
  const toRgb = (hex: string) => {
    const n = Number.parseInt(hex.replace("#", ""), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  };
  expect(await bar(stopped)).toBe(toRgb(fail));
  const done = page.locator("[data-band] li[data-state='done']").first();
  if ((await done.count()) > 0) expect(await bar(done)).toBe(toRgb(accent));
});

test("(17) 実行中のコマンド: 経過時間と点滅カーソル。prefers-reduced-motion では点滅しない", async ({
  page,
}) => {
  // 偽の agent は途中の出力を出さないので、詳細の応答に output.running を足す（画面の表示を実ブラウザで確かめる）
  await page.route(new RegExp(`/dashboard/api/tasks/${id("running")}$`), async (route) => {
    // 入口の検査（Sec-Fetch-Site）を通すため、ページからの fetch と同じ same-origin を付けて取り直す
    const res = await route.fetch({
      headers: { ...route.request().headers(), "sec-fetch-site": "same-origin" },
    });
    const body = (await res.json()) as {
      generated_at: string;
      output: Record<string, unknown>;
    };
    const generated = Date.parse(body.generated_at);
    if (Number.isNaN(generated))
      throw new Error(`generated_at が無い: ${res.status()} ${JSON.stringify(body).slice(0, 300)}`);
    body.output = {
      tail: "step 1\nstep 2\n",
      command: "pnpm test",
      running: true,
      started_at: new Date(generated - 65_000).toISOString(),
      redacted: true,
    };
    await route.fulfill({ response: res, json: body });
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await loginAs(page, s.users.alice, taskPath(id("running")));
  const running = page.locator(".screen .output-running");
  await expect(running).toContainText("実行中");
  await expect(running).toContainText("1 分 5 秒");
  await expect(page.locator("pre.output")).toHaveText("step 1\nstep 2\n");
  const cursor = page.locator(".screen .cursor");
  await expect(cursor).toHaveCount(1);
  const animation = () => cursor.evaluate((el) => getComputedStyle(el).animationName);
  expect(await animation()).toBe("rovo-blink");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animation()).toBe("none");
});

test("(18) 実行中で、コマンドが走っていないときは、末尾に `$ ` のプロンプトと点滅カーソル", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await loginAs(page, s.users.alice, taskPath(id("grow")));
  const line = page.locator(".screen .prompt-line");
  await expect(line).toContainText("$");
  expect(await line.locator(".cursor").evaluate((el) => getComputedStyle(el).animationName)).toBe(
    "rovo-blink",
  );
  // コマンドの行は `$ コマンド`
  await expect(page.locator("ol.steps li.step--cmd").first()).toContainText("$ grow-first");
});

test("(19) 自動スクロール: 末尾にいる間は新しい行に追従し、上にスクロールしている間は動かさない。「末尾へ」で再開する", async ({
  page,
}) => {
  await page.clock.install();
  await openLong(page);
  const screen = page.locator(".screen");

  // 最初は末尾まで流れている
  await expect.poll(async () => atBottom(await metrics(page))).toBe(true);
  const first = await metrics(page);
  expect(first.height, "画面が縦にあふれていない").toBeGreaterThan(first.client + 100);
  expect(first.following).toBe("true");

  // 新しい行が来ても末尾に追従する
  await emit(s.baseUrl, id("long"), "command", { command: "follow-1", exitCode: 0 });
  await expect(async () => {
    await page.clock.runFor(5_000);
    await expect(page.locator("ol.steps")).toContainText("follow-1", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect.poll(async () => atBottom(await metrics(page))).toBe(true);
  await expect(page.locator("ol.steps li.step").last()).toBeInViewport();

  // 利用者が上にスクロールする → 追従を止める
  await screen.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(screen).toHaveAttribute("data-following", "false");
  await emit(s.baseUrl, id("long"), "command", { command: "follow-2", exitCode: 0 });
  await expect(async () => {
    await page.clock.runFor(5_000);
    await expect(page.locator("ol.steps")).toContainText("follow-2", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  expect((await metrics(page)).top, "追従していないのに動いた").toBeLessThan(5);
  // 「末尾へ」が出る → 押すと末尾に戻り、追従を再開する
  const jump = page.getByRole("button", { name: "末尾へ" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(screen).toHaveAttribute("data-following", "true");
  await expect.poll(async () => atBottom(await metrics(page))).toBe(true);
  await expect(jump).toHaveCount(0);
});

test("(20) 古いイベントを読む（さらに読む）は画面の先頭にある", async ({ page }) => {
  await loginAs(page, s.users.alice, taskPath(id("done")));
  const screen = page.locator(".screen");
  await expect(screen).toBeVisible();
  // 少ない手順では出ない。出るときは画面の最初の要素
  const older = screen.locator(".older");
  if ((await older.count()) > 0) {
    expect(await screen.evaluate((el) => el.firstElementChild?.className)).toBe("older");
  }
});

for (const [name, path] of [
  ["一覧", "/dashboard/"],
  ["詳細", taskPath(id("long"))],
] as const) {
  test(`(21) スマホ幅 390px の${name}: レールはコンソールの上、ステータスバーは折り返す、ページは横にスクロールしない`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, s.users.alice, path);
    await expect(page.locator(".console h1")).toBeVisible();
    // 一覧・コンソールは届いたものから描かれるので、レールの行が出て配置が落ち着いてから測る
    await expect(page.locator("a.rail-row").first()).toBeVisible();

    const railBox = await box(page, "nav.rail");
    const consoleBox = await box(page, ".console");
    expect(railBox.y + railBox.height).toBeLessThanOrEqual(consoleBox.y + 1);
    expect(railBox.width).toBeGreaterThan(300);

    // 横スクロールはコンソールの中だけ（ページ全体は横にあふれない）
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      view: window.innerWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.view);
    expect(await page.locator(".screen").evaluate((el) => getComputedStyle(el).overflowX)).toMatch(
      /auto|scroll/,
    );

    // ステータスバーは 1 行に収まらず折り返す。はみ出さない
    const bar = await box(page, ".statusbar");
    expect(bar.height).toBeGreaterThan(60);
    expect(bar.x + bar.width).toBeLessThanOrEqual(390 + 1);
    await openDrawer(page);
    const drawer = await box(page, ".drawer");
    expect(drawer.x + drawer.width).toBeLessThanOrEqual(390 + 1);
  });
}
