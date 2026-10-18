import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { isAuthProps } from "../auth/props";
import { checkStartInput, createTaskService, type Principal } from "../tasks/service";

/** ツールが返すエラーコード（phase1.md の一覧 + 想定外の internal）。 */
export type ToolErrorCode =
  | "not_found"
  | "conflict"
  | "expired"
  | "concurrency_limit"
  | "invalid_cursor"
  | "forbidden"
  | "reauth_required"
  | "upstream_unavailable"
  | "invalid_input"
  | "internal";

type ToolError = { code: ToolErrorCode; message: string; retry_after_seconds?: number };
type Outcome = { ok: true; value: unknown } | { ok: false; error: ToolError };

/** GitHub / DO が一時的に使えないときにクライアントへ示す待ち時間。 */
const UPSTREAM_RETRY_AFTER_SECONDS = 30;

const START_DESCRIPTION = [
  "リポジトリに対するコーディングタスクを作成する。応答は {task_id, status, draft_pr_url, note}。",
  "Phase 1 では子エージェントが未実装のため、タスクは CREATING のまま進まず、Draft PR も作られない（draft_pr_url は常に null）。",
  "idempotency_key（1〜128 文字の [A-Za-z0-9_-]）を渡すと、同じキー・同じ入力の再試行で同じ task_id が返る。",
  "省略した場合は再試行の重複排除を保証しない（応答が失われて再送すると別タスクになりうる）。",
  "利用者ごとに同時に実行できるタスクは 1 件まで。対象リポジトリは GitHub App が導入済みで、利用者に push 権限が必要。",
].join("\n");

const toolErrorResult = (error: ToolError) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: JSON.stringify(error) }],
});

const okResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/** 認証済みの props から Principal を作る。無い・不正なら null。 */
function principalFromContext(): Principal | null {
  const props = getMcpAuthContext()?.props;
  if (!isAuthProps(props) || !Number.isSafeInteger(props.githubUserId)) return null;
  return { githubUserId: props.githubUserId, login: props.login };
}

/**
 * 想定外の例外を写す。メッセージ・スタックは出さない（ログにはエラー名だけ）。
 * DO の一時的な障害（retryable / overloaded）は再試行できるので upstream_unavailable、それ以外は internal。
 */
function mapException(tool: string, e: unknown): ToolError {
  const flags = (e ?? {}) as { retryable?: unknown; overloaded?: unknown };
  console.error("mcp_tool_error", tool, e instanceof Error ? e.name : typeof e);
  if (flags.retryable === true || flags.overloaded === true) {
    return {
      code: "upstream_unavailable",
      message: "temporarily unavailable; retry later",
      retry_after_seconds: UPSTREAM_RETRY_AFTER_SECONDS,
    };
  }
  return { code: "internal", message: "internal error" };
}

type AuthzFailure = { code: ToolErrorCode; message: string };
function failure(f: AuthzFailure): Outcome {
  const error: ToolError = { code: f.code, message: f.message };
  if (f.code === "upstream_unavailable") error.retry_after_seconds = UPSTREAM_RETRY_AFTER_SECONDS;
  return { ok: false, error };
}

/**
 * 全ツール共通の流れ: props -> Principal、UserDO で team 再検証、本体の実行。
 * ユーザー情報はここ（ツール実行時）で getMcpAuthContext() から読む。共有状態には置かない。
 */
async function runTool(
  env: Env,
  tool: string,
  body: (principal: Principal, userDo: ReturnType<Env["USER_DO"]["getByName"]>) => Promise<Outcome>,
) {
  try {
    const principal = principalFromContext();
    if (!principal) {
      return toolErrorResult({ code: "reauth_required", message: "authentication required" });
    }
    const userDo = env.USER_DO.getByName(String(principal.githubUserId));
    const outcome = await body(principal, userDo);
    return outcome.ok ? okResult(outcome.value) : toolErrorResult(outcome.error);
  } catch (e) {
    return toolErrorResult(mapException(tool, e));
  }
}

async function requireMember(
  principal: Principal,
  userDo: ReturnType<Env["USER_DO"]["getByName"]>,
): Promise<Outcome | null> {
  const m = await userDo.ensureMember(principal.githubUserId);
  return m.ok ? null : failure(m);
}

/**
 * リクエストごとに新しい McpServer を作る（createMcpHandler の factory から呼ぶ）。
 * env は Worker の束縛。ユーザー情報は持たない。
 */
export function createRovoServer(env: Env): McpServer {
  const server = new McpServer({ name: "rovo-gateway", version: "0.2.0" });
  const service = createTaskService(env);

  // 入力の形式は service 側（zod）で検証し、code 付きのエラーで返す。ここは型の宣言。
  server.registerTool(
    "task_start",
    {
      description: START_DESCRIPTION,
      inputSchema: z.object({
        repository: z.string().describe("owner/name 形式"),
        base_ref: z.string().describe("ブランチ名など"),
        base_sha: z.string().describe("7〜40 桁の 16 進"),
        title: z.string(),
        instructions: z.string(),
        acceptance_criteria: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        idempotency_key: z.string().optional(),
      }),
    },
    async (args) =>
      runTool(env, "task_start", async (principal, userDo) => {
        // 外部（GitHub / DO）を呼ぶ前に入力を検証する
        const checked = checkStartInput(args);
        if (!checked.ok) return checked;
        // 認可（team 再検証 + Installation / push 権限）を reserve より前に行う
        const authz = await userDo.authorizeStart(
          principal.githubUserId,
          checked.value.input.repository,
        );
        if (!authz.ok) return failure(authz);
        const r = await service.start(principal, args, {
          repositoryId: authz.repositoryId,
          installationId: authz.installationId,
        });
        return r;
      }),
  );

  server.registerTool(
    "task_status",
    {
      description:
        "タスクの現在の状態を返す。{task_id, status, repository, title, draft_pr_url, created_at, updated_at, latest_cursor}。自分のタスクだけ参照できる。",
      inputSchema: z.object({ task_id: z.string() }),
    },
    async ({ task_id }) =>
      runTool(env, "task_status", async (principal, userDo) => {
        const denied = await requireMember(principal, userDo);
        return denied ?? service.status(principal, task_id);
      }),
  );

  server.registerTool(
    "task_wait",
    {
      description:
        "タスクの新しいイベントを待つ（long polling）。cursor より後のイベントがあれば即座に返し、無ければ最大 timeout_seconds（既定 30、上限 60）待つ。終端状態のタスクは待たずに返す。返った cursor を次回の cursor に渡す。デプロイ等で待機が切れても、同じ cursor で再試行すればイベントを取りこぼさない。同時待機が多すぎる場合は retry_after_seconds 付きで空の結果を返す。",
      inputSchema: z.object({
        task_id: z.string(),
        cursor: z.string().optional(),
        timeout_seconds: z.number().optional().describe("0 以上の整数"),
      }),
    },
    async (args) =>
      runTool(env, "task_wait", async (principal, userDo) => {
        const denied = await requireMember(principal, userDo);
        return denied ?? service.wait(principal, args);
      }),
  );

  server.registerTool(
    "task_cancel",
    {
      description:
        "タスクをキャンセルする。終端状態のタスクに対しても冪等に成功し、現在の状態を返す。{task_id, status}。",
      inputSchema: z.object({ task_id: z.string() }),
    },
    async ({ task_id }) =>
      runTool(env, "task_cancel", async (principal, userDo) => {
        const denied = await requireMember(principal, userDo);
        return denied ?? service.cancel(principal, task_id);
      }),
  );

  return server;
}
