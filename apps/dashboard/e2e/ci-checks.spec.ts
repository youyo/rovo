import type { Page } from "@playwright/test";
import {
  apiCalls,
  type ChecksBody,
  expect,
  loginAs,
  mockChecks,
  taskPath,
  test,
  withPr,
} from "./fixtures";
import { readState } from "./state";

// タスク詳細の PR の CI（check run と commit status）。幅が足りれば（1280px 以上）ログの右にペイン、足りなければ「コンソール / CI」のタブ。
// 偽 GitHub の PR は github.com の URL を持たないので、PR と /checks の応答は fixtures.ts の withPr / mockChecks で差し替える。
const s = readState();
const id = (k: string) => s.tasks[k] as string;
const SHA = "0123456789abcdef0123456789abcdef01234567";

const run = (
  name: string,
  status: "queued" | "in_progress" | "completed",
  conclusion: string | null,
  url: string | null = `https://github.com/example-org/widgets/actions/runs/${name.length}`,
): ChecksBody["checks"][number] => ({
  name,
  kind: "check_run",
  status,
  conclusion,
  started_at: status === "queued" ? null : "2026-10-21T05:00:00Z",
  completed_at: status === "completed" ? "2026-10-21T05:01:30Z" : null,
  url,
});

const failing: ChecksBody = {
  head_sha: SHA,
  state: "failing",
  truncated: false,
  partial: false,
  checks: [
    run("lint", "completed", "success"),
    run("unit", "completed", "failure"),
    run("e2e", "in_progress", null),
    run("deploy-preview", "queued", null),
    run("docs", "completed", "skipped"),
  ],
};
const passing: ChecksBody = {
  ...failing,
  state: "passing",
  checks: [run("lint", "completed", "success"), run("unit", "completed", "success")],
};

async function open(page: Page, body: ChecksBody, width: number, height = 900) {
  await page.setViewportSize({ width, height });
  const ctl = await mockChecks(page, id("done"), body);
  await withPr(page, id("done"));
  await loginAs(page, s.users.alice, taskPath(id("done")));
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  return ctl;
}

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, `${selector} の位置が取れない`).not.toBeNull();
  return b as { x: number; y: number; width: number; height: number };
};

test("(CI1) 1440px: 左はログ（残りの幅すべて）、右は細い固定幅の CI のペイン。タブは出ない", async ({
  page,
}) => {
  await open(page, failing, 1440);
  await expect(page.locator("[role=tablist]")).toHaveCount(0);
  const main = await box(page, ".con-split > .con-main");
  const pane = await box(page, ".con-split > .ci-pane");
  expect(main.x + main.width).toBeLessThanOrEqual(pane.x + 1);
  // CI の列は 260〜320px の固定幅。ログはそれより広く、残りの幅を使う
  expect(pane.width).toBeGreaterThanOrEqual(260);
  expect(pane.width).toBeLessThanOrEqual(320);
  expect(main.width).toBeGreaterThan(pane.width * 2);
  // 左: 段階の帯とログ。右: CI
  await expect(page.locator(".con-main [data-band]")).toBeVisible();
  await expect(page.locator(".con-main .logbox")).toBeVisible();
  await expect(page.locator(".ci-pane h2")).toHaveText("CI");
  await expect(page.locator(".ci-pane [data-ci-sha]")).toHaveText("0123456");
  // 一覧は 失敗 → 実行中 → 待ち → 成功 → skipped。細い帯は同じ区画の数
  const names = page.locator(".ci-row .ci-name");
  await expect(names).toHaveText(["unit", "e2e", "deploy-preview", "lint", "docs"]);
  await expect(page.locator(".ci-strip .ci-seg")).toHaveCount(5);
  await expect(page.locator(".ci-row").first()).toContainText("失敗");
  // 見出しの PR の隣にチップ。色だけに頼らず数と aria-label
  const chip = page.locator(".con-head .ci-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute(
    "aria-label",
    "CI: 成功 2、失敗 1、実行中・待ち 2。CI を表示する",
  );
  await expect(chip).toHaveText("CI212");
  // 所要（完了した check run は 1 分 30 秒）
  await expect(page.locator(".ci-row").nth(3).locator(".ci-dur")).toHaveText("1 分 30 秒");
});

test("(CI1b) 1440px: check が少ないとき、ペインの高さは中身に合わせ、ログの高さに引き伸ばされない", async ({
  page,
}) => {
  await open(page, passing, 1440);
  const main = await box(page, ".con-split > .con-main");
  const pane = await box(page, ".con-split > .ci-pane");
  expect(pane.height).toBeLessThan(main.height - 40);
  expect(Math.abs(pane.y - main.y)).toBeLessThanOrEqual(2);
});

test("(CI1c) CI の行は 2 段: 1 段目に記号と名前、2 段目に所要時間と GitHub のリンクが名前の下にある（1440px / 390px）", async ({
  page,
}) => {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    if (w === 390) {
      await page.getByRole("tab", { name: /^CI/ }).click();
    } else {
      await open(page, failing, w, h);
    }
    if (w === 390) await expect(page.locator(".ci-pane")).toBeVisible();
    const row = page.locator(".ci-row").nth(3); // lint（成功・時間とリンクあり）
    const sym = await box(page, ".ci-row:nth-child(4) .mark-sym");
    const name = await row.locator(".ci-name").boundingBox();
    const dur = await row.locator(".ci-dur").boundingBox();
    const link = await row.locator(".ci-link").boundingBox();
    expect(name && dur && link).toBeTruthy();
    const n = name as { x: number; y: number; width: number; height: number };
    const d = dur as { x: number; y: number; width: number; height: number };
    const l = link as { x: number; y: number; width: number; height: number };
    // 記号は名前と同じ段
    expect(Math.abs(sym.y + sym.height / 2 - (n.y + n.height / 2))).toBeLessThanOrEqual(4);
    // 時間とリンクは名前の下の段。時間は名前の左端に揃い、リンクは右側
    expect(d.y).toBeGreaterThanOrEqual(n.y + n.height - 1);
    expect(l.y).toBeGreaterThanOrEqual(n.y + n.height - 1);
    expect(Math.abs(d.x - n.x)).toBeLessThanOrEqual(2);
    expect(l.x).toBeGreaterThan(d.x);
  }
});

test("(CI2) 並びの時にチップを押すと CI のペインに焦点が移る。キーボードでも押せて、焦点が見える", async ({
  page,
}) => {
  await open(page, failing, 1440);
  const chip = page.locator(".con-head .ci-chip");
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ci-pane")).toBeFocused();
  await expect(page.locator(".ci-pane")).toHaveCSS("outline-style", "solid");
});

test("(CI3) 1100px: 「コンソール / CI」のタブ。既定はコンソール。タブの見出しに失敗の数。チップを押すと CI のタブ、選びは覚えている", async ({
  page,
}) => {
  await open(page, failing, 1100);
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText(["コンソール", "CI1"]);
  // 「×」の文字ではなく、見出しの要約チップと同じ失敗の記号（赤い ✗ の丸）。読み上げは aria-label
  const ciTab = page.getByRole("tab", { name: /^CI/ });
  await expect(ciTab).toHaveAttribute("aria-label", "CI、失敗 1 件");
  await expect(ciTab.locator("svg.mark-sym--bad[data-shape='cross']")).toHaveCount(1);
  await expect(ciTab).not.toContainText("✗");
  await expect(page.getByRole("tab", { name: "コンソール" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".con-main")).toBeVisible();
  await expect(page.locator(".ci-pane")).toBeHidden();

  await page.locator(".con-head .ci-chip").click();
  await expect(page.getByRole("tab", { name: /^CI/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ci-pane")).toBeVisible();
  await expect(page.locator(".con-main")).toBeHidden();
  await expect(page.locator(".ci-pane")).toBeFocused();

  // 開き直しても CI のタブ（localStorage）
  await page.reload();
  await expect(page.getByRole("tab", { name: /^CI/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ci-pane")).toBeVisible();

  // 矢印キーでコンソールに戻る
  await page.getByRole("tab", { name: /^CI/ }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "コンソール" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".con-main")).toBeVisible();
});

test("(CI4) 幅を変えると並びとタブが切り替わる（1440px ↔ 1000px）", async ({ page }) => {
  await open(page, failing, 1440);
  await expect(page.locator("[role=tablist]")).toHaveCount(0);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(page.locator("[role=tablist]")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("[role=tablist]")).toHaveCount(0);
  await expect(page.locator(".ci-pane")).toBeVisible();
  await expect(page.locator(".con-main")).toBeVisible();
});

test("(CI5) 390px（モバイル）: タブで切り替わり、長い名前でも横にはみ出さない", async ({
  page,
}) => {
  const long = `very-long-workflow-name-${"x".repeat(160)}`;
  await open(
    page,
    { ...failing, checks: [run(long, "completed", "failure"), ...failing.checks] },
    390,
    844,
  );
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: /^CI/ }).click();
  await expect(page.locator(".ci-pane")).toBeVisible();
  const m = await page.evaluate(() => {
    const pane = document.querySelector(".ci-pane") as HTMLElement;
    const r = pane.getBoundingClientRect();
    return {
      docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      right: r.right,
      innerWidth: window.innerWidth,
      paneOver: pane.scrollWidth - pane.clientWidth,
    };
  });
  expect(m.docOver).toBeLessThanOrEqual(1);
  expect(m.right).toBeLessThanOrEqual(m.innerWidth + 1);
  expect(m.paneOver).toBeLessThanOrEqual(1);
  // 長い名前は省略表示（title に全部）
  await expect(page.locator(".ci-row .ci-name").first()).toHaveAttribute("title", long);
  // コンソールのタブに戻ると、ログが今までどおり見える
  await page.getByRole("tab", { name: "コンソール" }).click();
  await expect(page.locator(".con-main .logbox")).toBeVisible();
});

test("(CI6) PR が無いタスクでは、チップもタブもペインも出ず、/checks も取りに行かない", async ({
  page,
  net,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ctl = await mockChecks(page, id("done"), failing);
  await loginAs(page, s.users.alice, taskPath(id("done")));
  await expect(page.getByRole("heading", { level: 1, name: "完了したタスク" })).toBeVisible();
  await expect(page.locator("[data-pr]")).toBeVisible();
  await expect(page.locator(".ci-chip, .ci-pane, .con-split, [role=tablist]")).toHaveCount(0);
  // 帯とログは今までどおりコンソールの直下
  await expect(page.locator(".console > [data-band]")).toBeVisible();
  await expect(page.locator(".console > .logbox")).toBeVisible();
  expect(ctl.calls).toBe(0);
  expect(apiCalls(net, /\/checks$/)).toBe(0);
});

test("(CI7) CI がまだ無い・読めない（権限）の文言", async ({ page }) => {
  await open(
    page,
    { head_sha: SHA, state: "none", checks: [], truncated: false, partial: false },
    1440,
  );
  await expect(page.locator(".ci-pane")).toContainText("この PR にはまだ CI がありません");
  await expect(page.locator(".ci-strip")).toHaveCount(0);
  await expect(page.locator(".con-head .ci-chip")).toHaveAttribute(
    "aria-label",
    "CI: まだありません。CI を表示する",
  );

  const page2 = await page.context().newPage();
  await page2.setViewportSize({ width: 1440, height: 900 });
  await mockChecks(page2, id("done"), {
    head_sha: null,
    state: "unreadable",
    checks: [],
    truncated: false,
    partial: false,
  });
  await withPr(page2, id("done"));
  await page2.goto(taskPath(id("done")));
  await expect(page2.locator(".ci-pane")).toContainText(
    "CI を読めません。GitHub App に Checks と Commit statuses の読み取りの権限が要ります",
  );
});

test("(CI8) 上限で打ち切ったときは「最初の N 件だけを表示しています」", async ({ page }) => {
  await open(page, { ...passing, truncated: true }, 1440);
  await expect(page.locator(".ci-pane")).toContainText("最初の 2 件だけを表示しています");
});

test("(CI9) 外部が書ける値: github.com 以外の URL はリンクにならず、名前は HTML として解釈されない", async ({
  page,
  net,
}) => {
  const evilName = '<img src="x" onerror="window.__ci_xss=1">Build';
  await open(
    page,
    {
      ...passing,
      checks: [
        run(evilName, "completed", "success", "https://github.com/example-org/widgets/runs/1"),
        run("js", "completed", "success", "javascript:window.__ci_xss=2"),
        run("other-host", "completed", "success", "https://evil.example/steal"),
        run("lookalike", "completed", "success", "https://github.com.evil.example/x"),
        run("userinfo", "completed", "success", "https://github.com@evil.example/x"),
        run("http", "completed", "success", "http://github.com/o/r"),
        run("none", "completed", "success", null),
      ],
    },
    1440,
  );
  const links = page.locator(".ci-pane a");
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveAttribute(
    "href",
    "https://github.com/example-org/widgets/runs/1",
  );
  await expect(links.first()).toHaveAttribute("target", "_blank");
  await expect(links.first()).toHaveAttribute("rel", "noopener noreferrer");
  // 名前はテキストのまま
  await expect(page.locator(".ci-pane img")).toHaveCount(0);
  await expect(page.locator(".ci-name").filter({ hasText: "<img" })).toHaveCount(1);
  expect(await page.evaluate(() => (window as { __ci_xss?: unknown }).__ci_xss)).toBeUndefined();
  expect(net.external).toEqual([]);
});

test("(CI10) 更新の間隔: 実行中があれば 10 秒、全部終わっていれば 60 秒。detail の 5 秒とは別", async ({
  page,
  net,
}) => {
  await page.clock.install();
  const ctl = await open(page, failing, 1440);
  await expect(page.locator(".ci-row")).toHaveCount(5);
  const count = () => apiCalls(net, /\/checks$/);

  // 実行中・待ちがある間は 10 秒。7 秒では取らず（detail の 5 秒に引きずられない）、12 秒で取る
  const base = count();
  await page.clock.runFor(7_000);
  expect(count()).toBe(base);
  await expect(async () => {
    await page.clock.runFor(5_000);
    expect(count()).toBeGreaterThan(base);
  }).toPass({ timeout: 30_000 });

  // 全部終わると 60 秒間隔になる（後からの push を拾う）
  ctl.set(passing);
  await expect(async () => {
    await page.clock.runFor(10_000);
    await expect(page.locator(".ci-row")).toHaveCount(2, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const settled = count();
  await page.clock.runFor(40_000);
  expect(count()).toBe(settled);
  await expect(async () => {
    await page.clock.runFor(30_000);
    expect(count()).toBeGreaterThan(settled);
  }).toPass({ timeout: 30_000 });

  // 後から push されて、また動き出したら 10 秒に戻る
  ctl.set(failing);
  await expect(async () => {
    await page.clock.runFor(30_000);
    await expect(page.locator(".ci-row")).toHaveCount(5, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  const again = count();
  await expect(async () => {
    await page.clock.runFor(12_000);
    expect(count()).toBeGreaterThan(again);
  }).toPass({ timeout: 30_000 });
});

test("(CI11) prefers-reduced-motion: 実行中の輪（CI の行）が回らない", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, failing, 1440);
  const spinner = page.locator(".ci-row[data-class='run'] .spin");
  await expect(spinner).toBeVisible();
  expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});
