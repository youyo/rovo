import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checksFailingFixture,
  checksFixture,
  checksNoneFixture,
  checksUnreadableFixture,
  cloudflareSummaryFixture,
  cloudflareSummaryWithEstimateFixture,
  overviewFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "../src/fixtures";
import {
  ChecksDtoSchema,
  CloudflareSummaryDtoSchema,
  ErrorDtoSchema,
  HiddenTasksDtoSchema,
  LIMITS,
  OverviewDtoSchema,
  prUrlSchema,
  TaskDetailDtoSchema,
  TaskEventDtoSchema,
  TaskEventsPageDtoSchema,
  VisibleTaskDtoSchema,
} from "../src/index";

const clone = <T>(v: T): T => structuredClone(v);
const at = "2026-10-21T01:02:03Z";
const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success;

describe("budget の monthly_budget_usd（月の上限）", () => {
  it("fixtures は上限を持ち、スキーマを通る。負の値は弾く。古い応答（無し）も通る", () => {
    expect(overviewFixture.budget.monthly_budget_usd).toBe(49.9);
    expect(ok(OverviewDtoSchema, overviewFixture)).toBe(true);
    const neg = clone(overviewFixture);
    neg.budget.monthly_budget_usd = -1;
    expect(ok(OverviewDtoSchema, neg)).toBe(false);
    const legacy = clone(overviewFixture);
    delete legacy.budget.monthly_budget_usd;
    expect(ok(OverviewDtoSchema, legacy)).toBe(true);
  });
});

describe("見えないタスクの漏れを防ぐ形", () => {
  it("hidden_tasks のキーは count と cost_usd だけ", () => {
    expect(Object.keys(HiddenTasksDtoSchema.shape).sort()).toEqual(["cost_usd", "count"]);
  });
  it("hidden_tasks に個別の情報を足すと弾かれる", () => {
    const base = { count: 1, cost_usd: 1.5 };
    expect(ok(HiddenTasksDtoSchema, base)).toBe(true);
    for (const extra of [
      { task_id: "01K8ZF00000000000000000001" },
      { owner_login: "someone" },
      { repository: "example-org/x" },
      { pr_url: "https://github.com/example-org/x/pull/1" },
      { model: "m" },
      { title: "t" },
      { tasks: [] },
      { items: [{ title: "t" }] },
    ]) {
      expect(ok(HiddenTasksDtoSchema, { ...base, ...extra }), JSON.stringify(extra)).toBe(false);
    }
  });
  it("overview の month に hidden の個別の行を足すと弾かれる", () => {
    const o = clone(overviewFixture) as Record<string, unknown>;
    (o.month as Record<string, unknown>).hidden_list = [{ title: "x" }];
    expect(ok(OverviewDtoSchema, o)).toBe(false);
  });
  it("overview の最上位に未知のキーがあると弾かれる", () => {
    expect(ok(OverviewDtoSchema, { ...clone(overviewFixture), hidden_tasks: [] })).toBe(false);
  });
  it("tasks の行は一部だけの『伏せた行』を許さない（個別の行は全項目が必須）", () => {
    const row = clone(overviewFixture.tasks[0]) as Record<string, unknown>;
    for (const key of ["task_id", "owner_login", "repository", "title", "model", "status"]) {
      const r = clone(row);
      delete r[key];
      expect(ok(VisibleTaskDtoSchema, r), `${key} なし`).toBe(false);
    }
    expect(ok(VisibleTaskDtoSchema, { task_id: row.task_id, status: "RUNNING" })).toBe(false);
  });
  it("カウントと金額は負・小数の件数を許さない", () => {
    expect(ok(HiddenTasksDtoSchema, { count: -1, cost_usd: 0 })).toBe(false);
    expect(ok(HiddenTasksDtoSchema, { count: 1.5, cost_usd: 0 })).toBe(false);
    expect(ok(HiddenTasksDtoSchema, { count: 1, cost_usd: -1 })).toBe(false);
  });
});

describe("秘密になりうる項目がスキーマに無い", () => {
  // `input_tokens` のような数の項目は許し、`token` / `access_token` / `git_token` のような名前を禁じる
  const FORBIDDEN =
    /(^|_)(token|secret|password|passwd|credential|authorization|cookie|instructions|enc|api_?key|private_?key)($|_)/i;
  const names = (schema: z.ZodType): string[] => {
    const out: string[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) {
        for (const x of n) walk(x);
      } else if (n && typeof n === "object") {
        for (const [k, v] of Object.entries(n)) {
          if (k === "properties" && v && typeof v === "object") out.push(...Object.keys(v));
          walk(v);
        }
      }
    };
    walk(z.toJSONSchema(schema, { unrepresentable: "any", io: "output" }));
    return out;
  };
  it("検査自体が働く（token を持つスキーマを検出する）", () => {
    const keys = names(z.strictObject({ a: z.strictObject({ git_token: z.string() }) }));
    expect(keys.filter((k) => FORBIDDEN.test(k))).toEqual(["git_token"]);
    expect(FORBIDDEN.test("input_tokens")).toBe(false);
    expect(FORBIDDEN.test("enc")).toBe(true);
    expect(FORBIDDEN.test("instructions")).toBe(true);
  });
  const schemas = {
    OverviewDto: OverviewDtoSchema,
    TaskDetailDto: TaskDetailDtoSchema,
    TaskEventsPageDto: TaskEventsPageDtoSchema,
    CloudflareSummaryDto: CloudflareSummaryDtoSchema,
    ErrorDto: ErrorDtoSchema,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} は禁止項目（token / secret / instructions / enc など）を持たない`, () => {
      const keys = names(schema);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((k) => FORBIDDEN.test(k))).toEqual([]);
    });
  }
});

describe("文字列の上限と形式", () => {
  const row = overviewFixture.tasks[0] as z.input<typeof VisibleTaskDtoSchema>;
  it("task_id は ULID だけ", () => {
    expect(ok(VisibleTaskDtoSchema, { ...row, task_id: "not-a-ulid" })).toBe(false);
    expect(ok(VisibleTaskDtoSchema, { ...row, task_id: row.task_id.toLowerCase() })).toBe(false);
    expect(ok(VisibleTaskDtoSchema, { ...row, task_id: `${row.task_id}0` })).toBe(false);
  });
  it("時刻は UTC の ISO だけ（オフセット・日付だけ・数値は不可）", () => {
    for (const bad of ["2026-10-21", "2026-10-21T01:02:03+09:00", "yesterday", 1760000000000]) {
      expect(ok(VisibleTaskDtoSchema, { ...row, created_at: bad }), String(bad)).toBe(false);
    }
  });
  it("kind は task / review だけ。無くてもよい（古い応答）", () => {
    expect(ok(VisibleTaskDtoSchema, row)).toBe(true);
    expect(ok(VisibleTaskDtoSchema, { ...row, kind: "task" })).toBe(true);
    expect(ok(VisibleTaskDtoSchema, { ...row, kind: "review" })).toBe(true);
    expect(ok(VisibleTaskDtoSchema, { ...row, kind: "other" })).toBe(false);
  });
  it("title・repository・owner_login・model の上限", () => {
    expect(ok(VisibleTaskDtoSchema, { ...row, title: "あ".repeat(LIMITS.title) })).toBe(true);
    expect(ok(VisibleTaskDtoSchema, { ...row, title: "あ".repeat(LIMITS.title + 1) })).toBe(false);
    expect(ok(VisibleTaskDtoSchema, { ...row, repository: "no-slash" })).toBe(false);
    expect(ok(VisibleTaskDtoSchema, { ...row, repository: "a/b/c" })).toBe(false);
    expect(ok(VisibleTaskDtoSchema, { ...row, owner_login: "a".repeat(40) })).toBe(false);
    expect(ok(VisibleTaskDtoSchema, { ...row, owner_login: "bad login" })).toBe(false);
    expect(ok(VisibleTaskDtoSchema, { ...row, model: "m".repeat(101) })).toBe(false);
  });
  it("model は実在のカタログのキー（Workers AI の `workers-ai/@cf/...` を含む）を通し、空白・制御文字・スクリプトの断片は通さない", () => {
    for (const good of [
      "anthropic/claude-sonnet-5-5",
      "workers-ai/@cf/openai/gpt-oss-120b",
      "openai/gpt-6-sol",
    ]) {
      expect(ok(VisibleTaskDtoSchema, { ...row, model: good }), good).toBe(true);
    }
    for (const bad of ["", "@leading", "a b", "a<script>", "a\nb", "a‮b"]) {
      expect(ok(VisibleTaskDtoSchema, { ...row, model: bad }), JSON.stringify(bad)).toBe(false);
    }
  });
  it("status は 9 状態だけ", () => {
    expect(ok(VisibleTaskDtoSchema, { ...row, status: "UNKNOWN" })).toBe(false);
  });
  it("費用は負・NaN・Infinity を許さない", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ok(VisibleTaskDtoSchema, { ...row, cost: { ...row.cost, cost_usd: bad } })).toBe(
        false,
      );
    }
  });
  it("配列の件数に上限がある", () => {
    const o = clone(overviewFixture);
    o.tasks = Array.from({ length: LIMITS.overviewTasks + 1 }, () => o.tasks[0] as never);
    expect(ok(OverviewDtoSchema, o)).toBe(false);
  });
});

describe("URL の scheme と形", () => {
  it("PR の URL は https://github.com/<owner>/<repo>/pull/<n> に厳密に一致するものだけ", () => {
    expect(ok(prUrlSchema, "https://github.com/example-org/web-app/pull/12")).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://github.com/example-org/web-app/pull/12",
      "https://github.com.evil.com/example-org/web-app/pull/12",
      "https://evil.com/github.com/example-org/web-app/pull/12",
      "https://github.com/example-org/web-app/pull/12?x=1",
      "https://github.com/example-org/web-app/pull/12#frag",
      "https://github.com/example-org/web-app/pull/12/files",
      "https://github.com/example-org/web-app/issues/12",
      "https://user@github.com/example-org/web-app/pull/12",
      "https://github.com/example-org/web-app/pull/0",
      " https://github.com/example-org/web-app/pull/12",
      `https://github.com/example-org/web-app/pull/12${"0".repeat(300)}`,
    ]) {
      expect(ok(prUrlSchema, bad), bad).toBe(false);
    }
  });
  it("タスクの pr.url に危険な scheme は入らない", () => {
    const row = clone(overviewFixture.tasks[0]) as Record<string, unknown>;
    row.pr = {
      number: 1,
      url: "javascript:alert(1)",
      draft: true,
      merged: false,
      state: "open",
    };
    expect(ok(VisibleTaskDtoSchema, row)).toBe(false);
  });
  it("pr.state は open / merged / closed / unknown だけ。必須（欠けても、別の値でも弾く）", () => {
    const withState = (state: unknown) => {
      const row = clone(overviewFixture.tasks[0]) as { pr: Record<string, unknown> };
      if (state === undefined) row.pr.state = undefined;
      else row.pr.state = state;
      return row;
    };
    for (const good of ["open", "merged", "closed", "unknown"]) {
      expect(ok(VisibleTaskDtoSchema, withState(good)), good).toBe(true);
    }
    for (const bad of [undefined, "OPEN", "MERGED", "draft", "", null, 1]) {
      expect(ok(VisibleTaskDtoSchema, withState(bad)), String(bad)).toBe(false);
    }
  });
  it("Cloudflare の開くリンクは https://dash.cloudflare.com/ 配下だけ", () => {
    const s = clone(cloudflareSummaryFixture) as Record<string, unknown>;
    for (const bad of [
      "javascript:alert(1)",
      "http://dash.cloudflare.com/x",
      "https://evil.com/",
      "https://dash.cloudflare.com.evil.com/",
    ]) {
      expect(ok(CloudflareSummaryDtoSchema, { ...s, open_url: bad }), bad).toBe(false);
    }
    expect(
      ok(CloudflareSummaryDtoSchema, {
        ...s,
        open_url: "https://dash.cloudflare.com/example/workers",
      }),
    ).toBe(true);
    expect(ok(CloudflareSummaryDtoSchema, { ...s, open_url: null })).toBe(true);
  });
});

describe("構造化イベント（D14）は非信頼データとして上限と形式を持つ", () => {
  const base = { seq: 1, at };
  const cmd = {
    ...base,
    type: "command",
    command: "pnpm test",
    cwd: "apps/gateway",
    exit_code: 0,
    duration_ms: 1200,
    output_tail: "ok",
  };
  it("command: 長さの上限", () => {
    expect(ok(TaskEventDtoSchema, cmd)).toBe(true);
    expect(ok(TaskEventDtoSchema, { ...cmd, command: "x".repeat(LIMITS.command) })).toBe(true);
    expect(ok(TaskEventDtoSchema, { ...cmd, command: "x".repeat(LIMITS.command + 1) })).toBe(false);
    expect(ok(TaskEventDtoSchema, { ...cmd, output_tail: "x".repeat(LIMITS.outputTail + 1) })).toBe(
      false,
    );
    expect(ok(TaskEventDtoSchema, { ...cmd, cwd: "/etc" })).toBe(false);
    expect(ok(TaskEventDtoSchema, { ...cmd, cwd: "../x" })).toBe(false);
  });
  const edit = { ...base, type: "edit", path: "src/a.ts", op: "modify", added: 3, removed: 1 };
  it("edit: パスは相対・.. なし・制御文字なし・上限", () => {
    expect(ok(TaskEventDtoSchema, edit)).toBe(true);
    for (const bad of [
      "/etc/passwd",
      "../x",
      "a/../../x",
      "a/..",
      "a\u0000b",
      "a\nb",
      "C:\\x",
      "x".repeat(LIMITS.path + 1),
      "",
    ]) {
      expect(ok(TaskEventDtoSchema, { ...edit, path: bad }), JSON.stringify(bad)).toBe(false);
    }
    expect(ok(TaskEventDtoSchema, { ...edit, op: "rename" })).toBe(false);
    expect(ok(TaskEventDtoSchema, { ...edit, diff: "+++ b" })).toBe(false);
  });
  const commit = { ...base, type: "commit", message: "fix: 直す", sha: "a".repeat(40), files: 2 };
  it("commit: 1 行目だけ・上限・40 桁の sha", () => {
    expect(ok(TaskEventDtoSchema, commit)).toBe(true);
    expect(ok(TaskEventDtoSchema, { ...commit, message: "a\nb" })).toBe(false);
    expect(
      ok(TaskEventDtoSchema, { ...commit, message: "x".repeat(LIMITS.commitMessage + 1) }),
    ).toBe(false);
    expect(ok(TaskEventDtoSchema, { ...commit, sha: "abc" })).toBe(false);
    expect(ok(TaskEventDtoSchema, { ...commit, sha: "G".repeat(40) })).toBe(false);
  });
  const web = { ...base, type: "web", kind: "fetch", host: "registry.npmjs.org" };
  it("web: host だけ（URL のパス・クエリ・scheme を持てない）", () => {
    expect(ok(TaskEventDtoSchema, web)).toBe(true);
    for (const bad of [
      "https://example.com",
      "example.com/path",
      "example.com?q=1",
      "user@example.com",
      "javascript:alert(1)",
      "a b",
    ]) {
      expect(ok(TaskEventDtoSchema, { ...web, host: bad }), bad).toBe(false);
    }
    expect(ok(TaskEventDtoSchema, { ...web, kind: "download" })).toBe(false);
  });
  it("tool_start / tool_end / 状態 / usage / 未知の型の縮退", () => {
    expect(
      ok(TaskEventDtoSchema, {
        ...base,
        type: "tool_start",
        call_id: "c1",
        name: "bash",
        summary: "ls",
      }),
    ).toBe(true);
    expect(
      ok(TaskEventDtoSchema, {
        ...base,
        type: "tool_start",
        call_id: "c1",
        name: "bash",
        summary: "x".repeat(LIMITS.summary + 1),
      }),
    ).toBe(false);
    expect(
      ok(TaskEventDtoSchema, {
        ...base,
        type: "tool_end",
        call_id: "c1",
        is_error: false,
        summary: "ok",
      }),
    ).toBe(true);
    expect(
      ok(TaskEventDtoSchema, { ...base, type: "status_changed", from: "RUNNING", to: "VERIFYING" }),
    ).toBe(true);
    expect(ok(TaskEventDtoSchema, { ...base, type: "status_changed", to: "BOGUS" })).toBe(false);
    expect(
      ok(TaskEventDtoSchema, {
        ...base,
        type: "usage",
        cost_usd: 0.5,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      }),
    ).toBe(true);
    expect(
      ok(TaskEventDtoSchema, { ...base, type: "agent_event", agent_type: "future_thing" }),
    ).toBe(true);
    // 型名以外（中身）は通さない
    expect(
      ok(TaskEventDtoSchema, { ...base, type: "agent_event", agent_type: "x", payload: { a: 1 } }),
    ).toBe(false);
  });
  it("定義にない type は弾かれる", () => {
    expect(ok(TaskEventDtoSchema, { ...base, type: "raw_dump", data: "x" })).toBe(false);
  });
  it("seq は 1 以上の整数、ページは 200 件まで", () => {
    expect(ok(TaskEventDtoSchema, { ...cmd, seq: 0 })).toBe(false);
    expect(ok(TaskEventDtoSchema, { ...cmd, seq: 1.5 })).toBe(false);
    const page = clone(taskEventsFixture);
    page.events = Array.from({ length: LIMITS.eventsPerPage + 1 }, (_, i) => ({
      ...cmd,
      seq: i + 1,
    })) as never;
    expect(ok(TaskEventsPageDtoSchema, page)).toBe(false);
  });
});

describe("詳細・Cloudflare・エラー", () => {
  it("詳細は『秘密を伏せている』が常に true", () => {
    expect(taskDetailRunningFixture.output.redacted).toBe(true);
    const d = clone(taskDetailRunningFixture) as Record<string, unknown>;
    (d.output as Record<string, unknown>).redacted = false;
    expect(ok(TaskDetailDtoSchema, d)).toBe(false);
  });
  it("詳細の output は『実行中』の印と開始時刻を持てる（任意。古い応答もそのまま通る）", () => {
    expect(ok(TaskDetailDtoSchema, clone(taskDetailRunningFixture))).toBe(true);
    const withRunning = (extra: Record<string, unknown>) => {
      const d = clone(taskDetailRunningFixture) as Record<string, unknown>;
      d.output = { ...(d.output as Record<string, unknown>), ...extra };
      return d;
    };
    expect(
      ok(TaskDetailDtoSchema, withRunning({ running: true, started_at: "2026-10-21T05:50:00Z" })),
    ).toBe(true);
    // running は true だけ（false は『印を付けない』で表す）。開始時刻は ISO 8601
    expect(ok(TaskDetailDtoSchema, withRunning({ running: false }))).toBe(false);
    expect(ok(TaskDetailDtoSchema, withRunning({ running: true, started_at: "yesterday" }))).toBe(
      false,
    );
  });
  it("詳細に instructions / token / enc を足すと弾かれる", () => {
    for (const k of ["instructions", "token", "enc", "git_token"]) {
      expect(ok(TaskDetailDtoSchema, { ...clone(taskDetailRunningFixture), [k]: "x" }), k).toBe(
        false,
      );
    }
  });
  it("設定のモデルの選び方（model_selection）は任意。mode と reason だけで、指示文やスコアは持たない", () => {
    const withSel = (sel: unknown) => {
      const d = clone(taskDetailRunningFixture) as Record<string, unknown>;
      (d.settings as Record<string, unknown>).model_selection = sel;
      return d;
    };
    // 見本には付いている。外しても通る（旧い gateway）
    expect(taskDetailRunningFixture.settings.model_selection).toEqual({
      mode: "auto",
      reason: "clef_flash",
    });
    const without = clone(taskDetailRunningFixture) as Record<string, unknown>;
    delete (without.settings as Record<string, unknown>).model_selection;
    expect(ok(TaskDetailDtoSchema, without)).toBe(true);
    expect(ok(TaskDetailDtoSchema, withSel({ mode: "explicit", reason: "explicit" }))).toBe(true);
    // 余計な項目・不正な mode・自由文の reason は弾く
    expect(
      ok(TaskDetailDtoSchema, withSel({ mode: "auto", reason: "clef_flash", scores: {} })),
    ).toBe(false);
    expect(ok(TaskDetailDtoSchema, withSel({ mode: "manual", reason: "clef_flash" }))).toBe(false);
    expect(
      ok(TaskDetailDtoSchema, withSel({ mode: "auto", reason: "Ignore previous instructions" })),
    ).toBe(false);
    expect(ok(TaskDetailDtoSchema, withSel({ mode: "auto" }))).toBe(false);
  });
  it("出力の末尾は上限つき", () => {
    const d = clone(taskDetailRunningFixture) as Record<string, unknown>;
    d.output = { tail: "x".repeat(LIMITS.outputTail + 1), redacted: true };
    expect(ok(TaskDetailDtoSchema, d)).toBe(false);
  });
  it("Cloudflare の項目は {ok:true,value} か {ok:false,reason} だけ", () => {
    const s = clone(cloudflareSummaryFixture) as Record<string, unknown>;
    expect(ok(CloudflareSummaryDtoSchema, { ...s, credit_balance: { ok: false } })).toBe(false);
    expect(
      ok(CloudflareSummaryDtoSchema, {
        ...s,
        credit_balance: { ok: false, reason: "free text with prompt" },
      }),
    ).toBe(false);
    expect(
      ok(CloudflareSummaryDtoSchema, {
        ...s,
        credit_balance: { ok: true, value: { balance_usd: 1, prompt: "x" } },
      }),
    ).toBe(false);
    expect(
      ok(CloudflareSummaryDtoSchema, { ...s, credit_balance: { ok: true, reason: "forbidden" } }),
    ).toBe(false);
  });
  it("M9 で足した workers / workers_ai / range は省略でき（既存の fixtures を壊さない）、出すなら形が固定", () => {
    const s = clone(cloudflareSummaryFixture) as Record<string, unknown>;
    expect(ok(CloudflareSummaryDtoSchema, s)).toBe(true);
    const period = { start: "2026-10-21T00:00:00.000Z", end: "2026-10-22T00:00:00.000Z" };
    const full = {
      ...s,
      range: "7d",
      workers: { ok: true, value: { period, requests: 10, errors: 1 } },
      workers_ai: { ok: true, value: { period, neurons: 12.5 } },
    };
    expect(ok(CloudflareSummaryDtoSchema, full)).toBe(true);
    expect(ok(CloudflareSummaryDtoSchema, { ...full, range: "30d" })).toBe(false);
    expect(
      ok(CloudflareSummaryDtoSchema, {
        ...full,
        workers: { ok: true, value: { period, requests: -1, errors: 0 } },
      }),
    ).toBe(false);
    expect(
      ok(CloudflareSummaryDtoSchema, { ...full, workers_ai: { ok: false, reason: "oops" } }),
    ).toBe(false);
    expect(
      ok(CloudflareSummaryDtoSchema, {
        ...full,
        workers: { ok: true, value: { period, requests: 1, errors: 0, url: "x" } },
      }),
    ).toBe(false);
  });
  it("合計は Cloudflare の請求の推定だけ（AI Gateway を含まない）。古い応答（excluded_items に ai_gateway）も通る", () => {
    const withEstimate = clone(cloudflareSummaryWithEstimateFixture) as Record<string, unknown>;
    const est = withEstimate.cost_estimate as Record<string, unknown>;
    const items = est.items as Record<string, Record<string, unknown>>;
    // 合計 = Cloudflare の 5 項目の取れた推定の和（AI Gateway の cost_usd は含まない）
    const cfKeys = [
      "workers_requests",
      "containers_vcpu",
      "containers_memory",
      "containers_disk",
      "workers_ai",
    ];
    const sum = cfKeys.reduce(
      (acc, k) => acc + ((items[k]?.estimated_usd_before_free_tier as number | null) ?? 0),
      0,
    );
    expect(est.total_estimated_usd_before_free_tier as number).toBeCloseTo(sum, 9);
    expect(items.ai_gateway?.cost_usd).toBe(1.25);
    expect(ok(CloudflareSummaryDtoSchema, withEstimate)).toBe(true);
    // AI Gateway だけが取れない応答は、partial にならない（excluded_items に ai_gateway は出ない）
    const gwOnly = clone(withEstimate) as Record<string, unknown>;
    const gwEst = gwOnly.cost_estimate as Record<string, unknown>;
    (gwEst.items as Record<string, Record<string, unknown>>).ai_gateway = { cost_usd: null };
    gwEst.excluded_items = [];
    gwEst.partial = false;
    gwEst.total_estimated_usd_before_free_tier = 0.0892225;
    expect(ok(CloudflareSummaryDtoSchema, gwOnly)).toBe(true);
    // 古い応答: excluded_items に ai_gateway が入っていても通る（列挙は残す）
    const legacy = clone(withEstimate) as Record<string, unknown>;
    (legacy.cost_estimate as Record<string, unknown>).excluded_items = ["ai_gateway"];
    expect(ok(CloudflareSummaryDtoSchema, legacy)).toBe(true);
  });

  it("推定の金額（cost_estimate）は省略でき、古い応答（無し）も通る。出すなら『無料枠を引く前』の形で固定", () => {
    // 古い応答（cost_estimate が無い fixtures・M9 の応答）は通る
    const old = clone(cloudflareSummaryFixture) as Record<string, unknown>;
    expect("cost_estimate" in old).toBe(false);
    expect(ok(CloudflareSummaryDtoSchema, old)).toBe(true);
    // 新しい項目付き（取得できない項目の推定は null）も通る
    const withEstimate = clone(cloudflareSummaryWithEstimateFixture) as Record<string, unknown>;
    const est = withEstimate.cost_estimate as Record<string, unknown>;
    expect(ok(CloudflareSummaryDtoSchema, withEstimate)).toBe(true);
    expect(est.basis).toBe("before_free_tier");
    const items = est.items as Record<string, { estimated_usd_before_free_tier?: number | null }>;
    const disk = items.containers_disk;
    if (!disk) throw new Error("containers_disk の項目が無い");
    expect(disk.estimated_usd_before_free_tier).toBeNull();
    expect(est.excluded_items).toContain("containers_disk");
    // 全項目が取れないとき（合計も null）も通る
    const nothing = clone(est) as Record<string, unknown>;
    const nothingItems = clone(items) as Record<string, Record<string, unknown>>;
    for (const line of Object.values(nothingItems)) {
      if ("estimated_usd_before_free_tier" in line) {
        line.quantity = null;
        line.estimated_usd_before_free_tier = null;
      } else {
        line.cost_usd = null;
      }
    }
    nothing.items = nothingItems;
    nothing.total_estimated_usd_before_free_tier = null;
    nothing.partial = true;
    expect(ok(CloudflareSummaryDtoSchema, { ...old, cost_estimate: nothing })).toBe(true);
    // 形は固定: 基準が違う・負の金額・未知のキー・足りない項目・日付の形が違う は弾く
    // workers_requests の行を取り出す（無ければテストを失敗させる）
    const workersRequestsLine = (e: Record<string, unknown>): Record<string, unknown> => {
      const lines = e.items as Record<string, Record<string, unknown>>;
      const line = lines.workers_requests;
      if (!line) throw new Error("workers_requests の項目が無い");
      return line;
    };
    const bad = (patch: (e: Record<string, unknown>) => void) => {
      const e = clone(est) as Record<string, unknown>;
      patch(e);
      return ok(CloudflareSummaryDtoSchema, { ...old, cost_estimate: e });
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((e) => (e.basis = "after_free_tier"))).toBe(false);
    expect(bad((e) => (e.total_estimated_usd_before_free_tier = -1))).toBe(false);
    expect(bad((e) => (e.total_estimated_usd_before_free_tier = "1.5"))).toBe(false);
    expect(bad((e) => (e.pricing_checked_at = "2026/10/22"))).toBe(false);
    expect(bad((e) => (e.pricing_checked_at = null))).toBe(true); // 未確認
    expect(bad((e) => (e.excluded_items = ["workers"]))).toBe(false);
    expect(bad((e) => (e.note = "x"))).toBe(false);
    expect(bad((e) => delete (e.items as Record<string, unknown>).workers_ai)).toBe(false);
    expect(
      bad((e) => {
        workersRequestsLine(e).unit_price_usd = -1;
      }),
    ).toBe(false);
    expect(
      bad((e) => {
        workersRequestsLine(e).unit = "request_x";
      }),
    ).toBe(false);
  });
  it("エラーの本文に理由を出せない（コードだけ）", () => {
    expect(ok(ErrorDtoSchema, { error: "not_found" })).toBe(true);
    expect(
      ok(ErrorDtoSchema, { error: "not_found", message: "task X exists but you cannot see it" }),
    ).toBe(false);
    expect(ok(ErrorDtoSchema, { error: "forbidden_repo_name" })).toBe(false);
  });
});

describe("ChecksDto（PR の CI）", () => {
  const run = {
    name: "build",
    kind: "check_run" as const,
    status: "completed" as const,
    conclusion: "success",
    started_at: at,
    completed_at: at,
    url: "https://github.com/example-org/web-app/actions/runs/1",
  };
  const base = {
    head_sha: "a".repeat(40),
    state: "passing" as const,
    checks: [run],
    truncated: false,
    partial: false,
  };

  it("fixtures はスキーマを通る", () => {
    for (const f of [
      checksFixture,
      checksFailingFixture,
      checksNoneFixture,
      checksUnreadableFixture,
    ]) {
      expect(ok(ChecksDtoSchema, f)).toBe(true);
    }
  });
  it("最小の形を通し、未知の項目は弾く", () => {
    expect(ok(ChecksDtoSchema, base)).toBe(true);
    expect(ok(ChecksDtoSchema, { ...base, extra: 1 })).toBe(false);
    expect(ok(ChecksDtoSchema, { ...base, checks: [{ ...run, extra: 1 }] })).toBe(false);
  });
  it("PR が無い（none・head_sha は null・checks は空）", () => {
    expect(ok(ChecksDtoSchema, { ...base, head_sha: null, state: "none", checks: [] })).toBe(true);
  });
  it("state / kind / status の列挙の外は弾く", () => {
    expect(ok(ChecksDtoSchema, { ...base, state: "ok" })).toBe(false);
    expect(ok(ChecksDtoSchema, { ...base, checks: [{ ...run, kind: "app" }] })).toBe(false);
    expect(ok(ChecksDtoSchema, { ...base, checks: [{ ...run, status: "done" }] })).toBe(false);
  });
  it("url は https://github.com/ の外を通さない（javascript: ・他ホスト・userinfo・空白）", () => {
    for (const url of [
      "javascript:alert(1)",
      "http://github.com/a/b",
      "https://evil.example/x",
      "https://github.com.evil.example/x",
      "https://github.com@evil.example/x",
      "https://github.com/a b",
      "//github.com/a",
    ]) {
      expect(ok(ChecksDtoSchema, { ...base, checks: [{ ...run, url }] })).toBe(false);
    }
    expect(ok(ChecksDtoSchema, { ...base, checks: [{ ...run, url: null }] })).toBe(true);
  });
  it("head_sha は 40 桁の小文字 16 進だけ、時刻は UTC の ISO だけ", () => {
    expect(ok(ChecksDtoSchema, { ...base, head_sha: "xyz" })).toBe(false);
    expect(ok(ChecksDtoSchema, { ...base, checks: [{ ...run, started_at: "yesterday" }] })).toBe(
      false,
    );
  });
  it("名前は 200 文字まで、checks は 200 件まで", () => {
    expect(ok(ChecksDtoSchema, { ...base, checks: [{ ...run, name: "n".repeat(201) }] })).toBe(
      false,
    );
    expect(ok(ChecksDtoSchema, { ...base, checks: Array.from({ length: 201 }, () => run) })).toBe(
      false,
    );
    expect(ok(ChecksDtoSchema, { ...base, checks: Array.from({ length: 200 }, () => run) })).toBe(
      true,
    );
  });
});
