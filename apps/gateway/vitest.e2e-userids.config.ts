import { defineConfig } from "vitest/config";

// ALLOWED_USER_IDS だけの認可の構成（ALLOWED_ORG / ALLOWED_TEAM は空）の gateway の E2E。
// 通常の E2E（vitest.e2e.config.ts）と同じ起動で、var だけが違う。
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.userids.test.ts"],
    fileParallelism: false,
    globalSetup: ["test/e2e/global-setup-userids.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
