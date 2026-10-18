import { FakeGitHubApp } from "./fake-github-app";

/**
 * Unit（workerd）で TaskDO が叩く偽の GitHub App。DO とテストファイルは同じ isolate で動くので、
 * globalThis に 1 つだけ持つ（モジュールが別々に読み込まれても同じものを指す）。
 */
export const UNIT_APP_ID = "424242";
export const UNIT_REPO = { id: 4242, fullName: "acme/widgets", installationId: 77 };

type Holder = { __rovoFakeApp?: FakeGitHubApp };

export interface UnitGitHubEnv {
  TEST_APP_PUBLIC_KEY: string;
}

export function getFakeApp(env: UnitGitHubEnv): FakeGitHubApp {
  const g = globalThis as unknown as Holder;
  if (!g.__rovoFakeApp) {
    g.__rovoFakeApp = new FakeGitHubApp({
      appId: UNIT_APP_ID,
      publicKeyPem: env.TEST_APP_PUBLIC_KEY,
    });
    g.__rovoFakeApp.seedRepo(UNIT_REPO);
  }
  return g.__rovoFakeApp;
}

/** 設定（Draft 不可・障害・時計）を初期状態に戻す。リポジトリは残す（ブランチ名はタスクごとに別）。 */
export function resetFakeApp(env: UnitGitHubEnv): FakeGitHubApp {
  const app = getFakeApp(env);
  app.reset();
  app.now = Date.now;
  app.seedRepo(UNIT_REPO);
  return app;
}

export function fakeAppFetch(env: UnitGitHubEnv): typeof fetch {
  return async (input, init) => {
    const app = getFakeApp(env);
    const r = await app.handle(new Request(input, init));
    return r ?? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
}
