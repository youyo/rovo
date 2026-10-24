import {
  type BudgetMeDto,
  BudgetMeDtoSchema,
  CloudflareSummaryDtoSchema,
  type ErrorDto,
  LIMITS,
  type OverviewDto,
  OverviewDtoSchema,
  PR_STATES,
  type PrDto,
  SCOPES,
  type TaskDetailDto,
  TaskDetailDtoSchema,
  type TaskEventsPageDto,
  TaskEventsPageDtoSchema,
  type VisibleTaskDto,
} from "@rovo/dashboard-contract";
import type { z } from "zod";
import { DIRECTORY_NAME, type TaskIndexRow, type TaskIndexSnapshot } from "../directory/types";
import { errorMessageForLog } from "../log-error";
import type { DashboardDetailResult } from "../tasks/task-do";
import { isTaskId } from "../tasks/ulid";
import { type DashboardSession, requireSession } from "./auth";
import { loadCloudflareSummary, parseCloudflareRange } from "./cloudflare";
import { buildNow, buildOutput, phaseOf, stoppedPhaseOf } from "./detail-now";
import { toEventDto } from "./events";
import { jsonResponse } from "./guard";

/**
 * ダッシュボードの読み取り API（/dashboard/api/overview・tasks/:id・tasks/:id/events・budget。docs/specs/dashboard.md M5b）。
 *
 * 認可の流れ（ここが最後の関門）:
 *   1. 入口の Sec-Fetch-Site 検査（serve.ts の handleApi。ルーティングより前）
 *   2. requireSession: Cookie → UserDO のセッション記録 + 今の許可ルール（外れた利用者は 401、確かめられない障害は 503）
 *   3. visibleRepositoryIds: 閲覧者のトークンで GitHub を列挙した repository id の集合（空 = 何も見えない。失敗は fail closed）
 *   4. 一覧は集合で絞った SQL（Directory）。詳細・events は **readAuthorizedTask だけ**が TaskDO を読み、TaskDO の今の
 *      repository_id を集合で照合してから先へ進む（照合しない経路を作らない。索引を権限の根拠にしない）
 *   5. 応答は M2 の契約の zod で検証してから返す。検証に失敗したら、中身を返さず 503
 *
 * エラーは ErrorDto の 3 種 + 400/403: 401（未ログイン・失効・許可ルール外・GitHub の資格なし）、404（権限なし・存在しない・
 * repository_id が NULL。区別しない）、503（GitHub の障害・列挙の失敗・集合が大きすぎる・出力の検証の失敗）。本文に理由を出さない。
 */

const PREFIX = "/dashboard/api";
const HOUR_MS = 3_600_000;
/** タイムラインの範囲の最大幅（D18） */
const MAX_RANGE_MS = 36 * HOUR_MS;
/** Directory の 1 回の list の件数（MAX_LIST_LIMIT と同じ）。overview の上限（LIMITS.overviewTasks）までページを重ねる */
const PAGE = 500;
/** 見えないタスクだけが使うモデルの名前の代わりに出す名前（モデル別の費用の表） */
const OTHER_MODEL = "other";

/** 調整値（テストで差し替える）。 */
export const readApiTuning = {
  /** PR の状態の照会を待つ上限（ms）。超えたら state を unknown のまま返す（画面の応答を GitHub の遅れに付き合わせない） */
  pullStateDeadlineMs: 5_000,
};
/** 1 回の応答で GitHub に聞く PR の上限（重複を除く）。超える分は unknown */
const MAX_PR_LOOKUPS = 200;
const PR_STATE_VALUES: ReadonlySet<string> = new Set(PR_STATES);

export interface ReadApiDeps {
  /** 時刻（テスト用）。月（UTC）の範囲と generated_at に使う */
  now?: () => number;
  /** Cloudflare の上流の呼び出し（テスト用） */
  fetch?: typeof fetch;
}

const errorJson = (status: 400 | 401 | 404 | 503, error: ErrorDto["error"]) =>
  jsonResponse(status, { error } satisfies ErrorDto);

/** 契約のスキーマで検証してから返す。失敗したら、中身（不正な値）を返さずに 503。ログにはスキーマの名前だけを出す。 */
function validated<T>(schema: z.ZodType<T>, name: string, data: unknown): Response {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    // 運用で原因を辿れるよう、値ではなく場所（項目のパス。値は含まない）だけを出す
    const where = parsed.error.issues
      .slice(0, 5)
      .map((issue) => issue.path.join("."))
      .join(",");
    console.error("dashboard_api_invalid_output", name, where);
    return errorJson(503, "unavailable");
  }
  return jsonResponse(200, parsed.data);
}

// --- 索引・TaskDO の値を契約の形に整える ---

const REASON_RE = /^[a-z0-9][a-z0-9_.:-]*$/;
const PR_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/;

const iso = (ms: number): string => new Date(ms).toISOString();
const usd = (micro: number): number => micro / 1_000_000;

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  // サロゲートペアの途中で切らない
  return text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * 閲覧権限のあるタスク 1 件の DTO。任意の文字列の項目は、契約の形に合わないものを落とす（reason は理由コードだけ・
 * PR は番号と GitHub の PR の URL が揃うときだけ・題名は上限で切る）。必須の項目（login・repository・model など）が
 * 契約に合わないときは直さず、最後の検証で全体を 503 にする（見える行を黙って落とさない・不正な値を出さない）。
 */
export function snapshotToVisibleTask(s: TaskIndexSnapshot | TaskIndexRow): VisibleTaskDto {
  const pr =
    s.pr_number !== null && s.pr_url !== null && PR_URL_RE.test(s.pr_url)
      ? {
          number: s.pr_number,
          url: s.pr_url,
          draft: s.pr_draft,
          merged: s.pr_merged,
          // rovo の記録でマージ済みなら確定。それ以外は GitHub に聞くまで unknown（attachPrStates が重ねる）
          state: s.pr_merged ? ("merged" as const) : ("unknown" as const),
        }
      : null;
  return {
    task_id: s.task_id,
    owner_login: s.owner_login,
    repository: s.repository,
    title: clipText(s.title, LIMITS.title),
    status: s.status as VisibleTaskDto["status"],
    model: s.model,
    effort: s.effort as VisibleTaskDto["effort"],
    created_at: iso(s.created_at),
    started_at: s.started_at === null ? null : iso(s.started_at),
    ended_at: s.ended_at === null ? null : iso(s.ended_at),
    updated_at: iso(s.updated_at),
    cost: {
      cost_usd: usd(s.cost_micro),
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      cache_read_tokens: s.cache_read_tokens,
      cache_write_tokens: s.cache_write_tokens,
    },
    pr,
    ...(s.reason !== null && s.reason.length <= LIMITS.reason && REASON_RE.test(s.reason)
      ? { reason: s.reason }
      : {}),
    ...(s.failure_phase === "setup" ? { failure_phase: "setup" as const } : {}),
  };
}

// --- PR の状態（GitHub） ---

/**
 * 表示するタスクの PR の状態を GitHub から取って、pr.state に入れる（その場で書き換える）。
 *
 * **権限の判定に通ったタスクだけを渡すこと**（呼び出し側の約束。overview は見える集合で絞った行、詳細は readAuthorizedTask の後）。
 * 取得は閲覧者本人の UserDO（ユーザートークン・キャッシュ・GraphQL のまとめ・同時実行の抑制はそちら）。
 * 照会するのは COMPLETED で rovo の記録が未マージの PR だけ（印を決めるのはそこだけ。merged の記録は照会せず確定）。
 * fail-soft: 例外・不正な応答・時間切れは何もしない（state は unknown のまま）。画面の他の部分を壊さない。
 */
async function attachPrStates(env: Env, uid: number, tasks: VisibleTaskDto[]): Promise<void> {
  const keyOf = (repository: string, n: number) => `${repository.toLowerCase()}#${n}`;
  const targets = tasks.filter((t) => t.status === "COMPLETED" && t.pr !== null && !t.pr.merged);
  const refs = new Map<string, { repository: string; number: number }>();
  for (const t of targets) {
    const k = keyOf(t.repository, (t.pr as { number: number }).number);
    if (!refs.has(k) && refs.size < MAX_PR_LOOKUPS) {
      refs.set(k, { repository: t.repository, number: (t.pr as { number: number }).number });
    }
  }
  if (refs.size === 0) return;
  const list = [...refs.values()];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = Promise.resolve(env.USER_DO.getByName(String(uid)).dashboardPullStates(uid, list));
    call.catch(() => {}); // 時間切れのあとに失敗しても、未処理の拒否にしない
    const states = await Promise.race([
      call,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), readApiTuning.pullStateDeadlineMs);
      }),
    ]);
    if (!Array.isArray(states) || states.length !== list.length) return;
    const byKey = new Map<string, PrDto["state"]>();
    list.forEach((r, i) => {
      const v: unknown = states[i];
      if (typeof v === "string" && PR_STATE_VALUES.has(v)) {
        byKey.set(keyOf(r.repository, r.number), v as PrDto["state"]);
      }
    });
    for (const t of targets) {
      const pr = t.pr as PrDto;
      pr.state = byKey.get(keyOf(t.repository, pr.number)) ?? pr.state;
    }
  } catch (e) {
    // 名前と、マスクして 200 文字に切ったメッセージを記録する（トークンが入りうるので、そのままは出さない）
    console.error(
      "dashboard_pr_state_error",
      e instanceof Error ? e.name : typeof e,
      errorMessageForLog(e),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- 認証・認可 ---

/** 未ログインなら 401。UserDO を引けない・許可ルールを確かめられない障害は例外のまま投げる（呼び出し側が 503 にする）。 */
async function authenticate(
  request: Request,
  env: Env,
): Promise<{ ok: true; session: DashboardSession } | { ok: false; response: Response }> {
  const session = await requireSession(request, env);
  if (!session) return { ok: false, response: errorJson(401, "unauthorized") };
  return { ok: true, session };
}

/**
 * 閲覧者の見える repository id の集合。空は「何も見えない」。失敗は fail closed:
 * 資格なし・失効（unauthenticated）は 401（再ログインで直る）、GitHub の障害・403・集合が大きすぎるは 503。
 * 想定外の形の応答も 503（部分的な集合を使わない）。
 */
async function loadVisible(
  env: Env,
  uid: number,
  fresh: boolean,
): Promise<{ ok: true; ids: Set<number> } | { ok: false; response: Response }> {
  const result = await env.USER_DO.getByName(String(uid)).visibleRepositoryIds(uid, { fresh });
  if (result.ok) {
    if (!Array.isArray(result.ids) || !result.ids.every((id) => Number.isSafeInteger(id))) {
      return { ok: false, response: errorJson(503, "unavailable") };
    }
    return { ok: true, ids: new Set(result.ids) };
  }
  return {
    ok: false,
    response:
      result.code === "unauthenticated"
        ? errorJson(401, "unauthorized")
        : errorJson(503, "unavailable"),
  };
}

/**
 * 詳細・events の認可の入口（TaskDO を読むのはここだけ）。
 * 先に集合を取り（GitHub の障害は、タスクの有無によらず 503）、そのあと TaskDO の**今の** repository_id を集合で照合する。
 * 権限なし・存在しない・NULL は区別なく同じ 404。照合に通るまで、view は呼び出し側に渡さない。
 */
async function readAuthorizedTask(
  env: Env,
  session: DashboardSession,
  taskId: string,
  opts: { fresh: boolean },
): Promise<
  | { ok: true; detail: Extract<DashboardDetailResult, { ok: true }> }
  | { ok: false; response: Response }
> {
  if (!isTaskId(taskId)) return { ok: false, response: errorJson(404, "not_found") };
  const visible = await loadVisible(env, session.uid, opts.fresh);
  if (!visible.ok) return visible;
  const detail = await env.TASK_DO.getByName(taskId).dashboardDetail();
  if (!detail.ok) return { ok: false, response: errorJson(404, "not_found") };
  const repositoryId = detail.view.repository_id;
  if (repositoryId === null || !visible.ids.has(repositoryId)) {
    return { ok: false, response: errorJson(404, "not_found") };
  }
  return { ok: true, detail };
}

// --- 予算 ---

function toBudgetMe(raw: {
  monthly_budget_usd: number;
  remaining_usd: number;
  spent_usd: number;
  estimated_usd: number;
  reserved_usd: number;
  max_concurrent_tasks: number;
  concurrency_limit: number;
  running_slots: number;
}): BudgetMeDto {
  // あと何件 = min(予算で予約できる件数, 同時実行の上限 - 実行中の枠)（D8。負にしない）
  const startable = Math.max(
    0,
    Math.min(raw.max_concurrent_tasks, raw.concurrency_limit - raw.running_slots),
  );
  return {
    monthly_budget_usd: raw.monthly_budget_usd,
    remaining_usd: raw.remaining_usd,
    spent_usd: raw.spent_usd,
    estimated_usd: raw.estimated_usd,
    reserved_usd: raw.reserved_usd,
    max_concurrent_tasks: raw.max_concurrent_tasks,
    concurrency_limit: raw.concurrency_limit,
    running_slots: raw.running_slots,
    startable,
  };
}

// --- 入力 ---

function parseInstant(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// --- ハンドラ ---

async function handleOverview(request: Request, env: Env, now: () => number): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const { session } = auth;

  const params = new URL(request.url).searchParams;
  const from = parseInstant(params.get("from"));
  const to = parseInstant(params.get("to"));
  const scopeRaw = params.get("scope") ?? "all";
  if (
    from === null ||
    to === null ||
    to <= from ||
    to - from > MAX_RANGE_MS ||
    !(SCOPES as readonly string[]).includes(scopeRaw)
  ) {
    return errorJson(400, "bad_request");
  }
  const scope = scopeRaw as OverviewDto["scope"];

  const visible = await loadVisible(env, session.uid, false);
  if (!visible.ok) return visible.response;
  const repoIds = [...visible.ids];

  const at = now();
  const d = new Date(at);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);

  const directory = env.DIRECTORY_DO.getByName(DIRECTORY_NAME);
  const ownerId = scope === "me" ? { ownerId: session.uid } : {};
  const rows: TaskIndexRow[] = [];
  for (let offset = 0; offset < LIMITS.overviewTasks; offset += PAGE) {
    const page = await directory.listTasks({
      repoIds,
      from,
      to,
      ...ownerId,
      limit: Math.min(PAGE, LIMITS.overviewTasks - offset),
      offset,
    });
    if (!page.ok) return errorJson(503, "unavailable");
    rows.push(...page.rows);
    if (offset + page.rows.length >= page.total || page.rows.length === 0) break;
  }
  // 以降は互いに依存しないので並行に読む（認可の集合 visible を取ったあと）。PR の状態は見える行（rows）が決まってから
  const tasks = rows.map(snapshotToVisibleTask);
  const consultOwner = scope === "me" ? { ownerId: session.uid } : {};
  const [summary, visibleModels, budgetRaw, consultList, consultSummary] = await Promise.all([
    directory.summarize({ repoIds, from: monthStart, to: monthEnd }),
    directory.visibleModels({ repoIds, from: monthStart, to: monthEnd }),
    env.USER_DO.getByName(String(session.uid)).dashboardBudget(),
    // consult（D9）: 対象のリポジトリが無いので、見えるリポジトリの集合では絞らない（全員分。「自分」では所有者で絞る）
    directory.listConsults({ from, to, ...consultOwner, limit: LIMITS.overviewConsults }),
    directory.summarizeConsults({ from: monthStart, to: monthEnd }),
    // PR の状態: 見えるタスク（見える集合で絞った行）の分だけ、閲覧者のトークンで GitHub から取る（fail-soft）
    attachPrStates(env, session.uid, tasks),
  ]);
  if (!summary.ok || !visibleModels.ok) return errorJson(503, "unavailable");
  const budget = toBudgetMe(budgetRaw);
  if (!consultList.ok || !consultSummary.ok) return errorJson(503, "unavailable");

  // モデル別の費用（月・全員分）。タスク分は、見えないタスクだけが使うモデルの名前を出さず "other" にまとめる。
  // consult 分は consult のモデルの名前のまま出す（consult は権限の対象外。タスクの費用には混ぜない）
  const known = new Set(visibleModels.models);
  const costs = new Map<string, { task: number; consult: number }>();
  const add = (name: string, key: "task" | "consult", micro: number) => {
    const cur = costs.get(name) ?? { task: 0, consult: 0 };
    cur[key] += micro;
    costs.set(name, cur);
  };
  for (const m of summary.models)
    add(known.has(m.model) ? m.model : OTHER_MODEL, "task", m.cost_micro);
  for (const m of consultSummary.models) add(m.model, "consult", m.cost_micro);
  const ranked = [...costs.entries()]
    .filter(([name]) => name !== OTHER_MODEL)
    .sort(
      (a, b) => b[1].task + b[1].consult - (a[1].task + a[1].consult) || a[0].localeCompare(b[0]),
    );
  const shown = ranked.slice(0, LIMITS.models - 1);
  const other = {
    task: costs.get(OTHER_MODEL)?.task ?? 0,
    consult: costs.get(OTHER_MODEL)?.consult ?? 0,
  };
  for (const [, c] of ranked.slice(LIMITS.models - 1)) {
    other.task += c.task;
    other.consult += c.consult;
  }
  const models = shown.map(([model, c]) => ({
    model,
    task_cost_usd: usd(c.task),
    consult_cost_usd: usd(c.consult),
  }));
  if (other.task > 0 || other.consult > 0 || costs.has(OTHER_MODEL)) {
    models.push({
      model: OTHER_MODEL,
      task_cost_usd: usd(other.task),
      consult_cost_usd: usd(other.consult),
    });
  }
  const totalMicro = summary.visible.cost_micro + summary.hidden.cost_micro;

  const dto: OverviewDto = {
    generated_at: iso(at),
    range: { from: iso(from), to: iso(to) },
    scope,
    viewer: { login: session.login },
    tasks,
    consults: consultList.rows.map((r) => ({
      consult_id: r.consult_id,
      owner_login: r.owner_login,
      at: iso(r.at),
      model: r.model,
      cost_usd: usd(r.cost_micro),
      estimated: r.estimated,
    })),
    budget,
    month: {
      period: { start: iso(monthStart), end: iso(monthEnd) },
      task_cost_usd: usd(totalMicro),
      // 予算の実績 = タスクの費用 + consult の費用。estimated は consult の見積もりで閉じた分だけ（タスク側の見積もりは索引に無い）
      budget_actual: {
        spent_usd: usd(totalMicro + consultSummary.cost_micro),
        estimated_usd: usd(consultSummary.estimated_micro),
      },
      hidden_tasks: { count: summary.hidden.count, cost_usd: usd(summary.hidden.cost_micro) },
    },
    models,
  };
  return validated(OverviewDtoSchema, "OverviewDto", dto);
}

async function handleTaskDetail(request: Request, env: Env, taskId: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  // 開いた最初の 1 回だけ GitHub で取り直す（権限の取り消しを厳密に反映。D6）。画面が最初の取得にだけ ?fresh=1 を付ける。
  // 付かない（ポーリング）ときは events と同じ 30 秒のキャッシュ。取り消しの反映は最大でそのキャッシュの TTL（UserDO の VISIBLE_CACHE_TTL_MS）
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const read = await readAuthorizedTask(env, auth.session, taskId, { fresh });
  if (!read.ok) return read.response;
  const { view, review_policy, sandbox_instance, model_selection, reached } = read.detail;

  // 「いまの手順」と出力の末尾の材料（直近の数十件と最新の command だけ）。照合に使った repository_id を渡し、TaskDO が突き合わせる
  const repositoryId = view.repository_id;
  if (repositoryId === null) return errorJson(404, "not_found");
  // 権限の照合（readAuthorizedTask）に通ったあとで、PR の状態を閲覧者のトークンで取る（fail-soft）。
  // 材料の読み取り（TaskDO）と PR の状態（GitHub）は互いに待たない。
  const task = snapshotToVisibleTask(view);
  const [latest] = await Promise.all([
    env.TASK_DO.getByName(taskId).dashboardLatest(repositoryId),
    attachPrStates(env, auth.session.uid, [task]),
  ]);
  if (!latest.ok) return errorJson(404, "not_found");
  const phase = phaseOf(view.status);

  const deps = view.deps_cache;
  const dto: TaskDetailDto = {
    generated_at: iso(Date.now()),
    task,
    phase,
    stopped_phase: stoppedPhaseOf(view.status, view.failure_phase, reached),
    // 実行中の一言。最新の command / edit / web などから作る（古い agent は tool_start に縮退。終端は null）
    now: buildNow(latest.recent, view.status, phase, read.detail.awaiting_budget),
    settings: {
      review_policy,
      ...(deps === "hit" || deps === "miss" || deps === "built" || deps === "disabled"
        ? { deps_cache: deps }
        : {}),
      ...(view.sandbox_runtime_ms !== null ? { sandbox_runtime_ms: view.sandbox_runtime_ms } : {}),
      ...(sandbox_instance !== null ? { sandbox_instance } : {}),
      // モデルの選び方は mode と reason（固定のコード）だけ。確率・時間・選んだモデルは出さない
      ...(model_selection !== undefined
        ? { model_selection: { mode: model_selection.mode, reason: model_selection.reason } }
        : {}),
    },
    // 出力の末尾は最新の command の output_tail（再マスク済み）。伏せている旨は常に true
    output: buildOutput(latest.latest_command, latest.progress),
  };
  return validated(TaskDetailDtoSchema, "TaskDetailDto", dto);
}

/** events の cursor / before。正の整数だけ。無ければ undefined、不正なら null。 */
function parseSeq(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

async function handleTaskEvents(request: Request, env: Env, taskId: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const params = new URL(request.url).searchParams;
  const cursor = parseSeq(params.get("cursor"));
  const before = parseSeq(params.get("before"));
  if (cursor === null || before === null || (cursor !== undefined && before !== undefined)) {
    return errorJson(400, "bad_request");
  }
  // 5 秒ごとのポーリングなので、GitHub の取り直しはしない（30 秒のキャッシュ。D6）
  const read = await readAuthorizedTask(env, auth.session, taskId, { fresh: false });
  if (!read.ok) return read.response;
  // 照合に使った repository_id を渡す。TaskDO が今の値と突き合わせて、食い違えば not_found（照合と読み取りの間に変わらない保証）
  const repositoryId = read.detail.view.repository_id;
  if (repositoryId === null) return errorJson(404, "not_found");
  const result = await env.TASK_DO.getByName(taskId).dashboardEvents(repositoryId, {
    ...(cursor !== undefined ? { cursor } : {}),
    ...(before !== undefined ? { before } : {}),
    limit: LIMITS.eventsPerPage,
  });
  if (!result.ok) return errorJson(404, "not_found");
  // 最後の層: 保存された行をもう一度マスク・整形して契約の DTO にする（契約に合わない行は落とす）
  const events = result.events.flatMap((row) => {
    const dto = toEventDto(row);
    return dto === null ? [] : [dto];
  });
  const page: TaskEventsPageDto = {
    task_id: read.detail.view.task_id,
    events,
    oldest_seq: events[0]?.seq ?? null,
    newest_seq: events[events.length - 1]?.seq ?? null,
    has_older: result.has_older,
  };
  return validated(TaskEventsPageDtoSchema, "TaskEventsPageDto", page);
}

async function handleBudget(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  // 閲覧者本人の予算だけ（他人の枠・タスクの情報を含まないので、見えるリポジトリの集合は要らない）
  const budget = toBudgetMe(
    await env.USER_DO.getByName(String(auth.session.uid)).dashboardBudget(),
  );
  return validated(BudgetMeDtoSchema, "BudgetMeDto", budget);
}

/**
 * Cloudflare の概要（M9 / D13）。閲覧者に依らない集計なので、見えるリポジトリの集合は使わない（ログインだけ必須）。
 * range は 1h / 24h / 7d の列挙だけ（既定 24h）。GraphQL・ID・期間の式はクライアントから受けない。
 */
async function handleCloudflare(request: Request, env: Env, deps: ReadApiDeps): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const range = parseCloudflareRange(new URL(request.url).searchParams.get("range"));
  if (range === null) return errorJson(400, "bad_request");
  const dto = await loadCloudflareSummary(env, range, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return validated(CloudflareSummaryDtoSchema, "CloudflareSummaryDto", dto);
}

/**
 * 読み取り API の振り分け。対象外の経路は null（呼び出し側が JSON の 404 にする）。
 * 例外（UserDO・DirectoryDO・TaskDO の障害、DashboardUnavailableError）は投げたままにする（呼び出し側が 503 にする）。
 */
export async function handleReadApi(
  request: Request,
  env: Env,
  pathname: string,
  deps: ReadApiDeps = {},
): Promise<Response | null> {
  if (!pathname.startsWith(`${PREFIX}/`)) return null;
  const rest = pathname.slice(PREFIX.length);
  const task = /^\/tasks\/([^/]+)(\/events)?$/.exec(rest);
  const known =
    rest === "/overview" || rest === "/budget" || rest === "/cloudflare" || task !== null;
  if (!known) return null;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return jsonResponse(405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
  }
  const now = deps.now ?? Date.now;
  if (rest === "/overview") return handleOverview(request, env, now);
  if (rest === "/budget") return handleBudget(request, env);
  if (rest === "/cloudflare") return handleCloudflare(request, env, deps);
  const taskId = task?.[1] ?? "";
  return task?.[2] === "/events"
    ? handleTaskEvents(request, env, taskId)
    : handleTaskDetail(request, env, taskId);
}

export { stoppedPhaseOf };
