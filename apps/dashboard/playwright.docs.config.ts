import { defineConfig } from "@playwright/test";

// README 用のスクリーンショット専用の設定（mise run docs:screenshots）。
// 通常の E2E（playwright.config.ts。testMatch は *.spec.ts）には含めず、*.docs.ts だけを流す。
// 起動の仕組みは通常の E2E と同じ（wrangler dev + 偽 GitHub + 偽 agent）だが、データは撮影専用の架空のもの（e2e/docs-global-setup.ts）。
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.docs.ts",
  globalSetup: "./e2e/docs-global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 1,
  },
});
