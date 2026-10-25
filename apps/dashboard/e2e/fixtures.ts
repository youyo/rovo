import { test as base, expect, type Page } from "@playwright/test";
import { admin } from "./api";
import { type E2eUser, readState } from "./state";

export { expect };

export interface NetworkLog {
  /** すべてのリクエストの URL */
  urls: string[];
  /** 127.0.0.1 以外のホストへ出ようとした要求（中身は中断する） */
  external: string[];
}

/** 言語の保存先（src/prefs.ts の LANG_KEY と同じ。e2e は src を読み込まないので文字列で持つ） */
export const LANG_STORAGE_KEY = "rovo.dashboard.lang";

export const test = base.extend<{ net: NetworkLog; lang: "ja" | "en" | null }>({
  // 既存の E2E は日本語の文言で探すので、最初に日本語を保存しておく（保存が無いときだけ。切り替え後の読み直しを上書きしない）。
  // 初回は英語であること自体を確かめる E2E は test.use({ lang: null }) で外す
  lang: ["ja", { option: true }],
  context: async ({ context, lang }, use) => {
    if (lang !== null) {
      await context.addInitScript(
        ({ key, value }) => {
          try {
            if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
          } catch {
            // 保存できない環境では既定のまま
          }
        },
        { key: LANG_STORAGE_KEY, value: lang },
      );
    }
    await use(context);
  },
  baseURL: async ({ browserName: _ }, use) => {
    await use(readState().baseUrl);
  },
  // 外部ホストへの要求を記録して中断する（テストは外へ出ない。出ようとしたこと自体を失敗にする）
  net: async ({ context }, use) => {
    const log: NetworkLog = { urls: [], external: [] };
    await context.route(
      (url) => url.hostname !== "127.0.0.1",
      (route) => {
        log.external.push(route.request().url());
        void route.abort();
      },
    );
    context.on("request", (req) => log.urls.push(req.url()));
    await use(log);
  },
});

/** 偽 GitHub の「現在のユーザー」を切り替える（ログインする人）。 */
export async function setGitHubUser(user: E2eUser): Promise<void> {
  await admin().setCurrentUser(user.login);
}

/**
 * 実ブラウザでログインする（偽 GitHub は即承認）。path を開き、未ログインなら「GitHub でログイン」を押して、
 * 戻ってきた画面で止まる。
 */
export async function loginAs(page: Page, user: E2eUser, path = "/dashboard/"): Promise<void> {
  await setGitHubUser(user);
  await page.goto(path);
  await page.getByRole("link", { name: /^(GitHub でログイン|Sign in with GitHub)$/ }).click();
  // 広い幅は利用者名の文字、狭い幅（720px 以下）はアバター（summary の aria-label が利用者名）で確かめる
  const menu = page.locator("header .user");
  await expect(
    menu
      .getByText(user.login, { exact: true })
      .or(menu.locator(`summary[aria-label="${user.login}"]`))
      .first(),
  ).toBeVisible();
}

export function taskPath(taskId: string): string {
  return `/dashboard/tasks/${taskId}`;
}

/** /dashboard/api/ への要求だけ数える（自動更新の確認用）。 */
export function apiCalls(net: NetworkLog, match: RegExp): number {
  return net.urls.filter((u) => match.test(new URL(u).pathname)).length;
}

/** レールの行（1 行 1 タスク）。 */
export function rail(page: Page, taskId: string) {
  return page.locator(`a.rail-row[data-task-id="${taskId}"]`);
}

/** 「内訳」の引き出しを開く（開いていれば何もしない）。 */
export async function openDrawer(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "内訳" });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(page.locator(".drawer")).toBeVisible();
}
