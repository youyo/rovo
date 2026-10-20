import { defineConfig } from "vitest/config";

// スキーマと fixtures の検証だけ。純粋関数なので workerd は使わない。
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
