import { defineConfig } from "vitest/config";

// 純粋関数だけのパッケージ。workerd も Node 固有の API も使わないので、素の vitest で足りる。
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
