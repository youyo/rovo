import type { TestProject } from "vitest/node";
import { startGateway } from "./global-setup";

// LOGS（R2）を外した gateway。本番の wrangler.jsonc と同じ構成（r2_buckets なし）。
export default function setup(project: TestProject) {
  return startGateway(project, { logs: false });
}
