import { runInDurableObject } from "cloudflare:test";
import type { ConsultRequest, ConsultResult } from "../../src/agent/contract";
import { type ConsultDeps, createConsultService } from "../../src/consult";
import type { ProviderKeysDeps } from "../../src/provider-keys";
import { userStub } from "../unit/helpers";

type UserStub = ReturnType<typeof userStub>;
type ConsultEnv = Parameters<typeof createConsultService>[0];

/** UserDO が裏で呼ぶ AgentDO の代わり（UserDO の consultAgent に差し込む）。 */
export type ConsultAgentFactory = (consultId: string) => {
  consult(request: ConsultRequest): Promise<ConsultResult>;
};

/** UserDO のテスト用の差し込み口（now・consultAgent・consultBackgroundTimeoutMs・env）。 */
type Tunable = {
  consultAgent: ConsultAgentFactory;
  consultBackgroundTimeoutMs: number;
  env: unknown;
};

export const okResult = (
  over: Partial<Extract<ConsultResult, { ok: true }>> = {},
): ConsultResult => ({
  ok: true,
  text: "answer",
  model: "anthropic/claude-sonnet-5-5",
  usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.0012,
  ...over,
});

/**
 * 呼び出しごとに「いつ返すか」をテストが決められる偽の AgentDO。
 * 返事は、テストが release で置いた値を、UserDO の側（呼び出しの中）が一定間隔で読みに行く形にする。
 * Promise をテストから直接 resolve すると、別の Durable Object の文脈からの I/O になって workerd に拒否される。
 */
export function controllableAgent() {
  const calls: ConsultRequest[] = [];
  const names: string[] = [];
  const released = new Map<string, ConsultResult | Error>();
  return {
    calls,
    names,
    factory: ((consultId: string) => ({
      consult: async (request: ConsultRequest): Promise<ConsultResult> => {
        calls.push(request);
        names.push(consultId);
        for (let i = 0; i < 3_000; i++) {
          const r = released.get(request.consultId);
          if (r !== undefined) {
            if (r instanceof Error) throw r;
            return r;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("controllableAgent: never released");
      },
    })) as ConsultAgentFactory,
    /** その consult の AgentDO の呼び出しを、この結果（または例外）で終わらせる */
    release(consultId: string, result: ConsultResult | Error = okResult()) {
      released.set(consultId, result);
    },
  };
}

/** UserDO（生きているインスタンス）の差し込み口を書き換える。 */
export async function tuneUserDo(
  stub: UserStub,
  opts: {
    agent?: ConsultAgentFactory;
    backgroundTimeoutMs?: number;
    envOverride?: Record<string, unknown>;
  },
): Promise<void> {
  await runInDurableObject(stub, (i) => {
    const u = i as unknown as Tunable;
    if (opts.agent) u.consultAgent = opts.agent;
    if (opts.backgroundTimeoutMs !== undefined) {
      u.consultBackgroundTimeoutMs = opts.backgroundTimeoutMs;
    }
    if (opts.envOverride) u.env = { ...(u.env as object), ...opts.envOverride };
  });
}

/**
 * consult サービスと、その相手の UserDO の裏の呼び出し（AgentDO）を、まとめて差し替える。
 * 裏のモデル呼び出しは UserDO の中で走るので、AgentDO の代わりは UserDO に差し込む（そのユーザーの DO に、最初の呼び出しの前に 1 回）。
 */
export function consultServiceWith(
  env: ConsultEnv,
  agent: ConsultAgentFactory,
  deps: Partial<Omit<ConsultDeps, "users">> = {},
  providerKeys?: ProviderKeysDeps,
) {
  const users = (githubUserId: number) => {
    const stub = userStub(githubUserId);
    let ready: Promise<void> | undefined;
    return new Proxy(stub, {
      get(target, prop) {
        return (...args: unknown[]) => {
          ready ??= tuneUserDo(stub, { agent, envOverride: { ENVIRONMENT: env.ENVIRONMENT } });
          return ready.then(() =>
            (target as unknown as Record<string, (...a: unknown[]) => unknown>)[String(prop)]?.(
              ...args,
            ),
          );
        };
      },
    });
  };
  return createConsultService(env, { ...deps, users: users as never }, providerKeys);
}
