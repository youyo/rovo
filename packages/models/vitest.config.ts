import { defineConfig } from "vitest/config";

// 純粋関数とカタログ（JSON）の読み取りだけ。workerd は使わない。
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
