import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { resetFakeApp, type UnitGitHubEnv } from "../support/unit-github";

// 偽の GitHub App の設定（Draft 不可・障害・時計）は、テストごとに初期状態へ戻す。
beforeEach(() => {
  resetFakeApp(env as unknown as UnitGitHubEnv);
});
