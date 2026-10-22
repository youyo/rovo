import { defineConfig } from "@playwright/test";

// ダッシュボードのブラウザ E2E（docs/specs/dashboard.md D17）。Chromium だけ。
// 起動は e2e/global-setup.ts: gateway の E2E と同じ仕組み（apps/gateway/test/support/gateway-server.ts）で
// wrangler dev + 偽 GitHub + 偽 agent Worker を立て、ビルド済みの dist を実際の assets から配信する。
// 偽 GitHub の状態を共有するので workers: 1（既存の vitest の E2E と同じ）。
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    browserName: "chromium",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
  },
});
