import { test as base, expect, type Page, type Route } from "@playwright/test";
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

/**
 * 予算の件数が同時実行の空きより少ない（b < h）画面を作る。実 gateway の応答のうち、budget の
 * 件数まわり（max_concurrent_tasks・concurrency_limit・running_slots・startable）だけを差し替える
 * （概要 API と /budget の両方。ステータスバーは先に /budget で描くため）。loginAs の前に呼ぶ。
 */
export async function withBudgetBinding(
  page: Page,
  patch: {
    max_concurrent_tasks: number;
    concurrency_limit: number;
    running_slots: number;
    startable: number;
  },
): Promise<void> {
  const rewrite = (pick: (body: Record<string, unknown>) => Record<string, unknown>) => {
    return async (route: Route) => {
      const res = await route.fetch({
        headers: { ...route.request().headers(), "sec-fetch-site": "same-origin" },
      });
      if (res.status() !== 200) {
        await route.fulfill({ response: res });
        return;
      }
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...body, ...pick(body) }),
      });
    };
  };
  await page.route(
    /\/dashboard\/api\/overview/,
    rewrite((body) => ({ budget: { ...(body.budget as object), ...patch } })),
  );
  await page.route(
    /\/dashboard\/api\/budget$/,
    rewrite(() => patch),
  );
}

/** 偽 GitHub の PR の URL は github.com の形でないため、gateway の応答ではタスクの pr が落ちる（契約は GitHub の PR の URL だけを許す）。 */
export const FAKE_PR = {
  number: 4242,
  url: "https://github.com/example-org/widgets/pull/4242",
  draft: false,
  merged: false,
  state: "open",
};

/** タスクの詳細の応答にだけ、PR を足す（PR のあるタスクとして描かせる）。loginAs の前に呼ぶ。 */
export async function withPr(page: Page, taskId: string): Promise<void> {
  await page.route(new RegExp(`/dashboard/api/tasks/${taskId}(\\?.*)?$`), async (route) => {
    const res = await route.fetch({
      headers: { ...route.request().headers(), "sec-fetch-site": "same-origin" },
    });
    if (res.status() !== 200) {
      await route.fulfill({ response: res });
      return;
    }
    const body = (await res.json()) as { task: { pr: unknown } };
    body.task.pr = FAKE_PR;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

export interface ChecksBody {
  head_sha: string | null;
  state: "none" | "passing" | "failing" | "pending" | "unreadable";
  checks: {
    name: string;
    kind: "check_run" | "status";
    status: "queued" | "in_progress" | "completed";
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
    url: string | null;
  }[];
  truncated: boolean;
  partial: boolean;
}

/**
 * タスクの CI（/checks）の応答を差し替える。偽 GitHub の PR は github.com の URL を持たないので、
 * 画面の挙動（並び・タブ・リンク・文言・更新の間隔）はこの応答で確かめる（gateway 側は Unit が確かめる）。
 * loginAs の前に呼ぶ。set で応答を変えられ、calls は取りに来た回数。
 */
export async function mockChecks(page: Page, taskId: string, initial: ChecksBody) {
  let body = initial;
  const ctl = {
    calls: 0,
    set(next: ChecksBody) {
      body = next;
    },
  };
  await page.route(new RegExp(`/dashboard/api/tasks/${taskId}/checks$`), async (route) => {
    ctl.calls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return ctl;
}
