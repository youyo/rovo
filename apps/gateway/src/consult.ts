import type { AuditFields } from "@rovo/audit";
import type { Effort } from "@rovo/models";
import { parseConsultEffort, supportedEfforts, supportsToolCalling } from "@rovo/models";
import { z } from "zod";
import type { ConsultRequest } from "./agent/contract";
import { auditFromWorker } from "./audit-sink";
import type { ConsultValue } from "./consult-answer";
import { effortRejection, type ModelEnv, resolveModel } from "./models";
import type { ProviderKeysDeps } from "./provider-keys";
import type { ErrorCode, Principal, ServiceResult } from "./tasks/service";
import { isConsultId, newConsultId } from "./tasks/ulid";
import { MAX_PENDING_CONSULTS, type UserDO } from "./tasks/user-do";
import { consultInputSchema, MAX_WAIT_SECONDS, parseTimeoutSeconds } from "./tasks/validation";
import { testConsultTiming } from "./test-routes";

/**
 * consult（D10。セカンドオピニオン）のユースケース層。docs/specs/consult-pending.md。
 *
 * 流れ: 入力の検証 → UserDO で月の枠から CONSULT_BUDGET_USD を予約（足りなければ budget_exceeded、
 * 開いている consult が上限なら concurrency_limit）→ UserDO に開始を頼む（モデルの呼び出し = AgentDO.consult は
 * UserDO が裏で待ち続け、完了したときに答えの保存・実費の精算・索引の確定を UserDO の中で行う）→
 * 最大 CONSULT_WAIT_MS（50 秒）だけ答えを待つ。間に合えば今と同じ形で返し、間に合わなければ pending を返して、
 * 答えは consult_result で受け取る。精算はこのリクエストの寿命に載らない（クライアントが切れても UserDO が済ませる）。
 * rovo は会話を保存しない（答えは UserDO に最長 1 時間だけ残る。50 秒以内に返した答えは返した時点で消す）。
 *
 * 道具（tools: web_search / web_fetch。#135）を指定したときは、tool calling に対応するモデルか（packages/models）を予約の前に確かめ、
 * CONSULT_TOOLS_BUDGET_USD を予約し、UserDO がモデルとの往復（道具の実行を含む）を裏で回す。
 */

export type { ConsultValue } from "./consult-answer";

/** pending（まだ裏で続いている）。成功の形には status が無く、pending のときだけ status を持つ */
export type ConsultPendingValue = {
  consult_id: string;
  status: "pending";
  retry_after_seconds?: number;
};

/** consult_result の応答（成功の形に consult_id と status を足したものが done） */
export type ConsultResultValue =
  | ConsultPendingValue
  | ({ consult_id: string; status: "done" } & ConsultValue)
  | {
      consult_id: string;
      status: "failed";
      error: { code: ErrorCode; message: string; retry_after_seconds?: number };
      cost_usd: number;
    };

export type ConsultDeps = {
  users: (
    githubUserId: number,
  ) => Pick<
    DurableObjectStub<UserDO>,
    "reserveConsult" | "startConsult" | "waitConsult" | "discardConsult" | "settleConsult"
  >;
  /** consult が答えを待つ上限（ms）。Unit が実時間を待たないために差し替える */
  waitMs?: number;
};

type ConsultEnv = Pick<Env, "USER_DO" | "ENVIRONMENT" | "OAUTH_KV"> & ModelEnv;

/** consult が答えを待つ上限。task_wait の MAX_WAIT_SECONDS と同じ（クライアントの打ち切り 60 秒に収める）。 */
export const CONSULT_WAIT_MS = MAX_WAIT_SECONDS * 1000;

const NOT_FOUND = "consult not found (it may have expired)";

const consultResultInputSchema = z.object({
  consult_id: z.string(),
  timeout_seconds: z.number().optional(),
});

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

export function createConsultService(
  env: ConsultEnv,
  overrides: Partial<ConsultDeps> = {},
  /** プロバイダーキーの取得（Unit が fetch / 時計を差し替える） */
  providerKeys?: ProviderKeysDeps,
) {
  const deps: ConsultDeps = {
    users: overrides.users ?? ((id) => env.USER_DO.getByName(String(id))),
    ...(overrides.waitMs !== undefined ? { waitMs: overrides.waitMs } : {}),
  };

  /** consult が答えを待つ上限（ms）。Unit の差し替え > E2E の差し替え（test 環境のみ）> 既定の 50 秒 */
  async function waitMs(): Promise<number> {
    if (deps.waitMs !== undefined) return deps.waitMs;
    return (await testConsultTiming(env))?.waitMs ?? CONSULT_WAIT_MS;
  }

  return {
    async consult(
      principal: Principal,
      rawInput: unknown,
    ): Promise<ServiceResult<ConsultValue | ConsultPendingValue>> {
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
      // 使えるモデルの外・キーが無いプロバイダーのモデルは、予約より前に拒否する。省略時は実際に使うモデルを決める
      const resolved = await resolveModel(env, input.model, providerKeys);
      if (!resolved.ok) return fail(resolved.code, resolved.message);
      const model = resolved.model;
      // 道具（#135）。空の配列は道具なしと同じ。tool calling に対応しないモデルは予約の前に拒否する（fail closed）
      const tools = input.tools ?? [];
      if (tools.length > 0 && !supportsToolCalling(model)) {
        return fail(
          "invalid_input",
          `the model ${model} does not support tools (tool calling); choose a model whose tool_calling is true in models_list, or call consult without tools`,
        );
      }

      // 思考レベル: 指定があればモデルで検査（対応外は invalid_input）。省略は CONSULT_EFFORT（未設定・不正は medium）。
      // 既定をモデルが受け付けないときは、モデルごとの既定に戻す（agent に effort を渡さない）
      let effort: Effort | undefined = input.effort;
      if (effort !== undefined) {
        const rejection = effortRejection(model, effort);
        if (rejection !== undefined) return fail("invalid_input", rejection);
      } else {
        const def = parseConsultEffort(env.CONSULT_EFFORT);
        if (def.invalid) console.error("consult_effort_ignored");
        if (supportedEfforts(model).includes(def.effort)) effort = def.effort;
      }

      const users = deps.users(principal.githubUserId);
      const consultId = newConsultId();
      const reserved = await users.reserveConsult(
        consultId,
        model,
        { id: principal.githubUserId, login: principal.login },
        ...(tools.length > 0 ? [{ tools: true }] : []),
      );
      if (!reserved.ok) {
        if (reserved.code === "budget_exceeded") {
          return fail("budget_exceeded", "the monthly budget is insufficient for a consult");
        }
        if (reserved.code === "concurrency_limit") {
          return fail(
            "concurrency_limit",
            `too many consults are pending (limit ${MAX_PENDING_CONSULTS}); get an answer with consult_result, or retry later (budget_status shows pending_consults)`,
          );
        }
        return fail("internal", "internal error");
      }

      const audit: AuditFields = {
        userId: principal.githubUserId,
        caller: "parent",
        model,
        consult_id: consultId,
        ...(tools.length > 0 ? { kind: "tools" } : {}),
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
        ...(effort !== undefined ? { effort } : {}),
        // 予約した額と同じ値を渡す（食い違えば、予約より多く使えてしまう / 予約が余る）
        budgetUsd: reserved.reserved_usd,
      };

      // 裏のモデル呼び出しと精算は UserDO の中で完結する（このリクエストの寿命に載らない）
      let started: Awaited<ReturnType<typeof users.startConsult>>;
      try {
        started = await users.startConsult(request, ...(tools.length > 0 ? [{ tools }] : []));
      } catch (e) {
        // 開始できたか分からない。予約は UserDO の期限（CONSULT_STALE_AFTER_MS）が予約額で閉じる
        console.error("consult_start_error", e instanceof Error ? e.name : typeof e);
        return fail("internal", "internal error");
      }
      if (!started.ok) {
        // モデルは呼ばれていない。費用は 0 で閉じる
        await users.settleConsult(consultId, 0);
        await auditFromWorker(env, "consult_finished", { ...audit, cost_usd: 0 });
        return fail("internal", "internal error");
      }

      let waited: Awaited<ReturnType<typeof users.waitConsult>>;
      try {
        waited = await users.waitConsult(consultId, principal.githubUserId, await waitMs());
      } catch (e) {
        // 待つ呼び出しが切れた（UserDO の作り直しなど）。裏の処理の結果は consult_result で確かめられる
        console.error("consult_wait_error", e instanceof Error ? e.name : typeof e);
        return { ok: true, value: { consult_id: consultId, status: "pending" } };
      }
      if (!waited.ok) return fail("internal", "internal error");
      if (waited.status === "pending") {
        return {
          ok: true,
          value: {
            consult_id: consultId,
            status: "pending",
            ...(waited.retry_after_seconds !== undefined
              ? { retry_after_seconds: waited.retry_after_seconds }
              : {}),
          },
        };
      }
      // 50 秒以内に終わった答えは、受け取れたここで UserDO から消す（本文を残さない）。待っている間にクライアントが切れて
      // ここに来なかった答えは消えず、保持期間まで consult_result で取れる。消せなくても答えは返す（期限で消える）
      try {
        await users.discardConsult(consultId, principal.githubUserId);
      } catch (e) {
        console.error("consult_discard_error", e instanceof Error ? e.name : typeof e);
      }
      if (waited.status === "failed") {
        return fail(waited.error.code, waited.error.message, waited.error.retry_after_seconds);
      }
      return { ok: true, value: waited.value };
    },

    /** consult の答えを受け取る（long polling。最大 50 秒）。他人・期限切れ・不正な ID は同じ not_found */
    async consultResult(
      principal: Principal,
      rawInput: unknown,
    ): Promise<ServiceResult<ConsultResultValue>> {
      const parsed = consultResultInputSchema.safeParse(rawInput ?? {});
      if (!parsed.success) {
        return fail(
          "invalid_input",
          parsed.error.issues
            .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
            .join("; "),
        );
      }
      const timeout = parseTimeoutSeconds(parsed.data.timeout_seconds);
      if (!timeout.ok) {
        return fail("invalid_input", "timeout_seconds: must be an integer of 0 or more");
      }
      const consultId = parsed.data.consult_id;
      if (!isConsultId(consultId)) return fail("not_found", NOT_FOUND);

      const waited = await deps
        .users(principal.githubUserId)
        .waitConsult(consultId, principal.githubUserId, timeout.value * 1000);
      if (!waited.ok) return fail("not_found", NOT_FOUND);
      if (waited.status === "pending") {
        return {
          ok: true,
          value: {
            consult_id: consultId,
            status: "pending",
            ...(waited.retry_after_seconds !== undefined
              ? { retry_after_seconds: waited.retry_after_seconds }
              : {}),
          },
        };
      }
      if (waited.status === "failed") {
        return {
          ok: true,
          value: {
            consult_id: consultId,
            status: "failed",
            error: waited.error,
            cost_usd: waited.cost_usd,
          },
        };
      }
      return { ok: true, value: { consult_id: consultId, status: "done", ...waited.value } };
    },
  };
}

export type ConsultService = ReturnType<typeof createConsultService>;
