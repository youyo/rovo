import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { isAuthProps } from "../auth/props";
import { checkStartInput, createTaskService, type Principal } from "../tasks/service";

/**
 * ツールが返すエラーコード（phase1.md の一覧 + 想定外の internal）。
 * Phase 2 で追加: budget_exceeded（月額の枠が足りず task_start を拒否。concurrency_limit と違い待っても空かない）、
 * not_ready（task_result の対象がまだ終端でない）。
 */
export type ToolErrorCode =
  | "not_found"
  | "conflict"
  | "expired"
  | "concurrency_limit"
  | "budget_exceeded"
  | "not_ready"
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
  "リポジトリに対するコーディングタスクを作成し、子エージェントを起動する。応答は {task_id, status, draft_pr_url, note}。",
  "子エージェントが start を受理すると status は RUNNING になる（受理を確認できなかった場合は CREATING のままで、Gateway が自動で再送する）。進捗は task_wait、成果（要約・検証結果・patch）は終端になってから task_result で取得する。",
  "Phase 2 では push も Draft PR も作られない（draft_pr_url は常に null）。成果は patch として返る。",
  "verification_commands（任意）は {argv: string[], cwd?: リポジトリ内の相対パス, timeout_seconds?} の配列（最大 10 件）。完了の申告後に Sandbox で実行され、全部が終了コード 0 なら COMPLETED になる。指定しない場合はモデルの申告だけで完了し、結果は「未検証」と記される。",
  "1 タスクにつき $10 を月額の枠から予約する。枠が足りなければ budget_exceeded で拒否される。",
  "idempotency_key（1〜128 文字の [A-Za-z0-9_-]）を渡すと、同じキー・同じ入力の再試行で同じ task_id が返る。",
  "省略した場合は再試行の重複排除を保証しない（応答が失われて再送すると別タスクになりうる）。",
  "利用者ごとに同時に実行できるタスクは 1 件まで。対象リポジトリは GitHub App が導入済みで、利用者に push 権限が必要。",
].join("\n");

/**
 * SDK に渡す入力スキーマ。tools/list に出る JSON Schema は zod スキーマのもの（利用者に正しい型を見せる）が、
 * 実行時の検証は SDK では行わず素通しにする。SDK の検証エラーは code の無い標準エラーになり、
 * 「全エラーを isError + code 付き JSON で返す」契約を破るため。検証はツール内の parseToolInput で行い、
 * 失敗は invalid_input で返す。
 */
function publishedSchema<S extends z.ZodObject>(schema: S) {
  const std = schema["~standard"];
  return {
    "~standard": {
      ...std,
      validate: (value: unknown) => ({ value: (value ?? {}) as z.input<S> }),
    },
  } as unknown as typeof schema;
}

/** ツール内の入力検証。型の不一致・必須項目の欠落は invalid_input にする。 */
function parseToolInput<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): { ok: true; value: z.output<S> } | { ok: false; error: ToolError } {
  const r = schema.safeParse(raw ?? {});
  if (r.success) return { ok: true, value: r.data };
  const message = r.error.issues
    .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: { code: "invalid_input", message } };
}

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
const startSchema = z.object({
  repository: z.string().describe("owner/name 形式"),
  base_ref: z.string().describe("ブランチ名など"),
  base_sha: z.string().describe("7〜40 桁の 16 進"),
  title: z.string(),
  instructions: z.string(),
  acceptance_criteria: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  verification_commands: z
    .array(
      z.object({
        argv: z.array(z.string()).describe("実行ファイルと引数（シェルは通らない）"),
        cwd: z.string().optional().describe("リポジトリのルートからの相対パス"),
        timeout_seconds: z.number().optional().describe("1〜1800"),
      }),
    )
    .optional(),
  idempotency_key: z.string().optional(),
});
const taskIdSchema = z.object({ task_id: z.string() });
const waitSchema = z.object({
  task_id: z.string(),
  cursor: z.string().optional(),
  timeout_seconds: z.number().optional().describe("0 以上の整数"),
});

export function createRovoServer(env: Env): McpServer {
  const server = new McpServer({ name: "rovo-gateway", version: "0.2.0" });
  const service = createTaskService(env);

  // 入力の検証は SDK ではなくツール内（zod）で行い、code 付きのエラーで返す。SDK には公開用の宣言だけを渡す。
  server.registerTool(
    "task_start",
    {
      description: START_DESCRIPTION,
      inputSchema: publishedSchema(startSchema),
    },
    async (args) =>
      runTool(env, "task_start", async (principal, userDo) => {
        // 外部（GitHub / DO）を呼ぶ前に入力を検証する（型の不一致も invalid_input）
        const typed = parseToolInput(startSchema, args);
        if (!typed.ok) return typed;
        const checked = checkStartInput(typed.value);
        if (!checked.ok) return checked;
        // 認可（team 再検証 + Installation / push 権限）を reserve より前に行う
        const authz = await userDo.authorizeStart(
          principal.githubUserId,
          checked.value.input.repository,
        );
        if (!authz.ok) return failure(authz);
        const r = await service.start(principal, typed.value, {
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
      inputSchema: publishedSchema(taskIdSchema),
    },
    async (args) =>
      runTool(env, "task_status", async (principal, userDo) => {
        const typed = parseToolInput(taskIdSchema, args);
        if (!typed.ok) return typed;
        const { task_id } = typed.value;
        const denied = await requireMember(principal, userDo);
        return denied ?? service.status(principal, task_id);
      }),
  );

  server.registerTool(
    "task_wait",
    {
      description:
        "タスクの新しいイベントを待つ（long polling）。cursor より後のイベントがあれば即座に返し、無ければ最大 timeout_seconds（既定 30、上限 60）待つ。終端状態のタスクは待たずに返す。返った cursor を次回の cursor に渡す。デプロイ等で待機が切れても、同じ cursor で再試行すればイベントを取りこぼさない。同時待機が多すぎる場合は retry_after_seconds 付きで空の結果を返す。",
      inputSchema: publishedSchema(waitSchema),
    },
    async (args) =>
      runTool(env, "task_wait", async (principal, userDo) => {
        const typed = parseToolInput(waitSchema, args);
        if (!typed.ok) return typed;
        const denied = await requireMember(principal, userDo);
        return denied ?? service.wait(principal, typed.value);
      }),
  );

  server.registerTool(
    "task_result",
    {
      description:
        "終端になったタスクの成果を返す。{task_id, status, summary, verification: {commands, results, verified, attempts, commit_sha?}, warnings, patch | diffstat, patch_too_large, usage}。verified が false のときは検証コマンドを通っていない（未指定、またはモデルの申告のみ）。warnings にテスト設定の変更などが記される。タスクが終端でない、またはエージェントの停止を確認できていない間は not_ready エラーを返すので、task_wait で終端を待ってから呼ぶ。自分のタスクだけ参照できる。",
      inputSchema: publishedSchema(taskIdSchema),
    },
    async (args) =>
      runTool(env, "task_result", async (principal, userDo) => {
        const typed = parseToolInput(taskIdSchema, args);
        if (!typed.ok) return typed;
        const { task_id } = typed.value;
        const denied = await requireMember(principal, userDo);
        return denied ?? service.result(principal, task_id);
      }),
  );

  server.registerTool(
    "task_cancel",
    {
      description:
        "タスクをキャンセルする。終端状態のタスクに対しても冪等に成功し、現在の状態を返す。{task_id, status}。CANCELLED は即座に確定するが、子エージェントの停止の確認は Gateway が収束するまで再送する（確認できるまで次のタスクは始められない）。",
      inputSchema: publishedSchema(taskIdSchema),
    },
    async (args) =>
      runTool(env, "task_cancel", async (principal, userDo) => {
        const typed = parseToolInput(taskIdSchema, args);
        if (!typed.ok) return typed;
        const { task_id } = typed.value;
        const denied = await requireMember(principal, userDo);
        return denied ?? service.cancel(principal, task_id);
      }),
  );

  return server;
}
