import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningWrangler, startWrangler } from "../support/wrangler";

// Gateway と Agent を複数設定の wrangler dev（-c gateway -c agent）で同時に起動し、
// Gateway の script_name 付き DO バインディングから Agent の DO へ RPC が通ることを確かめる。
// 必ず両方をローカルで同時に起動する（片方だけだと本番の DO を参照する known issue がある）。
let wrangler: RunningWrangler;
let persistDir: string;

beforeAll(async () => {
  persistDir = mkdtempSync(join(tmpdir(), "rovo-link-e2e-"));
  wrangler = await startWrangler({
    configs: ["apps/gateway/wrangler.jsonc", "apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test" },
    // --var は primary（gateway）にしか効かないので、agent 側の ENVIRONMENT=test は .dev.vars で渡す
    configVars: { "apps/agent/wrangler.jsonc": { ENVIRONMENT: "test" } },
    readyPath: "/",
    persistDir,
  });
});

afterAll(async () => {
  await wrangler?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

describe("Gateway → Agent の DO RPC", () => {
  it("Gateway の AGENT_DO（script_name 付き）から AgentDO.ping が呼べる", async () => {
    const res = await fetch(`${wrangler.baseUrl}/__spike/agent-ping?m=hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("agent:hello");
  });
});
