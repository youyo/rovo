import type { Page } from "@playwright/test";
import { expect, loginAs, taskPath, test } from "./fixtures";
import { LONG_STEPS, readState } from "./state";

// ワークスペースの高さ（制御卓: 広い画面はビューポートいっぱい、スマホ幅は縦に積んでページがスクロール）。
const s = readState();
const id = (k: string) => s.tasks[k] as string;

const box = async (page: Page, selector: string) => {
  // 描き終えてから測る。再描画で要素が差し替わる一瞬を挟んでも、位置が取れるまで測り直す
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible" });
  let b: Awaited<ReturnType<typeof loc.boundingBox>> = null;
  await expect(async () => {
    b = await loc.boundingBox();
    expect(b, `${selector} の位置が取れない`).not.toBeNull();
  }).toPass({ timeout: 10_000 });
  return b as unknown as { x: number; y: number; width: number; height: number };
};

/** 台本のイベントの取り込みは非同期なので、手順が揃うまで開き直す */
async function waitSteps(page: Page) {
  const steps = page.locator("ol.steps li.step");
  await expect(async () => {
    await page.reload();
    await expect(steps.first()).toBeVisible();
    expect(await steps.count()).toBeGreaterThanOrEqual(LONG_STEPS);
  }).toPass({ timeout: 60_000 });
}

test("(23) 背の高い画面: ステータスバーがビューポートの下端、レールとコンソールが残りの高さを埋め、画面だけがスクロールする", async ({
  page,
}) => {
  await loginAs(page, s.users.alice, taskPath(id("long")));
  for (const height of [1000, 1400]) {
    await page.setViewportSize({ width: 1280, height });
    await page.goto(taskPath(id("long")));
    await waitSteps(page);
    const bar = await box(page, ".statusbar");
    const consoleBox = await box(page, ".console");
    const railBox = await box(page, "nav.rail");
    // 下に大きな空きが無い（下の余白を除いて下端）
    expect(bar.y + bar.height, `高さ ${height}`).toBeGreaterThanOrEqual(height - 40);
    expect(bar.y + bar.height).toBeLessThanOrEqual(height);
    // コンソールとレールはステータスバーの手前まで埋める
    expect(consoleBox.y + consoleBox.height).toBeGreaterThanOrEqual(bar.y - 24);
    expect(railBox.y + railBox.height).toBeGreaterThanOrEqual(bar.y - 24);
    // ページ全体はスクロールしない。スクロールするのは画面（screen）だけ
    const doc = await page.evaluate(() => ({
      doc: document.documentElement.scrollHeight,
      view: window.innerHeight,
    }));
    expect(doc.doc).toBeLessThanOrEqual(doc.view);
    const screen = await page.locator(".screen").evaluate((el) => ({
      h: el.scrollHeight,
      c: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(screen.overflowY).toMatch(/auto|scroll/);
    // 画面は残りの高さを埋める（中身が短くても縮まない）。1000px の高さでは中身があふれて内部でスクロールする
    expect(screen.c).toBeGreaterThan(height === 1000 ? 400 : 700);
    if (height === 1000) expect(screen.h).toBeGreaterThan(screen.c);
    expect(await page.locator("nav.rail").evaluate((el) => getComputedStyle(el).overflowY)).toMatch(
      /auto|scroll/,
    );
  }
});

test("(24) スマホ幅では縦に積み、高さを固定せずページ全体がスクロールする", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await loginAs(page, s.users.alice, taskPath(id("long")));
  await expect(page.locator(".screen")).toBeVisible();
  const doc = await page.evaluate(() => ({
    doc: document.documentElement.scrollHeight,
    view: window.innerHeight,
  }));
  expect(doc.doc).toBeGreaterThan(doc.view);
  const railBox = await box(page, "nav.rail");
  const consoleBox = await box(page, ".console");
  expect(railBox.y + railBox.height).toBeLessThanOrEqual(consoleBox.y + 1);
  expect((await box(page, ".screen")).height).toBeGreaterThan(250);
});

test("(25) 幅 1,200px: モデル別が長くてもステータスバーは 1 行。項目は途中で切れない", async ({
  page,
}) => {
  // 本番で見つかった長さ（3 つのモデルの金額）にそろえる。概要 API の応答のモデル別だけ差し替える
  await page.setViewportSize({ width: 1200, height: 900 });
  await loginAs(page, s.users.alice, taskPath(id("long")));
  await page.route(/\/dashboard\/api\/overview/, async (route) => {
    const res = await route.fetch({
      headers: { ...route.request().headers(), "sec-fetch-site": "same-origin" },
    });
    const body = (await res.json()) as { models: unknown[] };
    body.models = [
      { model: "claude-sonnet-5-5", task_cost_usd: 3.7, consult_cost_usd: 0.04 },
      { model: "claude-haiku-5-5", task_cost_usd: 0.0629, consult_cost_usd: 0 },
      { model: "claude-opus-5-5", task_cost_usd: 0.0258, consult_cost_usd: 0 },
    ];
    await route.fulfill({
      status: res.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.reload();
  await expect(page.locator(".statusbar [data-sb='models']")).toContainText("sonnet $3.74");
  await expect(page.locator(".statusbar [data-sb='models']")).toContainText("opus $0.0258");
  // 1 行 = ステータスバーの子（項目・メーター・ボタン）の縦の中心がそろう（中央揃えなので、折り返すと中心がずれる）
  const first = await box(page, ".statusbar .sb");
  const centers = await page
    .locator(".statusbar > *")
    .evaluateAll((els) =>
      els
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2),
    );
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2);
  // どの項目も途中で折り返さない（1 行の高さ）。nowrap の項目は nowrap
  const items = await page.locator(".statusbar .sb, .statusbar .sb-item").evaluateAll((els) =>
    els.map((el) => ({
      k: el.getAttribute("data-sb") ?? el.textContent,
      h: el.getBoundingClientRect().height,
      ws: getComputedStyle(el).whiteSpace,
    })),
  );
  expect(Math.max(...items.map((i) => i.h))).toBeLessThanOrEqual(first.height + 2);
  for (const it of items.filter((i) => i.k !== "models"))
    expect(it.ws, String(it.k)).toBe("nowrap");
});
