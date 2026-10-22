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

export const test = base.extend<{ net: NetworkLog }>({
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
  await page.getByRole("link", { name: "GitHub でログイン" }).click();
  await expect(page.locator("header .user").getByText(user.login, { exact: true })).toBeVisible();
}

export function taskPath(taskId: string): string {
  return `/dashboard/tasks/${taskId}`;
}

/** /dashboard/api/ への要求だけ数える（自動更新の確認用）。 */
export function apiCalls(net: NetworkLog, match: RegExp): number {
  return net.urls.filter((u) => match.test(new URL(u).pathname)).length;
}
