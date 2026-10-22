// 画面と Unit が使う fixtures。見本に合わせた「今日」（2026-10-21 UTC）のデータ。
// 公開リポジトリなので、値はすべて架空（owner は example-org、人は *-example、ID は手で作った ULID 形）。
// 実在のリポジトリ名・ユーザー名・アカウント ID・トークンの形の文字列を入れない。
import type { CloudflareSummaryDto } from "./cloudflare";
import type { TaskDetailDto } from "./detail";
import type { ErrorDto } from "./error";
import type { TaskEventDto, TaskEventsPageDto } from "./events";
import type { OverviewDto, VisibleTaskDto } from "./overview";

/** 手で作った ULID 形の ID（Crockford の文字だけ。時刻としての意味は無い） */
const tid = (n: number): string => `01K8ZF${String(n).padStart(20, "0")}`;
const cid = (n: number): string => `consult-${tid(n)}`;
const SHA = "0123456789abcdef".repeat(3).slice(0, 40);

const ALICE = "alice-example";
const BOB = "bob-example";
const CAROL = "carol-example";
const MODEL_L = "example-model-large";
const MODEL_S = "example-model-small";

const cost = (usd: number, input = 120_000, output = 18_000) => ({
  cost_usd: usd,
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: input * 3,
  cache_write_tokens: Math.round(input / 4),
});
const pr = (n: number, repo: string, merged: boolean, draft: boolean | null) => ({
  number: n,
  url: `https://github.com/example-org/${repo}/pull/${n}`,
  draft,
  merged,
  state: merged ? ("merged" as const) : ("open" as const),
});

const tasks: VisibleTaskDto[] = [
  {
    task_id: tid(1),
    owner_login: ALICE,
    repository: "example-org/web-app",
    title: "ログイン画面の文言を直す",
    status: "COMPLETED",
    model: MODEL_L,
    effort: "high",
    created_at: "2026-10-21T01:05:00Z",
    started_at: "2026-10-21T01:06:10Z",
    ended_at: "2026-10-21T02:05:30Z",
    updated_at: "2026-10-21T02:05:30Z",
    cost: cost(1.84),
    pr: pr(101, "web-app", true, false),
  },
  {
    task_id: tid(2),
    owner_login: ALICE,
    repository: "example-org/api-server",
    title: "一覧 API にページングを足す",
    status: "COMPLETED",
    model: MODEL_L,
    effort: "high",
    created_at: "2026-10-21T03:15:00Z",
    started_at: "2026-10-21T03:16:00Z",
    ended_at: "2026-10-21T04:10:00Z",
    updated_at: "2026-10-21T04:10:00Z",
    cost: cost(2.35, 180_000, 25_000),
    pr: pr(57, "api-server", false, true),
  },
  {
    task_id: tid(3),
    owner_login: BOB,
    repository: "example-org/web-app",
    title: "依存パッケージを更新する",
    status: "FAILED",
    model: MODEL_S,
    effort: "medium",
    created_at: "2026-10-21T02:28:00Z",
    started_at: "2026-10-21T02:29:00Z",
    ended_at: "2026-10-21T02:50:00Z",
    updated_at: "2026-10-21T02:50:00Z",
    cost: cost(0.62, 60_000, 8_000),
    pr: pr(102, "web-app", false, true),
    reason: "verification_failed",
  },
  {
    task_id: tid(4),
    owner_login: BOB,
    repository: "example-org/infra-tools",
    title: "デプロイスクリプトの確認を足す",
    status: "RUNNING",
    model: MODEL_L,
    effort: "high",
    created_at: "2026-10-21T05:38:00Z",
    started_at: "2026-10-21T05:40:00Z",
    ended_at: null,
    updated_at: "2026-10-21T05:58:30Z",
    cost: cost(0.9, 70_000, 9_000),
    pr: pr(23, "infra-tools", false, true),
  },
  {
    task_id: tid(5),
    owner_login: CAROL,
    repository: "example-org/api-server",
    title: "エラー応答の形をそろえる",
    status: "COMPLETED",
    model: MODEL_S,
    effort: "medium",
    created_at: "2026-10-21T00:18:00Z",
    started_at: "2026-10-21T00:19:00Z",
    ended_at: "2026-10-21T01:00:00Z",
    updated_at: "2026-10-21T01:00:00Z",
    cost: cost(1.1, 90_000, 12_000),
    pr: pr(56, "api-server", true, false),
  },
];

/** 見えないタスクの個別の値。どの DTO にも現れてはならない（テストで応答全体を検索する） */
export const HIDDEN_TASK_SENTINELS = {
  task_id: "01K8ZFH1DDEN00000000000000",
  owner_login: "dave-hidden-example",
  repository: "example-org/hidden-repo",
  pr_url: "https://github.com/example-org/hidden-repo/pull/99",
  model: "example-model-hidden",
  title: "hidden-task-title-sentinel",
} as const;

export const overviewFixture: OverviewDto = {
  generated_at: "2026-10-21T06:00:00Z",
  range: { from: "2026-10-21T00:00:00Z", to: "2026-10-22T00:00:00Z" },
  scope: "all",
  viewer: { login: ALICE },
  tasks,
  consults: [
    {
      consult_id: cid(11),
      owner_login: ALICE,
      at: "2026-10-21T02:40:00Z",
      model: MODEL_L,
      cost_usd: 0.12,
      estimated: false,
    },
    {
      consult_id: cid(12),
      owner_login: CAROL,
      at: "2026-10-21T03:00:00Z",
      model: MODEL_S,
      cost_usd: 0.05,
      estimated: false,
    },
    {
      consult_id: cid(13),
      owner_login: BOB,
      at: "2026-10-21T04:30:00Z",
      model: MODEL_L,
      cost_usd: 0.2,
      estimated: true,
    },
  ],
  budget: {
    remaining_usd: 38.5,
    spent_usd: 11.4,
    estimated_usd: 0.1,
    reserved_usd: 0,
    max_concurrent_tasks: 19,
    concurrency_limit: 2,
    running_slots: 0,
    startable: 2,
  },
  month: {
    period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
    task_cost_usd: 41.2,
    budget_actual: { spent_usd: 43.9, estimated_usd: 0.4 },
    hidden_tasks: { count: 1, cost_usd: 2.9 },
  },
  models: [
    { model: MODEL_L, task_cost_usd: 30.6, consult_cost_usd: 2.1 },
    { model: MODEL_S, task_cost_usd: 10.6, consult_cost_usd: 0.6 },
  ],
};

/** 「自分」に絞った一覧（タスクと consult は自分の分だけ。月の集計は全員分のまま） */
export const overviewMeFixture: OverviewDto = {
  ...overviewFixture,
  scope: "me",
  tasks: tasks.filter((t) => t.owner_login === ALICE),
  consults: overviewFixture.consults.filter((c) => c.owner_login === ALICE),
};

const runningTask = tasks[3] as VisibleTaskDto;

export const taskDetailRunningFixture: TaskDetailDto = {
  generated_at: "2026-10-21T06:00:00Z",
  task: runningTask,
  phase: "run",
  now: { kind: "command", text: "pnpm exec vitest run" },
  settings: {
    merge_policy: "human_review",
    deps_cache: "hit",
    cache_build_ms: 0,
    sandbox_runtime_ms: 1_080_000,
    sandbox_instance: "standard-2",
    model_selection: { mode: "auto", reason: "clef_flash" },
  },
  output: {
    tail: "RUN  v4.1.12\n ✓ test/a.test.ts (3 tests)\n ✓ test/b.test.ts (5 tests)\n",
    redacted: true,
  },
};

/** 準備（ブランチ・Draft PR の作成）で失敗したタスク */
export const taskDetailFailedSetupFixture: TaskDetailDto = {
  generated_at: "2026-10-21T06:00:00Z",
  task: {
    task_id: tid(6),
    owner_login: CAROL,
    repository: "example-org/web-app",
    title: "存在しないコミットを指定したタスク",
    status: "FAILED",
    model: MODEL_S,
    effort: "medium",
    created_at: "2026-10-21T04:00:00Z",
    started_at: null,
    ended_at: "2026-10-21T04:00:20Z",
    updated_at: "2026-10-21T04:00:20Z",
    cost: cost(0, 0, 0),
    pr: null,
    reason: "base_sha_not_found",
    failure_phase: "setup",
  },
  phase: "prepare",
  now: null,
  settings: { merge_policy: "human_review" },
  output: { tail: null, redacted: true },
};

const events: TaskEventDto[] = [
  { seq: 1, at: "2026-10-21T05:38:00Z", type: "status_changed", to: "CREATING" },
  {
    seq: 2,
    at: "2026-10-21T05:40:00Z",
    type: "status_changed",
    from: "CREATING",
    to: "RUNNING",
  },
  {
    seq: 3,
    at: "2026-10-21T05:41:00Z",
    type: "draft_pr_created",
    pr_number: 23,
    pr_url: "https://github.com/example-org/infra-tools/pull/23",
  },
  { seq: 4, at: "2026-10-21T05:42:00Z", type: "web", kind: "fetch", host: "registry.npmjs.org" },
  {
    seq: 5,
    at: "2026-10-21T05:44:00Z",
    type: "edit",
    path: "scripts/deploy.sh",
    op: "modify",
    added: 12,
    removed: 3,
  },
  {
    seq: 6,
    at: "2026-10-21T05:50:00Z",
    type: "command",
    command: "pnpm exec vitest run",
    cwd: "apps/gateway",
    exit_code: 0,
    duration_ms: 42_000,
    output_tail: "Test Files  3 passed (3)\n",
  },
  {
    seq: 7,
    at: "2026-10-21T05:52:00Z",
    type: "commit",
    message: "デプロイスクリプトの確認を足す",
    sha: SHA,
    files: 2,
  },
  {
    seq: 8,
    at: "2026-10-21T05:53:00Z",
    type: "usage",
    cost_usd: 0.9,
    input_tokens: 70_000,
    output_tokens: 9_000,
    cache_read_tokens: 210_000,
    cache_write_tokens: 17_500,
  },
  { seq: 9, at: "2026-10-21T05:54:00Z", type: "agent_event", agent_type: "future_event_type" },
];

export const taskEventsFixture: TaskEventsPageDto = {
  task_id: runningTask.task_id,
  events,
  oldest_seq: 1,
  newest_seq: 9,
  has_older: false,
};

/** 古い agent の履歴（構造化イベントが無い）。tool_start / tool_end の要約と状態だけで縮退して表示する */
export const legacyTaskEventsFixture: TaskEventsPageDto = {
  task_id: runningTask.task_id,
  events: [
    { seq: 1, at: "2026-10-21T05:40:00Z", type: "status_changed", to: "RUNNING" },
    {
      seq: 2,
      at: "2026-10-21T05:41:00Z",
      type: "tool_start",
      call_id: "call-1",
      name: "bash",
      summary: '{"command":"pnpm exec vitest run"}',
    },
    {
      seq: 3,
      at: "2026-10-21T05:42:00Z",
      type: "tool_end",
      call_id: "call-1",
      is_error: false,
      summary: "Test Files  3 passed (3)",
    },
  ],
  oldest_seq: 1,
  newest_seq: 3,
  has_older: false,
};

/** 一部の項目が取得できない Cloudflare の概要 */
export const cloudflareSummaryFixture: CloudflareSummaryDto = {
  generated_at: "2026-10-21T06:00:00Z",
  open_url: "https://dash.cloudflare.com/example-account/workers",
  containers: {
    ok: true,
    value: {
      period: { start: "2026-10-21T00:00:00Z", end: "2026-10-21T06:00:00Z" },
      running_instances: 1,
      vcpu_seconds: 5_400,
      memory_gib_seconds: 21_600,
    },
  },
  ai_gateway: { ok: false, reason: "forbidden" },
  credit_balance: { ok: false, reason: "unavailable" },
};

export const errorFixtures: ErrorDto[] = [
  { error: "unauthorized" },
  { error: "forbidden" },
  { error: "not_found" },
  { error: "bad_request" },
  { error: "unavailable" },
];
