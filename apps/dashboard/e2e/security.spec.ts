import type { Page } from "@playwright/test";
import { expect, loginAs, openDrawer, rail, taskPath, test } from "./fixtures";
import { readState } from "./state";

const s = readState();
const id = (k: string) => s.tasks[k] as string;

interface ApiResponse {
  url: string;
  status: number;
  /** 本文。読めた応答だけ入る（ナビゲーションで捨てられた応答は空） */
  body: () => Promise<string>;
}

/**
 * ページが受けた /dashboard/api/ の応答。status と URL は同期で記録し、本文はその場で取りに行く
 * （ページ遷移で捨てられた応答の本文は待たない）。
 */
function collectApi(page: Page): ApiResponse[] {
  const out: ApiResponse[] = [];
  page.on("response", (res) => {
    if (!new URL(res.url()).pathname.startsWith("/dashboard/api/")) return;
    // ナビゲーションで捨てられた応答の本文は返ってこないことがあるので、待つのは短く切る
    const text = Promise.race([
      res.text().catch(() => ""),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 3_000)),
    ]);
    out.push({ url: res.url(), status: res.status(), body: () => text });
  });
  return out;
}

test("(6) 権限の無いタスクは、一覧の画面にもネットワーク応答にも出ない", async ({ page }) => {
  const api = collectApi(page);
  await loginAs(page, s.users.bob);
  await expect(rail(page, s.tasks.bob as string)).toBeVisible();
  // 既定は「マイタスク」。他人のタスクの権限を確かめるので「チーム」にする
  await page.getByRole("button", { name: "チーム" }).click();
  // alice の widgets のタスクは見える（権限がある）
  await expect(rail(page, id("done"))).toBeVisible();
  // secret のタスクはレールにもタイムラインにもない
  await expect(
    page.locator(`[data-task-id="${id("secret")}"], [data-task="${id("secret")}"]`),
  ).toHaveCount(0);
  const text = await page.locator("body").innerText();
  expect(text).not.toContain(s.marks.secretTitle);
  expect(text).not.toContain("SECRET-CMD");
  // 件数と合計だけ（題名は無い。内訳の引き出しの中）
  await openDrawer(page);
  await expect(page.locator("[data-hidden-tasks]")).toBeVisible();

  const overview = api.filter((a) => a.url.includes("/dashboard/api/overview"));
  expect(overview.length).toBeGreaterThan(0);
  // 検査が空振りしないよう、本文が実際に読めていること（bob の widgets のタスクが入っている）
  const bodies = await Promise.all(overview.map((a) => a.body()));
  expect(bodies.some((b) => b.includes(s.tasks.bob as string))).toBe(true);
  for (const a of api) {
    const body = await a.body();
    expect(body, a.url).not.toContain(s.marks.secretTitle);
    expect(body, a.url).not.toContain(id("secret"));
    expect(body, a.url).not.toContain("SECRET-CMD");
  }
});

test("(6) 権限の無い詳細は 404 の画面で、題名の断片も出ない", async ({ page }) => {
  const api = collectApi(page);
  await loginAs(page, s.users.bob, taskPath(id("secret")));
  await expect(
    page.getByRole("heading", { level: 1, name: "このタスクは見られません" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("権限が無いか、存在しません");
  const html = await page.content();
  for (const piece of [s.marks.secretTitle, "SECRET-REPO", "SECRET-CMD", "acme/secret"]) {
    expect(html, piece).not.toContain(piece);
  }
  const detail = () => api.filter((a) => a.url.includes(`/dashboard/api/tasks/${id("secret")}`));
  await expect.poll(() => detail().length).toBeGreaterThan(0);
  for (const a of detail()) {
    expect(a.status, a.url).toBe(404);
    expect(await a.body(), a.url).not.toContain("SECRET");
  }
  // 存在しないタスクと見分けがつかない（同じ画面）
  await page.goto(taskPath("01JZ0000000000000000000000"));
  await expect(
    page.getByRole("heading", { level: 1, name: "このタスクは見られません" }),
  ).toBeVisible();
});

test("(7) 題名・command・出力の悪意のある入力は文字として出るだけで、実行されず、外へ出ない", async ({
  page,
  net,
}) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await loginAs(page, s.users.alice, taskPath(id("xss")));
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toContainText("<script>window.__xss=1</script>");
  await expect(h1).toContainText("[x](javascript:window.__xss=1)");
  // command（進み具合）と出力の枠にも文字のまま。台本のイベントの取り込みは非同期なので、揃うまで開き直す
  await expect(async () => {
    await page.reload();
    await expect(page.locator("ol.steps")).toContainText("<img src=x", { timeout: 3_000 });
    await expect(page.locator(".output-box pre.output")).toContainText('<img src=x onerror="window.__xss=1">', {
      timeout: 3_000,
    });
  }).toPass({ timeout: 60_000 });

  const root = page.locator("#root");
  expect(await root.locator("script").count()).toBe(0);
  // img は同梱のロゴ（ヘッダの固定の SVG）以外に無い
  expect(await root.locator("img:not(.brand-mark)").count()).toBe(0);
  expect(await root.locator('a[href^="javascript:" i]').count()).toBe(0);
  expect(await root.locator("[onerror]").count()).toBe(0);

  // 一覧でも同じ（題名がレールとタイムラインの名前に出る）
  await page.goto("/dashboard/");
  await expect(rail(page, id("xss"))).toContainText("<script>");
  expect(
    await page.locator("#root script, #root img:not(.brand-mark), #root [onerror]").count(),
  ).toBe(0);

  expect(
    await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss),
  ).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(net.external, "外部ホストへの要求").toEqual([]);
  expect(net.urls.filter((u) => u.includes("evil.example"))).toEqual([]);
});
