import { z } from "zod";
import type { TaskStatus } from "./state";
import type { ResultView, TaskDO, TaskEvent, TaskView } from "./task-do";
import { isTaskId, ulid } from "./ulid";
import type { UserDO } from "./user-do";
import {
  computeFingerprint,
  exceedsInputLimit,
  isValidIdempotencyKey,
  type TaskInput,
  taskInputSchema,
} from "./validation";

/**
 * ユースケース層。Gateway（MCP ツール）が UserDO / TaskDO を正しい順序で呼ぶための関数群。
 * MCP ツールからは後でここを呼ぶ（M4）。認可（team 所属・Installation・push 権限）は
 * GitHub 連携（M3）が担い、通った後の repository_id / installation_id を start に渡す。
 */

export type Principal = { githubUserId: number; login: string };

export type ErrorCode =
  | "not_found"
  | "conflict"
  | "expired"
  | "concurrency_limit"
  | "budget_exceeded"
  | "not_ready"
  | "upstream_unavailable"
  | "invalid_cursor"
  | "invalid_input";

export type ServiceError = { code: ErrorCode; message: string; retry_after_seconds?: number };
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export type TaskServiceDeps = {
  users: (githubUserId: number) => DurableObjectStub<UserDO>;
  tasks: (taskId: string) => DurableObjectStub<TaskDO>;
};

export type StartOptions = { repositoryId?: number | null; installationId?: number | null };

export type StartValue = {
  task_id: string;
  status: TaskStatus;
  draft_pr_url: string | null;
  note: string;
};

export const START_NOTE =
  "Phase 3: 作業ブランチ agent/task-<id> と Draft PR を作り、子エージェントが Sandbox で編集・テスト・commit・push します。draft_pr_url は作成前なので null です。PR の URL は task_status・task_result・イベント draft_pr_created で返ります。成果は終端になってから task_result で取得できます（PR はマージされず Draft のままです）。";

export type StatusValue = Omit<TaskView, "owner_id">;
export type WaitValue = {
  task_id: string;
  status: TaskStatus;
  cursor: string;
  events: TaskEvent[];
  retry_after_seconds?: number;
};
export type CancelValue = { task_id: string; status: TaskStatus };
export type ResultValue = { task_id: string } & ResultView;

function fail(
  code: ErrorCode,
  message: string,
  extra: Partial<ServiceError> = {},
): ServiceResult<never> {
  return { ok: false, error: { code, message, ...extra } };
}

const NOT_FOUND = "task not found";

const startInputSchema = taskInputSchema.extend({
  idempotency_key: z.unknown().optional(),
});

export type CheckedStartInput = { input: TaskInput; idempotency_key: string | undefined };

/**
 * task_start の入力検証（形式・サイズ・idempotency_key）。外部（GitHub / DO）を呼ぶ前に行う。
 */
export function checkStartInput(rawInput: unknown): ServiceResult<CheckedStartInput> {
  const parsed = startInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const { idempotency_key: key, ...input } = parsed.data;
  if (key !== undefined && !isValidIdempotencyKey(key)) {
    return fail("invalid_input", "idempotency_key must match [A-Za-z0-9_-]{1,128}");
  }
  if (exceedsInputLimit(input)) return fail("invalid_input", "input is too large");
  return { ok: true, value: { input, idempotency_key: key } };
}

export function createTaskService(
  env: Pick<Env, "USER_DO" | "TASK_DO">,
  overrides: Partial<TaskServiceDeps> = {},
) {
  const deps: TaskServiceDeps = {
    users: overrides.users ?? ((id) => env.USER_DO.getByName(String(id))),
    tasks: overrides.tasks ?? ((id) => env.TASK_DO.getByName(id)),
  };

  return {
    /**
     * UserDO.reserve → TaskDO.ensureCreated の順に呼ぶ。
     * ensureCreated が失敗（例外）しても予約は解放しない。成否が分からないため、
     * クライアントは同じ idempotency_key で再試行する。
     */
    async start(
      principal: Principal,
      rawInput: unknown,
      options: StartOptions = {},
    ): Promise<ServiceResult<StartValue>> {
      const checked = checkStartInput(rawInput);
      if (!checked.ok) return checked;
      const { idempotency_key: key, input } = checked.value;
      // 省略時はサーバーで生成する（再試行の重複排除は保証しない）。':' を含むので利用者のキーと衝突しない。
      const requestKey = key ?? `auto:${ulid()}`;

      const fingerprint = await computeFingerprint(input);
      const reserved = await deps.users(principal.githubUserId).reserve(requestKey, fingerprint);
      if (!reserved.ok) {
        switch (reserved.code) {
          case "conflict":
            return fail("conflict", "idempotency_key was already used with different input");
          case "budget_exceeded":
            return fail("budget_exceeded", "the monthly budget is insufficient for a new task");
          default:
            return fail("concurrency_limit", "another task is already running for this user");
        }
      }

      const created = await deps.tasks(reserved.task_id).ensureCreated({
        ...input,
        task_id: reserved.task_id,
        owner_id: principal.githubUserId,
        owner_login: principal.login,
        repository_id: options.repositoryId ?? null,
        installation_id: options.installationId ?? null,
      });
      if (!created.ok) {
        switch (created.code) {
          case "expired":
            return fail("expired", "this idempotency_key has expired; use a new key");
          case "conflict":
            return fail("conflict", "idempotency_key was already used with different input");
          default:
            return fail("invalid_input", "invalid task input");
        }
      }
      // 子エージェントへの start を 1 回試みる。失敗・応答喪失でも TaskDO の alarm が再送するので、
      // ここで失敗しても task_start は成功として返す（利用者の再試行に頼らない）。
      let status = created.task.status;
      try {
        const advanced = await deps.tasks(reserved.task_id).advance();
        if (advanced) status = advanced.status;
      } catch (e) {
        console.error("task_start_advance_error", e instanceof Error ? e.name : typeof e);
      }
      return {
        ok: true,
        value: {
          task_id: created.task.task_id,
          status,
          draft_pr_url: created.task.draft_pr_url,
          note: START_NOTE,
        },
      };
    },

    async status(principal: Principal, taskId: string): Promise<ServiceResult<StatusValue>> {
      if (!isTaskId(taskId)) return fail("not_found", NOT_FOUND);
      const r = await deps.tasks(taskId).getStatus(principal.githubUserId);
      if (!r.ok) return fail("not_found", NOT_FOUND);
      const { owner_id: _owner, ...view } = r.task;
      return { ok: true, value: view };
    },

    async wait(
      principal: Principal,
      args: { task_id: string; cursor?: string; timeout_seconds?: number },
    ): Promise<ServiceResult<WaitValue>> {
      if (!isTaskId(args.task_id)) return fail("not_found", NOT_FOUND);
      const r = await deps
        .tasks(args.task_id)
        .wait(principal.githubUserId, args.cursor, args.timeout_seconds);
      if (!r.ok) {
        switch (r.code) {
          case "invalid_cursor":
            return fail("invalid_cursor", "cursor is invalid");
          case "invalid_input":
            return fail("invalid_input", "timeout_seconds must be an integer >= 0");
          default:
            return fail("not_found", NOT_FOUND);
        }
      }
      return {
        ok: true,
        value: {
          task_id: args.task_id,
          status: r.status,
          cursor: r.cursor,
          events: r.events,
          ...(r.retry_after_seconds !== undefined
            ? { retry_after_seconds: r.retry_after_seconds }
            : {}),
        },
      };
    },

    /**
     * TaskDO を CANCELLED に確定する（cancel の配送意図も同じトランザクションで記録される）。
     * その後 advance で cancel を 1 回配送してみる。停止が確認できなくても成功として返す
     * （TaskDO の alarm が stopped:true まで再送する）。同時実行の枠は、停止確認の後に TaskDO が解放する。
     */
    async cancel(principal: Principal, taskId: string): Promise<ServiceResult<CancelValue>> {
      if (!isTaskId(taskId)) return fail("not_found", NOT_FOUND);
      const task = deps.tasks(taskId);
      const r = await task.cancel(principal.githubUserId);
      if (!r.ok) return fail("not_found", NOT_FOUND);
      try {
        await task.advance();
      } catch (e) {
        console.error("task_cancel_advance_error", e instanceof Error ? e.name : typeof e);
      }
      return { ok: true, value: { task_id: taskId, status: r.status } };
    },

    /** 終端（かつ AgentDO の停止確認済み）のタスクの成果を返す。それ以外は not_ready。 */
    async result(principal: Principal, taskId: string): Promise<ServiceResult<ResultValue>> {
      if (!isTaskId(taskId)) return fail("not_found", NOT_FOUND);
      const r = await deps.tasks(taskId).result(principal.githubUserId);
      if (r.ok) return { ok: true, value: { task_id: taskId, ...r.result } };
      switch (r.code) {
        case "not_ready":
          return fail("not_ready", "the task has not finished yet");
        case "upstream_unavailable":
          return fail("upstream_unavailable", "the agent is temporarily unavailable; retry later");
        default:
          return fail("not_found", NOT_FOUND);
      }
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;
