import type { AuditFields } from "@rovo/audit";
import type { AgentRpc, ConsultRequest, ConsultResult } from "./agent/contract";
import { auditFromWorker } from "./audit-sink";
import { agentModelsOf, defaultModelOf } from "./models";
import type { ErrorCode, Principal, ServiceResult } from "./tasks/service";
import { newConsultId } from "./tasks/ulid";
import type { UserDO } from "./tasks/user-do";
import { consultInputSchema } from "./tasks/validation";
import { withTestScripts } from "./test-routes";

/**
 * consult（D10。セカンドオピニオン）のユースケース層。
 *
 * 流れ: 入力の検証 → UserDO で月の枠から CONSULT_BUDGET_USD を予約（足りなければ budget_exceeded）→
 * AgentDO.consult（consult ごとのインスタンス `consult-<ULID>`。AI バインディングと thinking の補正は AgentDO にある）→
 * 実費で精算。AgentDO が失敗を返したときはかかった費用で、例外で終わって実費が分からないときは予約額で精算する
 * （予約より少なく数えない）。rovo は会話を保存しない。
 */

export type ConsultValue = {
  text: string;
  model: string;
  usage: { input: number; output: number; cache_read: number; cache_write: number };
  cost_usd: number;
};

export type ConsultAgent = { consult(request: ConsultRequest): Promise<ConsultResult> };

export type ConsultDeps = {
  users: (
    githubUserId: number,
  ) => Pick<DurableObjectStub<UserDO>, "reserveConsult" | "settleConsult">;
  agent: (consultId: string) => ConsultAgent;
};

type ConsultEnv = Pick<Env, "USER_DO" | "AGENT_DO" | "ENVIRONMENT" | "OAUTH_KV"> & {
  AGENT_MODEL?: string;
  AGENT_MODELS?: string;
};

/** AgentDO の応答を待つ上限。超えたら実費不明として予約額で精算する。 */
export const CONSULT_TIMEOUT_MS = 120_000;

function fail(code: ErrorCode, message: string, retryAfter?: number): ServiceResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
    },
  };
}

const UPSTREAM_RETRY_AFTER_SECONDS = 30;

function isConsultResult(v: unknown): v is ConsultResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const finiteCost = typeof r.costUsd === "number" && Number.isFinite(r.costUsd) && r.costUsd >= 0;
  if (r.ok === true) {
    const u = r.usage as Record<string, unknown> | undefined;
    return (
      finiteCost &&
      typeof r.text === "string" &&
      typeof r.model === "string" &&
      typeof u === "object" &&
      u !== null &&
      ["input", "output", "cacheRead", "cacheWrite"].every(
        (k) => typeof u[k] === "number" && Number.isFinite(u[k]) && (u[k] as number) >= 0,
      )
    );
  }
  return r.ok === false && finiteCost && typeof r.code === "string";
}

export function createConsultService(env: ConsultEnv, overrides: Partial<ConsultDeps> = {}) {
  const deps: ConsultDeps = {
    users: overrides.users ?? ((id) => env.USER_DO.getByName(String(id))),
    agent:
      overrides.agent ??
      ((consultId) =>
        // test のときだけ、E2E が預けた台本を渡す（それ以外は元のスタブのまま）
        withTestScripts(
          env as unknown as Env,
          env.AGENT_DO.getByName(consultId) as unknown as AgentRpc,
        )),
  };

  return {
    async consult(principal: Principal, rawInput: unknown): Promise<ServiceResult<ConsultValue>> {
      const parsed = consultInputSchema.safeParse(rawInput ?? {});
      if (!parsed.success) {
        return fail(
          "invalid_input",
          parsed.error.issues
            .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
            .join("; "),
        );
      }
      const input = parsed.data;
      const model = input.model ?? defaultModelOf(env);
      if (!agentModelsOf(env).includes(model)) {
        return fail(
          "invalid_input",
          `model: "${model}" is not available; call models_list for the models you can use`,
        );
      }

      const users = deps.users(principal.githubUserId);
      const consultId = newConsultId();
      const reserved = await users.reserveConsult(consultId);
      if (!reserved.ok) {
        return reserved.code === "budget_exceeded"
          ? fail("budget_exceeded", "the monthly budget is insufficient for a consult")
          : fail("internal", "internal error");
      }

      const audit: AuditFields = {
        userId: principal.githubUserId,
        caller: "parent",
        model,
        consult_id: consultId,
      };
      await auditFromWorker(env, "consult_started", audit);

      const request: ConsultRequest = {
        consultId,
        userId: String(principal.githubUserId),
        model,
        ...(input.system !== undefined ? { system: input.system } : {}),
        messages: input.messages,
        ...(input.max_output_tokens !== undefined
          ? { maxOutputTokens: input.max_output_tokens }
          : {}),
        // 予約した額と同じ値を渡す（食い違えば、予約より多く使えてしまう / 予約が余る）
        budgetUsd: reserved.reserved_usd,
      };

      let result: ConsultResult | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          deps.agent(consultId).consult(request),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("consult timeout")), CONSULT_TIMEOUT_MS);
          }),
        ]);
      } catch (e) {
        console.error("consult_error", e instanceof Error ? e.name : typeof e);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      // 例外・タイムアウト・壊れた応答: 実費が分からないので予約額で精算する
      if (result === undefined || !isConsultResult(result)) {
        await users.settleConsult(consultId, null);
        await auditFromWorker(env, "consult_finished", {
          ...audit,
          cost_usd: reserved.reserved_usd,
        });
        return result === undefined
          ? fail(
              "upstream_unavailable",
              "the consult is temporarily unavailable; retry later",
              UPSTREAM_RETRY_AFTER_SECONDS,
            )
          : fail("internal", "internal error");
      }

      await users.settleConsult(consultId, result.costUsd);
      await auditFromWorker(env, "consult_finished", { ...audit, cost_usd: result.costUsd });

      if (!result.ok) {
        // モデルがリクエストの中身を拒否した（4xx）。待っても直らないので retry_after_seconds は付けない
        if (result.code === "model_rejected") {
          return fail(
            "model_rejected",
            "the model rejected the request (a 4xx response, e.g. invalid_request_error); retrying the same request will not help. Change the input or the model",
          );
        }
        if (result.code === "model_error") {
          return fail(
            "upstream_unavailable",
            "the model call failed; retry later",
            UPSTREAM_RETRY_AFTER_SECONDS,
          );
        }
        return fail("invalid_input", `consult was rejected: ${result.code}. ${result.message}`);
      }
      return {
        ok: true,
        value: {
          text: result.text,
          model: result.model,
          usage: {
            input: result.usage.input,
            output: result.usage.output,
            cache_read: result.usage.cacheRead,
            cache_write: result.usage.cacheWrite,
          },
          cost_usd: result.costUsd,
        },
      };
    },
  };
}

export type ConsultService = ReturnType<typeof createConsultService>;
