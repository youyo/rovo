import type {
  CancelResult,
  EventsPage,
  ResultDto,
  StartResult,
  TaskSpec,
} from "../../src/agent/types";
import type { ScriptStep } from "../../src/pi/scripted-provider";
import { e2eLog } from "./e2e-log";

/** wrangler dev 上の E2E 用ルート（ENVIRONMENT=test のときだけ有効）経由で AgentDO を操作する。 */
export function agentClient(baseUrl: string, name: string) {
  const send = async (action: string, body: Record<string, unknown>, timeoutMs: number) => {
    const res = await fetch(`${baseUrl}/test/agent/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${action}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  // 所要時間を残す。events は待ち合わせで何度も呼ぶので記録しない
  const op = (action: string, body: Record<string, unknown> = {}, timeoutMs = 280_000) =>
    action === "events"
      ? send(action, body, timeoutMs)
      : e2eLog().timed(`agent ${name} ${action}`, () => send(action, body, timeoutMs));
  const api = {
    name,
    setScript: (key: string, script: ScriptStep[]) => op("set-script", { key, script }),
    start: (spec: TaskSpec) => op("start", { spec }) as Promise<StartResult>,
    cancel: () => op("cancel") as Promise<CancelResult>,
    getEvents: (afterSeq = 0, limit = 100) =>
      op("events", { afterSeq, limit }) as Promise<EventsPage>,
    getResult: () => op("result") as Promise<ResultDto>,
    debug: () => op("debug") as Promise<{ deadlineAt: number }>,
    /** 全イベントを limit 件ずつのページングで集める。 */
    async allEvents(limit = 100) {
      const out: { seq: number; type: string; data: Record<string, unknown> }[] = [];
      let after = 0;
      for (;;) {
        const page = await api.getEvents(after, limit);
        for (const e of page.events) {
          out.push({
            seq: e.seq,
            type: e.type,
            data: JSON.parse(e.data) as Record<string, unknown>,
          });
        }
        after = page.throughSeq;
        if (!page.hasMore) return out;
      }
    },
    async waitForTerminal(timeoutMs = 240_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const page = await api.getEvents(0, 1);
        if (
          page.phase === "completed" ||
          page.phase === "failed" ||
          page.phase === "cancelled" ||
          page.phase === "budget_exceeded"
        ) {
          return page.phase;
        }
        if (Date.now() > deadline) throw new Error(`timeout; phase=${page.phase}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    },
  };
  return api;
}
