import { runInDurableObject } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import {
  BudgetMeDtoSchema,
  CloudflareSummaryDtoSchema,
  ErrorDtoSchema,
  OverviewDtoSchema,
  TaskDetailDtoSchema,
  TaskEventsPageDtoSchema,
  WaitingDtoSchema,
} from "@rovo/dashboard-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEDGER_CACHE_TTL_MS,
  readApiTuning,
  resetLedgerCache,
  snapshotToVisibleTask,
} from "../../src/dashboard/api";
import { handleDashboard } from "../../src/dashboard/serve";
import { SESSION_COOKIE, sealSession } from "../../src/dashboard/session";
import { DIRECTORY_NAME, type TaskIndexSnapshot } from "../../src/directory/types";
import { ulid } from "../../src/tasks/ulid";
import { createTask, runToCompleted } from "./pr-helpers";

// ダッシュボードの読み取り API（docs/specs/dashboard.md M5b）。認可の最後の関門なので、
// 「見えないタスクが応答のどこにも出ない」「失敗は fail closed」を、実 TaskDO・実 DirectoryDO で確かめる。
// UserDO だけは偽物（視聴者の見えるリポジトリの集合・予算・許可ルールを、テストが自由に差し込む）。

// 他の利用者の台帳のキャッシュ（モジュールの状態）がテスト間で残らないようにする
beforeEach(() => resetLedgerCache());

const BASE = workerEnv.PUBLIC_BASE_URL;
const ENC_KEY = (workerEnv as unknown as { TOKEN_ENC_KEY: string }).TOKEN_ENC_KEY;
const SAME = { "sec-fetch-site": "same-origin" };
const HOUR = 3_600_000;

type VisibleResult =
  | { ok: true; ids: number[] }
  | { ok: false; code: "unauthenticated" | "denied" | "unavailable" | "too_large" };

interface Viewer {
  uid: number;
  login: string;
  /** authorizeDashboardSession の結果 */
  session: { ok: true } | { ok: false; kind: "unauthenticated" | "unavailable" };
  visible: VisibleResult;
  budget: Record<string, unknown>;
  visibleCalls: { fresh: boolean }[];
  /** dashboardPullStates に渡された呼び出し（権限の判定の後に、見えるタスクの PR だけが渡る） */
  pullCalls: { uid: number; refs: { repository: string; number: number }[] }[];
  /** dashboardPullStates の応答（キーは "owner/name#番号"。無ければ unknown）。関数なら任意の戻り値・例外にできる */
  pullStates:
    | Record<string, string>
    | ((refs: { repository: string; number: number }[]) => unknown | Promise<unknown>);
  /** 他の利用者の台帳（キーは uid）。無い利用者は 0。"throw" なら dashboardMonthSpent が例外になる */
  ledgers: Record<number, { spent_usd: number; estimated_usd: number } | "throw">;
  /** 他の利用者の dashboardMonthSpent の呼び出し（uid）。閲覧者本人の分は数えない */
  ledgerCalls: number[];
}

let nextUid = 70_000_000 + Math.floor(Math.random() * 1_000_000);
let nextRepo = 8_000_000 + Math.floor(Math.random() * 1_000_000);
const newRepoId = () => nextRepo++;

function newViewer(visibleIds: number[] = []): Viewer {
  nextUid += 1;
  return {
    uid: nextUid,
    login: `viewer-${nextUid}`,
    session: { ok: true },
    visible: { ok: true, ids: visibleIds },
    budget: {
      monthly_budget_usd: 100,
      spent_usd: 12.5,
      estimated_usd: 0.5,
      reserved_usd: 10,
      remaining_usd: 77.5,
      task_budget_usd: 10,
      consult_budget_usd: 1,
      max_concurrent_tasks: 7,
      concurrency_limit: 3,
      period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
      running_slots: 1,
    },
    visibleCalls: [],
    pullCalls: [],
    pullStates: {},
    ledgers: {},
    ledgerCalls: [],
  };
}

function envFor(viewer: Viewer): Env {
  const userDo = {
    getByName(name: string) {
      if (name !== String(viewer.uid)) {
        // 閲覧者以外の UserDO に許すのは、全員分の台帳の集計（dashboardMonthSpent）だけ
        return {
          async dashboardMonthSpent() {
            viewer.ledgerCalls.push(Number(name));
            const l = viewer.ledgers[Number(name)];
            if (l === "throw") throw new Error("ledger down");
            return {
              spent_micro: Math.round((l?.spent_usd ?? 0) * 1e6),
              estimated_micro: Math.round((l?.estimated_usd ?? 0) * 1e6),
            };
          },
        };
      }
      return {
        async dashboardMonthSpent() {
          return {
            spent_micro: Math.round((viewer.budget.spent_usd as number) * 1e6),
            estimated_micro: Math.round((viewer.budget.estimated_usd as number) * 1e6),
          };
        },
        async authorizeDashboardSession() {
          return viewer.session.ok
            ? { ok: true, login: viewer.login }
            : { ok: false, kind: viewer.session.kind };
        },
        async visibleRepositoryIds(_uid: number, opts: { fresh?: boolean } = {}) {
          viewer.visibleCalls.push({ fresh: opts.fresh === true });
          return viewer.visible;
        },
        async dashboardBudget() {
          return viewer.budget;
        },
        async dashboardPullStates(
          uid: number,
          refs: { repository: string; number: number }[],
        ): Promise<unknown> {
          viewer.pullCalls.push({ uid, refs });
          const src = viewer.pullStates;
          if (typeof src === "function") return src(refs);
          return refs.map((r) => src[`${r.repository}#${r.number}`] ?? "unknown");
        },
      };
    },
  };
  return { ...workerEnv, USER_DO: userDo } as unknown as Env;
}

async function cookieFor(viewer: Viewer): Promise<string> {
  const now = Date.now();
  const value = await sealSession(ENC_KEY, {
    uid: viewer.uid,
    sid: "s".repeat(43),
    ver: 1,
    iat: now,
    exp: now + HOUR,
  });
  return `${SESSION_COOKIE}=${value}`;
}

async function api(viewer: Viewer, path: string, init: RequestInit & { noCookie?: boolean } = {}) {
  const { noCookie, headers, ...rest } = init;
  const cookie: Record<string, string> = noCookie ? {} : { cookie: await cookieFor(viewer) };
  const res = await handleDashboard(
    new Request(`${BASE}/dashboard/api${path}`, {
      ...rest,
      headers: { ...SAME, ...cookie, ...(headers as Record<string, string>) },
    }),
    envFor(viewer),
  );
  const text = await res.text();
  return {
    res,
    text,
    status: res.status,
    json: () => JSON.parse(text) as unknown,
    /** 状態・ヘッダの値・本文を 1 つにつないだ文字列（応答全体の検索用） */
    whole: `${res.status}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${text}`,
  };
}

const range = () => {
  const now = Date.now();
  return `from=${now - HOUR}&to=${now + HOUR}`;
};
const overviewPath = (extra = "") => `/overview?${range()}${extra}`;

/** TaskDO を作り、その view（TaskDO の今の値）を Directory にも入れる。overrides は TaskDO の入力。 */
async function seedTask(
  overrides: Record<string, unknown>,
  opts: { index?: Partial<TaskIndexSnapshot> } = {},
) {
  const t = await createTask(overrides, 4_001);
  const read = await t.stub.dashboardRead();
  const view = read.ok ? read.view : null;
  if (view) {
    const dir = workerEnv.DIRECTORY_DO.getByName(DIRECTORY_NAME);
    const up = await dir.upsertTask({ ...view, ...opts.index }, 1);
    if (!up.ok) throw new Error(`upsert failed: ${up.code}`);
  }
  return { ...t, view };
}

describe("ヘッダ・入口の検査", () => {
  it("API の JSON に nosniff と no-store が付き、CORS ヘッダが無い（成功も失敗も）", async () => {
    const v = newViewer([newRepoId()]);
    for (const path of [overviewPath(), "/budget", "/tasks/01JZ0000000000000000000000"]) {
      const { res } = await api(v, path);
      expect(res.headers.get("content-type"), path).toBe("application/json");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect([...res.headers.keys()].some((k) => k.startsWith("access-control-"))).toBe(false);
    }
  });

  it("Sec-Fetch-Site が cross-site・same-site・無い呼び出しは 403（読み取りでも）", async () => {
    const v = newViewer([newRepoId()]);
    for (const site of ["cross-site", "same-site", undefined]) {
      const headers: Record<string, string> = { cookie: await cookieFor(v) };
      if (site !== undefined) headers["sec-fetch-site"] = site;
      const res = await handleDashboard(
        new Request(`${BASE}/dashboard/api${overviewPath()}`, { headers }),
        envFor(v),
      );
      expect(res.status, String(site)).toBe(403);
    }
  });

  it("未ログイン・壊れた Cookie は 401（ErrorDto の形）。GET 以外は 405", async () => {
    const v = newViewer([newRepoId()]);
    for (const path of [overviewPath(), "/budget", "/tasks/01JZ0000000000000000000000"]) {
      const none = await api(v, path, { noCookie: true });
      expect(none.status, path).toBe(401);
      expect(ErrorDtoSchema.parse(none.json())).toEqual({ error: "unauthorized" });
      const broken = await api(v, path, {
        noCookie: true,
        headers: { cookie: `${SESSION_COOKIE}=broken` },
      });
      expect(broken.status, path).toBe(401);
    }
    const post = await api(v, overviewPath(), { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("入力の検査: from / to / scope の不正は 400（ErrorDto）。認証が先（未ログインは 401）", async () => {
    const v = newViewer([newRepoId()]);
    const now = Date.now();
    const bad = [
      "/overview",
      `/overview?from=${now}`,
      `/overview?from=${now}&to=${now}`,
      `/overview?from=${now + HOUR}&to=${now}`,
      `/overview?from=abc&to=${now}`,
      `/overview?from=${now - 37 * HOUR}&to=${now}`, // 36 時間を超える
      `/overview?from=1.5&to=${now}`,
      overviewPath("&scope=everyone"),
    ];
    for (const path of bad) {
      const r = await api(v, path);
      expect(r.status, path).toBe(400);
      expect(ErrorDtoSchema.parse(r.json())).toEqual({ error: "bad_request" });
    }
    const unauth = await api(v, "/overview", { noCookie: true });
    expect(unauth.status).toBe(401);
    // 36 時間ちょうどは通る
    const ok = await api(v, `/overview?from=${now - 36 * HOUR}&to=${now}`);
    expect(ok.status).toBe(200);
  });

  it("タスク ID の形が不正・未知の経路は 404（見えないタスクと同じ本文）", async () => {
    const v = newViewer([newRepoId()]);
    const bodies = new Set<string>();
    for (const path of ["/tasks/not-a-ulid", "/tasks/01JZ0000000000000000000000/other", "/nope"]) {
      const r = await api(v, path);
      expect(r.status, path).toBe(404);
      bodies.add(r.text);
    }
    expect(bodies.size).toBe(1);
  });
});

describe("overview", () => {
  it("見えるリポジトリのタスクだけが tasks に出て、見えないタスクは件数と合計だけ（D7）", async () => {
    const visibleRepo = newRepoId();
    const hiddenRepo = newRepoId();
    const v = newViewer([visibleRepo]);
    const before = OverviewDtoSchema.parse((await api(v, overviewPath())).json());

    const shown = await seedTask({ repository_id: visibleRepo, title: "SHOWN-TASK" });
    const hidden = await seedTask(
      { repository_id: hiddenRepo, title: "HIDDEN-TASK-TITLE" },
      { index: { cost_micro: 2_500_000 } },
    );
    const r = await api(v, overviewPath());
    expect(r.status).toBe(200);
    const dto = OverviewDtoSchema.parse(r.json());
    expect(dto.tasks.map((t) => t.task_id)).toContain(shown.id);
    expect(dto.tasks.map((t) => t.task_id)).not.toContain(hidden.id);
    expect(dto.scope).toBe("all");
    expect(dto.viewer).toEqual({ login: v.login });
    expect(dto.month.hidden_tasks.count - before.month.hidden_tasks.count).toBe(1);
    expect(dto.month.hidden_tasks.cost_usd - before.month.hidden_tasks.cost_usd).toBeCloseTo(2.5);
    expect(dto.month.task_cost_usd - before.month.task_cost_usd).toBeCloseTo(2.5);
    expect(r.text).not.toContain("HIDDEN-TASK-TITLE");
    expect(r.text).not.toContain(hidden.id);
  });

  it("scope=me は所有者が閲覧者のタスクだけ。見えなくなったタスクは自分のものでも出ない", async () => {
    const repo = newRepoId();
    const lost = newRepoId();
    const v = newViewer([repo]);
    const mine = await seedTask({ repository_id: repo }, { index: { owner_id: v.uid } });
    const others = await seedTask({ repository_id: repo }, { index: { owner_id: v.uid + 999 } });
    const myLost = await seedTask({ repository_id: lost }, { index: { owner_id: v.uid } });

    const ids = async (q: string) =>
      OverviewDtoSchema.parse((await api(v, overviewPath(q))).json()).tasks.map((t) => t.task_id);
    const all = await ids("");
    expect(all).toContain(mine.id);
    expect(all).toContain(others.id);
    const me = await ids("&scope=me");
    expect(me).toContain(mine.id);
    expect(me).not.toContain(others.id);
    expect(me).not.toContain(myLost.id);
    expect(all).not.toContain(myLost.id);
  });

  it("Workers AI のカタログのキー（workers-ai/@cf/...）のモデルのタスクも、一覧に出る（契約が弾かない）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const model = "workers-ai/@cf/openai/gpt-oss-120b";
    const t = await seedTask({ repository_id: repo }, { index: { model } });
    const r = await api(v, overviewPath());
    expect(r.status).toBe(200);
    const dto = OverviewDtoSchema.parse(r.json());
    expect(dto.tasks.find((x) => x.task_id === t.id)?.model).toBe(model);
    expect(dto.models.some((m) => m.model === model)).toBe(true);
  });

  it("見える集合が空なら何も見えない（「制限なし」ではない）", async () => {
    const repo = newRepoId();
    const v = newViewer([]);
    const t = await seedTask({ repository_id: repo });
    const dto = OverviewDtoSchema.parse((await api(v, overviewPath())).json());
    expect(dto.tasks).toEqual([]);
    expect(JSON.stringify(dto)).not.toContain(t.id);
  });

  it("budget は視聴者本人の値。startable = min(max_concurrent_tasks, concurrency_limit - running_slots)", async () => {
    const v = newViewer([newRepoId()]);
    const dto = OverviewDtoSchema.parse((await api(v, overviewPath())).json());
    expect(dto.budget).toEqual({
      monthly_budget_usd: 100,
      remaining_usd: 77.5,
      spent_usd: 12.5,
      estimated_usd: 0.5,
      reserved_usd: 10,
      max_concurrent_tasks: 7,
      concurrency_limit: 3,
      running_slots: 1,
      startable: 2,
    });
    const d = new Date();
    expect(dto.month.period).toEqual({
      start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
      end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(),
    });
  });

  it("モデル別の費用: 見えないタスクだけが使うモデルの名前は出さず 'other' にまとめる。見えるタスクと共通のモデルは全員分の合計", async () => {
    const visibleRepo = newRepoId();
    const hiddenRepo = newRepoId();
    const v = newViewer([visibleRepo]);
    await seedTask(
      { repository_id: visibleRepo },
      { index: { model: "shared/model-a", cost_micro: 1_000_000 } },
    );
    await seedTask(
      { repository_id: hiddenRepo },
      { index: { model: "shared/model-a", cost_micro: 3_000_000 } },
    );
    const secret = "secret-vendor/hidden-only-model";
    await seedTask(
      { repository_id: hiddenRepo },
      { index: { model: secret, cost_micro: 4_000_000 } },
    );
    const r = await api(v, overviewPath());
    expect(r.text).not.toContain(secret);
    const dto = OverviewDtoSchema.parse(r.json());
    const a = dto.models.find((m) => m.model === "shared/model-a");
    expect(a?.task_cost_usd).toBeGreaterThanOrEqual(4); // 全員分（1 + 3 以上）
    expect(dto.models.find((m) => m.model === "other")?.task_cost_usd).toBeGreaterThanOrEqual(4);
  });
});

describe("overview の consult（D9。M3b の索引）", () => {
  const dir = () => workerEnv.DIRECTORY_DO.getByName(DIRECTORY_NAME);
  async function seedConsult(over: Record<string, unknown> = {}) {
    const consult_id = `consult-${ulid()}`;
    const snap = {
      consult_id,
      owner_id: 1,
      owner_login: "carol",
      at: Date.now(),
      model: "consult-vendor/model-x",
      cost_micro: 2_000_000,
      estimated: false,
      ...over,
    };
    const r = await dir().upsertConsult(snap, 1);
    if (!r.ok) throw new Error(`upsertConsult failed: ${r.code}`);
    return snap;
  }

  it("consult の点が人のレーン用に出る（誰が・いつ・モデル・費用だけ）。見えるリポジトリの集合では絞らない", async () => {
    const v = newViewer([]); // 見えるリポジトリが無くても、consult は全員分が見える（対象のリポジトリが無い）
    const c = await seedConsult({ owner_login: "carol-zq", estimated: true });
    const dto = OverviewDtoSchema.parse((await api(v, overviewPath())).json());
    const point = dto.consults.find((x) => x.consult_id === c.consult_id);
    expect(point).toEqual({
      consult_id: c.consult_id,
      owner_login: "carol-zq",
      at: new Date(c.at).toISOString(),
      model: "consult-vendor/model-x",
      cost_usd: 2,
      estimated: true,
    });
  });

  it("scope=me は自分の consult だけ。範囲外の時刻は出ない", async () => {
    const v = newViewer([newRepoId()]);
    const mine = await seedConsult({ owner_id: v.uid, owner_login: "me-zq" });
    const other = await seedConsult({ owner_id: v.uid + 1000 });
    const old = await seedConsult({ owner_id: v.uid, at: Date.now() - 5 * HOUR });
    const ids = async (q: string) =>
      OverviewDtoSchema.parse((await api(v, overviewPath(q))).json()).consults.map(
        (x) => x.consult_id,
      );
    const all = await ids("");
    expect(all).toEqual(expect.arrayContaining([mine.consult_id, other.consult_id]));
    expect(all).not.toContain(old.consult_id);
    const me = await ids("&scope=me");
    expect(me).toContain(mine.consult_id);
    expect(me).not.toContain(other.consult_id);
  });

  it("モデル別の費用に consult 分が足される。consult のモデルは名前で出る。budget_actual は consult の所有者の台帳（consult の確定分）から足される", async () => {
    const v = newViewer([newRepoId()]);
    const before = OverviewDtoSchema.parse((await api(v, overviewPath())).json());
    const model = `consult-only/m-${v.uid}`;
    await seedConsult({ model, cost_micro: 3_000_000 });
    await seedConsult({ model, cost_micro: 1_000_000, estimated: true });
    // seedConsult の所有者（owner_id: 1）の台帳に、consult の確定分（実費 3 + 見積もり 1）が載る
    v.ledgers[1] = { spent_usd: 4, estimated_usd: 1 };
    resetLedgerCache(); // 台帳の値は 60 秒キャッシュされるので、変えたあとは捨てる
    const after = OverviewDtoSchema.parse((await api(v, overviewPath())).json());
    const m = after.models.find((x) => x.model === model);
    expect(m).toEqual({ model, task_cost_usd: 0, consult_cost_usd: 4 });
    expect(after.month.budget_actual.spent_usd - before.month.budget_actual.spent_usd).toBeCloseTo(
      4,
    );
    expect(
      after.month.budget_actual.estimated_usd - before.month.budget_actual.estimated_usd,
    ).toBeCloseTo(1);
    // タスクの費用の合計は consult で変わらない
    expect(after.month.task_cost_usd).toBeCloseTo(before.month.task_cost_usd);
  });

  it("budget_actual（全員の実績）は各利用者の台帳の今月の spent の合計。タスクの索引の費用には依らない（あなたの使った額と同じ定義）", async () => {
    const v = newViewer([newRepoId()]);
    const other = v.uid + 5000;
    const other2 = v.uid + 5001;
    v.ledgers[other] = { spent_usd: 7, estimated_usd: 2 };
    v.ledgers[other2] = { spent_usd: 3, estimated_usd: 0 };
    // 索引の費用は台帳と食い違う値にしておく（索引を足していないことの確認）
    await seedTask({}, { index: { owner_id: other, cost_micro: 1_000_000 } });
    await seedConsult({ owner_id: other2, cost_micro: 500_000 });
    const dto = OverviewDtoSchema.parse((await api(v, overviewPath())).json());
    // 閲覧者の台帳 12.5 + 7 + 3。estimated は 0.5 + 2 + 0
    expect(dto.month.budget_actual.spent_usd).toBeCloseTo(22.5);
    expect(dto.month.budget_actual.estimated_usd).toBeCloseTo(2.5);
    // 利用者が 1 人なら、全員の実績 = あなたの使った額
    const solo = newViewer([newRepoId()]);
    const soloDto = OverviewDtoSchema.parse((await api(solo, overviewPath())).json());
    expect(soloDto.month.budget_actual.spent_usd).toBeGreaterThanOrEqual(
      solo.budget.spent_usd as number,
    );
  });

  describe("全員の台帳の合計のキャッシュ（他の利用者の分だけ。閲覧者本人は毎回）", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      resetLedgerCache();
    });
    const monthEnd = () => {
      const d = new Date();
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    };
    const spentOf = async (v: Viewer) =>
      OverviewDtoSchema.parse((await api(v, overviewPath())).json()).month.budget_actual.spent_usd;

    it("ポーリングのたびに他の利用者の UserDO を呼ばない（TTL 内は 1 回）。閲覧者本人の分は毎回の budget を使う", async () => {
      resetLedgerCache();
      const base = monthEnd() - 10 * 24 * HOUR;
      vi.spyOn(Date, "now").mockReturnValue(base);
      const v = newViewer([newRepoId()]);
      const other = v.uid + 7000;
      v.ledgers[other] = { spent_usd: 7, estimated_usd: 2 };
      await seedConsult({ owner_id: other, at: base });
      expect(await spentOf(v)).toBeCloseTo(19.5);
      expect(v.ledgerCalls.filter((u) => u === other)).toHaveLength(1);
      // 5 秒後: キャッシュ。他の利用者の台帳が変わっても見えない。本人の budget の変化は即座に出る
      v.ledgers[other] = { spent_usd: 100, estimated_usd: 0 };
      v.budget.spent_usd = 20;
      vi.spyOn(Date, "now").mockReturnValue(base + 5_000);
      expect(await spentOf(v)).toBeCloseTo(27);
      expect(v.ledgerCalls.filter((u) => u === other)).toHaveLength(1);
      // TTL を過ぎたら取り直す
      vi.spyOn(Date, "now").mockReturnValue(base + LEDGER_CACHE_TTL_MS + 1);
      expect(await spentOf(v)).toBeCloseTo(120);
      expect(v.ledgerCalls.filter((u) => u === other)).toHaveLength(2);
    });

    it("TTL は 60 秒", () => {
      expect(LEDGER_CACHE_TTL_MS).toBe(60_000);
    });

    it("月が変わったらキャッシュを捨てる（TTL 内でも）", async () => {
      resetLedgerCache();
      const end = monthEnd();
      vi.spyOn(Date, "now").mockReturnValue(end - 10_000);
      const v = newViewer([newRepoId()]);
      const other = v.uid + 7100;
      v.ledgers[other] = { spent_usd: 5, estimated_usd: 0 };
      await seedConsult({ owner_id: other, at: end - 10_000 });
      await spentOf(v);
      expect(v.ledgerCalls.filter((u) => u === other)).toHaveLength(1);
      // 20 秒後 = 翌月。TTL（60 秒）内だが取り直す。翌月の索引にはまだ所有者がいないので、呼ばれなくなってもよい
      v.ledgers[other] = { spent_usd: 6, estimated_usd: 0 };
      await seedConsult({ owner_id: other, at: end + 5_000 });
      vi.spyOn(Date, "now").mockReturnValue(end + 10_000);
      await spentOf(v);
      expect(v.ledgerCalls.filter((u) => u === other)).toHaveLength(2);
    });

    it("読み出しに失敗した結果はキャッシュしない（次のポーリングで取り直す）", async () => {
      resetLedgerCache();
      const v = newViewer([newRepoId()]);
      const other = v.uid + 7200;
      v.ledgers[other] = "throw";
      await seedConsult({ owner_id: other });
      await spentOf(v);
      v.ledgers[other] = { spent_usd: 4, estimated_usd: 0 };
      expect(await spentOf(v)).toBeCloseTo(16.5);
    });
  });

  it("台帳を読めない利用者がいても overview は落ちず、索引の費用（タスク + consult）に戻る", async () => {
    const v = newViewer([newRepoId()]);
    const other = v.uid + 6000;
    v.ledgers[other] = "throw";
    await seedConsult({ owner_id: other, cost_micro: 1_000_000 });
    const r = await api(v, overviewPath());
    expect(r.status).toBe(200);
    const dto = OverviewDtoSchema.parse(r.json());
    expect(dto.month.budget_actual.spent_usd).toBeCloseTo(
      dto.month.task_cost_usd + dto.models.reduce((a, m) => a + m.consult_cost_usd, 0),
    );
  });

  it("consult の本文に当たる値は索引に無く、応答にも出ない。consult があっても見えないタスクの値は出ない", async () => {
    const hiddenRepo = newRepoId();
    const v = newViewer([newRepoId()]);
    await seedConsult();
    const t = await seedTask(
      { repository_id: hiddenRepo, title: "CONSULT-LEAK-TITLE-zq" },
      { index: { model: "hidden-vendor/hidden-model-zq" } },
    );
    const r = await api(v, overviewPath());
    expect(r.text).not.toContain("CONSULT-LEAK-TITLE-zq");
    expect(r.text).not.toContain("hidden-model-zq");
    expect(r.text).not.toContain(t.id);
    expect(Object.keys(OverviewDtoSchema.parse(r.json()).consults[0] ?? {}).sort()).toEqual([
      "at",
      "consult_id",
      "cost_usd",
      "estimated",
      "model",
      "owner_login",
    ]);
  });
});

describe("tasks/:id", () => {
  it("見えるタスクは TaskDetailDto。入力（instructions など）は返らない。?fresh=1 のとき（開いた最初の 1 回）だけ GitHub で取り直す", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const t = await seedTask({
      repository_id: repo,
      title: "DETAIL-TITLE",
      instructions: "SECRET-INSTRUCTIONS-BODY",
      review_policy: "client_review",
    });
    const r = await api(v, `/tasks/${t.id}?fresh=1`);
    expect(r.status).toBe(200);
    const dto = TaskDetailDtoSchema.parse(r.json());
    expect(dto.task).toMatchObject({ task_id: t.id, title: "DETAIL-TITLE", status: "CREATING" });
    expect(dto.phase).toBe("prepare");
    expect(dto.settings.review_policy).toBe("client_review");
    expect(dto.output).toEqual({ tail: null, redacted: true });
    expect(r.text).not.toContain("SECRET-INSTRUCTIONS-BODY");
    expect(r.text).not.toMatch(/instructions|git_token|ghs_|ghu_|"enc"/);
    expect(v.visibleCalls).toEqual([{ fresh: true }]);
  });

  it("fresh の指定が無い（ポーリング）、または 1 以外の値のときは、キャッシュを使う（fresh でない）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const t = await seedTask({ repository_id: repo });
    for (const q of ["", "?fresh=0", "?fresh=true", "?fresh="]) {
      expect((await api(v, `/tasks/${t.id}${q}`)).status, q).toBe(200);
    }
    expect(v.visibleCalls).toEqual([
      { fresh: false },
      { fresh: false },
      { fresh: false },
      { fresh: false },
    ]);
  });

  it("fresh=1 でも権限の照合は変わらない（見えないタスクは 404、fresh の集合で判定）", async () => {
    const v = newViewer([newRepoId()]);
    const t = await seedTask({ repository_id: newRepoId() });
    const r = await api(v, `/tasks/${t.id}?fresh=1`);
    expect(r.status).toBe(404);
    expect(v.visibleCalls).toEqual([{ fresh: true }]);
  });

  it("設定にモデルの選び方（mode と reason だけ。確率・時間は出さない）が出る。記録の無いタスクには付かない", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const withSel = await seedTask({
      repository_id: repo,
      model: "anthropic/claude-sonnet-5-5",
      model_selection: {
        mode: "auto",
        chosen: "anthropic/claude-sonnet-5-5",
        reason: "clef_cascade",
        scores: { "anthropic/claude-sonnet-5-5": 0.91 },
        latency_ms: 812,
      },
    });
    const r = await api(v, `/tasks/${withSel.id}`);
    const dto = TaskDetailDtoSchema.parse(r.json());
    expect(dto.settings.model_selection).toEqual({ mode: "auto", reason: "clef_cascade" });
    expect(r.text).not.toContain("0.91");
    expect(r.text).not.toContain("812");
    const plain = await seedTask({ repository_id: repo });
    const dto2 = TaskDetailDtoSchema.parse((await api(v, `/tasks/${plain.id}`)).json());
    expect(dto2.settings).not.toHaveProperty("model_selection");
  });

  it("phase: 実行中は run、終端は done（now は無い）", async () => {
    // 偽の GitHub App で Draft PR を作れる実在のリポジトリ（id 4242）で進める
    const v = newViewer([4242]);
    const t = await seedTask({ repository_id: 4242 });
    await t.stub.advance();
    const running = TaskDetailDtoSchema.parse((await api(v, `/tasks/${t.id}`)).json());
    expect(running.task.status).toBe("RUNNING");
    expect(running.phase).toBe("run");
    await t.stub.cancel(4_001);
    const done = TaskDetailDtoSchema.parse((await api(v, `/tasks/${t.id}`)).json());
    expect(done.phase).toBe("done");
    expect(done.task.status).toBe("CANCELLED");
    expect(done.now).toBeNull();
  });

  it("stopped_phase: 終端で止まった段階を返す（開始前のキャンセル=prepare、実行中=run、検証に入った後=verify）。非終端と完了は null", async () => {
    const v = newViewer([4242]);
    const detail = async (id: string) =>
      TaskDetailDtoSchema.parse((await api(v, `/tasks/${id}`)).json());
    // 開始前にキャンセル
    const early = await seedTask({ repository_id: 4242 });
    expect((await detail(early.id)).stopped_phase).toBeNull();
    await early.stub.cancel(4_001);
    expect((await detail(early.id)).stopped_phase).toBe("prepare");
    // 実行中にキャンセル
    const running = await seedTask({ repository_id: 4242 });
    await running.stub.advance();
    expect((await detail(running.id)).stopped_phase).toBeNull();
    await running.stub.cancel(4_001);
    expect((await detail(running.id)).stopped_phase).toBe("run");
    // 検証に入った記録があるタスクの中断
    const verifying = await seedTask({ repository_id: 4242 });
    await verifying.stub.advance();
    await runInDurableObject(verifying.stub, (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO events (seq, type, payload, created_at) VALUES ((SELECT COALESCE(MAX(seq),0)+1 FROM events), 'status_changed', ?, ?)",
        JSON.stringify({ status: "VERIFYING", from: "RUNNING" }),
        Date.now(),
      );
    });
    await verifying.stub.cancel(4_001);
    expect((await detail(verifying.id)).stopped_phase).toBe("verify");
  });

  it("now / output: 構造化イベントから作る。保存済みの秘密が平文でも応答に出ない。終端は now が null で出力は残る", async () => {
    const GHP = `ghp_${"a1B2".repeat(9)}`;
    const v = newViewer([4242]);
    const t = await seedTask({ repository_id: 4242 });
    await t.stub.advance();
    // 古い agent: 構造化イベントが無いので tool_start に縮退
    await t.agent.emit("tool_start", { callId: "c1", name: "bash", summary: "ls -la" });
    await t.stub.advance();
    const legacy = TaskDetailDtoSchema.parse((await api(v, `/tasks/${t.id}`)).json());
    expect(legacy.now).toMatchObject({ kind: "tool", text: "$ ls -la" });
    expect(legacy.output).toEqual({ tail: null, redacted: true });
    // 保存済みの行にマスク漏れがあっても、API の最後の層で伏せる
    await runInDurableObject(t.stub, (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO events (seq, type, payload, created_at) VALUES ((SELECT COALESCE(MAX(seq),0)+1 FROM events), 'command', ?, ?)",
        JSON.stringify({
          command: `deploy ${GHP}`,
          exit_code: 0,
          output_tail: `ok\nGITHUB_TOKEN=plain123\n${GHP}`,
        }),
        Date.now(),
      );
    });
    const r = await api(v, `/tasks/${t.id}`);
    const dto = TaskDetailDtoSchema.parse(r.json());
    expect(dto.now?.kind).toBe("command");
    expect(dto.output.tail).toContain("ok");
    expect(dto.output.command).toContain("deploy");
    expect(r.text).not.toContain(GHP);
    expect(r.text).not.toContain("plain123");
    await t.stub.cancel(4_001);
    const done = TaskDetailDtoSchema.parse((await api(v, `/tasks/${t.id}`)).json());
    expect(done.now).toBeNull();
    expect(done.output.tail).toContain("ok");
  });

  it("output: 実行中のコマンドの進捗は running: true つきで出て、command が終わるか cancel で消える。events の一覧には出ない", async () => {
    const GHP = `ghp_${"a1B2".repeat(9)}`;
    const v = newViewer([4242]);
    const t = await seedTask({ repository_id: 4242 });
    await t.stub.advance();
    await t.agent.emit("command_progress", {
      command: "pnpm test",
      startedAt: Date.UTC(2026, 9, 22, 1, 0, 0),
      outputTail: `running\n${GHP}\n`,
    });
    await t.stub.advance();
    const r = await api(v, `/tasks/${t.id}`);
    const dto = TaskDetailDtoSchema.parse(r.json());
    expect(dto.output).toMatchObject({
      running: true,
      started_at: "2026-10-22T01:00:00.000Z",
      command: "pnpm test",
      redacted: true,
    });
    expect(dto.output.tail).toContain("running");
    expect(r.text).not.toContain(GHP);
    // 履歴（events API）には出ない
    const events = await api(v, `/tasks/${t.id}/events`);
    expect(events.text).not.toContain("command_progress");
    expect(events.text).not.toContain("running\\n");
    // command が来たら実行中の印は消え、終わった command の出力になる
    await t.agent.emit("command", { command: "pnpm test", exitCode: 0, outputTail: "all passed" });
    await t.stub.advance();
    const done = TaskDetailDtoSchema.parse((await api(v, `/tasks/${t.id}`)).json());
    expect(done.output).not.toHaveProperty("running");
    expect(done.output.tail).toContain("all passed");
    // 取り消したタスクは実行中に見えない
    await t.agent.emit("command_progress", { command: "sleep 99", startedAt: Date.now() });
    await t.stub.advance();
    expect(TaskDetailDtoSchema.parse((await api(v, `/tasks/${t.id}`)).json()).output.running).toBe(
      true,
    );
    await t.stub.cancel(4_001);
    const cancelled = TaskDetailDtoSchema.parse((await api(v, `/tasks/${t.id}`)).json());
    expect(cancelled.output).not.toHaveProperty("running");
  });

  it("権限なし・存在しない・repository_id が NULL は、どれも同じ 404（本文もヘッダも同じ）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const noPerm = await seedTask({ repository_id: newRepoId() });
    const nullRepo = await seedTask({ repository_id: null });
    const missing = "01JZ0000000000000000000099";
    const results = await Promise.all(
      [noPerm.id, nullRepo.id, missing].flatMap((id) => [
        api(v, `/tasks/${id}`),
        api(v, `/tasks/${id}/events`),
      ]),
    );
    for (const r of results) {
      expect(r.status).toBe(404);
      expect(ErrorDtoSchema.parse(r.json())).toEqual({ error: "not_found" });
    }
    expect(new Set(results.map((r) => r.text)).size).toBe(1);
    expect(new Set(results.map((r) => r.res.headers.get("content-type"))).size).toBe(1);
  });

  it("索引を偽装しても（索引の repository_id が見える側）、TaskDO の今の値で判定されて 404", async () => {
    const mine = newRepoId();
    const v = newViewer([mine]);
    const t = await seedTask(
      { repository_id: newRepoId(), title: "FORGED-INDEX" },
      { index: { repository_id: mine } },
    );
    const detail = await api(v, `/tasks/${t.id}`);
    const events = await api(v, `/tasks/${t.id}/events`);
    expect(detail.status).toBe(404);
    expect(events.status).toBe(404);
    expect(detail.whole).not.toContain("FORGED-INDEX");
  });

  it("開いた後に権限が外れると、次の呼び出しで 404（古い集合を使わない）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const t = await seedTask({ repository_id: repo });
    expect((await api(v, `/tasks/${t.id}`)).status).toBe(200);
    expect((await api(v, `/tasks/${t.id}/events`)).status).toBe(200);
    v.visible = { ok: true, ids: [] };
    expect((await api(v, `/tasks/${t.id}`)).status).toBe(404);
    expect((await api(v, `/tasks/${t.id}/events`)).status).toBe(404);
  });

  it("出力の検証に失敗したら、中身を返さずに 503（不正な値を画面に流さない）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    // owner_login が GitHub のログイン名の形でない（契約の loginSchema に通らない）
    const t = await seedTask({ repository_id: repo, owner_login: "bad login!<script>" });
    const detail = await api(v, `/tasks/${t.id}`);
    expect(detail.status).toBe(503);
    expect(ErrorDtoSchema.parse(detail.json())).toEqual({ error: "unavailable" });
    expect(detail.whole).not.toContain("bad login");
    expect(detail.whole).not.toContain(t.id);
    const overview = await api(v, overviewPath());
    expect(overview.status).toBe(503);
    expect(overview.whole).not.toContain("bad login");
  });
});

describe("events（認可の経路・入力の検査）", () => {
  it("見えるタスクは TaskEventsPageDto（空のページ）。5 秒ごとのポーリングなので GitHub の取り直しはしない（fresh でない）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const t = await seedTask({ repository_id: repo });
    const r = await api(v, `/tasks/${t.id}/events`);
    expect(r.status).toBe(200);
    expect(TaskEventsPageDtoSchema.parse(r.json())).toEqual({
      task_id: t.id,
      events: [],
      oldest_seq: null,
      newest_seq: null,
      has_older: false,
    });
    expect(v.visibleCalls).toEqual([{ fresh: false }]);
  });

  it("cursor / before は正の整数だけ（それ以外は 400）。同時には指定できない", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const t = await seedTask({ repository_id: repo });
    for (const q of ["cursor=0", "cursor=-1", "cursor=x", "before=1.5", "cursor=1&before=2"]) {
      const r = await api(v, `/tasks/${t.id}/events?${q}`);
      expect(r.status, q).toBe(400);
    }
    expect((await api(v, `/tasks/${t.id}/events?cursor=3`)).status).toBe(200);
  });
});

// 構造化イベント（M7・D14）の中身。GitHub の偽（repository_id 4242）で実際に取り込みまで進めたタスクを読む
describe("events（構造化イベントの中身）", () => {
  const FAKE_REPO_ID = 4242;
  const GHP = `ghp_${"a1B2".repeat(9)}`;
  const GHS = `ghs_${"c3D4".repeat(9)}`;
  const PAT = `github_pat_${"E5f6".repeat(8)}`;
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const SECRETS = [GHP, GHS, PAT, "abcdef0123456789xyz", "s3cretPass", "plain123", "plainvalue789"];

  async function running() {
    const t = await seedTask({});
    await t.stub.advance();
    return t;
  }
  const page = (r: { json(): unknown }) => TaskEventsPageDtoSchema.parse(r.json());

  it("agent の出した command / edit / commit / web を契約の形で返す。応答全体に平文の秘密が無い（マスク前の入力でも）", async () => {
    const v = newViewer([FAKE_REPO_ID]);
    const t = await running();
    // agent 側のマスクが壊れていた想定で、秘密を平文のまま送る
    await t.agent.emit("command", {
      command: `echo start && wget --header "Authorization: Bearer ${"abcdef0123456789xyz"}" https://user:s3cretPass@h.example/x ${GHP} && GITHUB_TOKEN=plain123 run`,
      cwd: "apps/gateway",
      exitCode: 1,
      durationMs: 321,
      outputTail: `line1\n${GHS}\nAPI_KEY=plainvalue789\n${PAT}`,
    });
    await t.agent.emit("edit", {
      path: "src/a.ts",
      op: "modify",
      added: 4,
      removed: 2,
      diff: "+x",
    });
    await t.agent.emit("commit", { message: `feat: x ${GHP}\n\nbody`, sha: SHA, files: 2 });
    await t.agent.emit("web", { kind: "fetch", host: "docs.example.com", url: "https://a/b?c=d" });
    await t.stub.advance();

    const r = await api(v, `/tasks/${t.id}/events`);
    expect(r.status).toBe(200);
    const p = page(r);
    const types = p.events.map((e) => e.type);
    for (const type of ["command", "edit", "commit", "web", "status_changed"]) {
      expect(types, type).toContain(type);
    }
    const cmd = p.events.find((e) => e.type === "command");
    expect(cmd).toMatchObject({ cwd: "apps/gateway", exit_code: 1, duration_ms: 321 });
    expect(p.events.find((e) => e.type === "edit")).toMatchObject({
      path: "src/a.ts",
      op: "modify",
      added: 4,
      removed: 2,
    });
    expect(p.events.find((e) => e.type === "commit")).toMatchObject({
      message: "feat: x [REDACTED]",
      sha: SHA,
      files: 2,
    });
    expect(p.events.find((e) => e.type === "web")).toMatchObject({
      kind: "fetch",
      host: "docs.example.com",
    });
    // 応答全体（ヘッダ・本文）に平文の秘密が無い。余計な項目（diff・url）も無い
    for (const s of SECRETS) expect(r.whole, s).not.toContain(s);
    expect(r.whole).toContain("[REDACTED]");
    expect(r.whole).not.toContain("a/b?c=d");
    expect(r.whole).not.toContain('"diff"');
    expect(p.newest_seq).toBe(Math.max(...p.events.map((e) => e.seq)));
    expect(p.oldest_seq).toBe(Math.min(...p.events.map((e) => e.seq)));
  });

  it("保存された行に（過去のバグで）平文の秘密が残っていても、応答では伏せる（API の層）", async () => {
    const v = newViewer([FAKE_REPO_ID]);
    const t = await running();
    await runInDurableObject(t.stub, (_i, state) => {
      const seq =
        (state.storage.sql.exec("SELECT MAX(seq) AS m FROM events").one() as { m: number }).m + 1;
      state.storage.sql.exec(
        "INSERT INTO events (seq, type, payload, created_at) VALUES (?, 'command', ?, ?)",
        seq,
        JSON.stringify({
          command: `GITHUB_TOKEN=plain123 ${GHP}`,
          output_tail: `${GHS} https://user:s3cretPass@h.example ${PAT}`,
          exit_code: 0,
        }),
        Date.now(),
      );
    });
    const r = await api(v, `/tasks/${t.id}/events`);
    expect(r.status).toBe(200);
    expect(page(r).events.some((e) => e.type === "command")).toBe(true);
    for (const s of SECRETS) expect(r.whole, s).not.toContain(s);
  });

  it("末尾（新しい側）から 200 件。before で古い側へ、cursor で新しい側の差分だけ", async () => {
    const v = newViewer([FAKE_REPO_ID]);
    const t = await running();
    const total = 230;
    for (let i = 1; i <= total; i++)
      await t.agent.emit("command", { command: `cmd-${i}`, exitCode: 0 });
    for (let i = 0; i < 10; i++) await t.stub.advance();

    const first = page(await api(v, `/tasks/${t.id}/events`));
    expect(first.events).toHaveLength(200);
    expect(first.has_older).toBe(true);
    const lastCmd = first.events.at(-1);
    expect(lastCmd).toMatchObject({ type: "command", command: `cmd-${total}` });
    const asc = first.events.map((e) => e.seq);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));

    const older = page(await api(v, `/tasks/${t.id}/events?before=${first.oldest_seq}`));
    expect(older.events.length).toBeGreaterThan(0);
    expect(Math.max(...older.events.map((e) => e.seq))).toBeLessThan(first.oldest_seq ?? 0);
    expect(older.has_older).toBe(false);
    // 全体で 1 件も欠けず重ならない
    const seen = new Set([...older.events, ...first.events].map((e) => e.seq));
    expect(seen.size).toBe(older.events.length + first.events.length);
    expect([...older.events, ...first.events].filter((e) => e.type === "command")).toHaveLength(
      total,
    );

    const none = page(await api(v, `/tasks/${t.id}/events?cursor=${first.newest_seq}`));
    expect(none.events).toEqual([]);
    expect(none.oldest_seq).toBeNull();
    await t.agent.emit("command", { command: "cmd-new", exitCode: 0 });
    await t.stub.advance();
    const diff = page(await api(v, `/tasks/${t.id}/events?cursor=${first.newest_seq}`));
    expect(diff.events.map((e) => (e as { command?: string }).command)).toEqual(["cmd-new"]);
  });

  it("古い agent（構造化イベントが無い）の履歴は、tool_start / tool_end と状態の変化で縮退して返す", async () => {
    const v = newViewer([FAKE_REPO_ID]);
    const t = await running();
    await t.agent.emit("tool_start", {
      callId: "c1",
      name: "bash",
      summary: `{"command":"${GHP}"}`,
    });
    await t.agent.emit("tool_end", { callId: "c1", name: "bash", isError: false, summary: "ok" });
    await t.stub.advance();
    const r = await api(v, `/tasks/${t.id}/events`);
    expect(r.status).toBe(200);
    const types = page(r).events.map((e) => e.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).not.toContain("command");
    expect(r.whole).not.toContain(GHP);
  });

  it("権限のない閲覧者は 404。応答に秘密も task_id も出ない", async () => {
    const other = newViewer([newRepoId()]);
    const t = await running();
    await t.agent.emit("command", { command: `echo ${GHP}`, exitCode: 0 });
    await t.stub.advance();
    for (const q of ["", "?cursor=1", "?before=99"]) {
      const r = await api(other, `/tasks/${t.id}/events${q}`);
      expect(r.status, q).toBe(404);
      expect(ErrorDtoSchema.parse(r.json())).toEqual({ error: "not_found" });
      expect(r.whole).not.toContain(GHP);
      expect(r.whole).not.toContain("echo");
      expect(r.whole).not.toContain(t.id);
    }
  });
});

describe("budget", () => {
  it("視聴者本人の BudgetMeDto だけ（月の上限は含み、期間などほかの項目は返さない）", async () => {
    const v = newViewer([newRepoId()]);
    const r = await api(v, "/budget");
    expect(r.status).toBe(200);
    expect(BudgetMeDtoSchema.parse(r.json()).startable).toBe(2);
    expect(BudgetMeDtoSchema.parse(r.json()).monthly_budget_usd).toBe(100);
    expect(r.text).not.toContain("period");
  });

  it("startable は負にならない", async () => {
    const v = newViewer([newRepoId()]);
    v.budget = { ...v.budget, running_slots: 9 };
    expect(BudgetMeDtoSchema.parse((await api(v, "/budget")).json()).startable).toBe(0);
  });
});

describe("認可の表（overview / tasks/:id / events / budget）", () => {
  type Case = {
    name: string;
    setup: (v: Viewer) => void;
    /** [overview, detail, events, budget] の状態 */
    expected: [number, number, number, number];
  };
  const cases: Case[] = [
    { name: "権限あり", setup: () => {}, expected: [200, 200, 200, 200] },
    {
      name: "権限なし（見える集合に無い）",
      setup: (v) => {
        v.visible = { ok: true, ids: [newRepoId()] };
      },
      expected: [200, 404, 404, 200],
    },
    {
      name: "集合が空",
      setup: (v) => {
        v.visible = { ok: true, ids: [] };
      },
      expected: [200, 404, 404, 200],
    },
    {
      name: "集合の取得失敗（GitHub の障害）",
      setup: (v) => {
        v.visible = { ok: false, code: "unavailable" };
      },
      expected: [503, 503, 503, 200],
    },
    {
      name: "集合が大きすぎる",
      setup: (v) => {
        v.visible = { ok: false, code: "too_large" };
      },
      expected: [503, 503, 503, 200],
    },
    {
      name: "GitHub が 403（denied）",
      setup: (v) => {
        v.visible = { ok: false, code: "denied" };
      },
      expected: [503, 503, 503, 200],
    },
    {
      name: "資格なし・失効（再ログインが必要）",
      setup: (v) => {
        v.visible = { ok: false, code: "unauthenticated" };
      },
      expected: [401, 401, 401, 200],
    },
    {
      name: "許可ルールから外れた（セッションは生きている）",
      setup: (v) => {
        v.session = { ok: false, kind: "unauthenticated" };
      },
      expected: [401, 401, 401, 401],
    },
    {
      name: "許可ルールを確かめられない障害",
      setup: (v) => {
        v.session = { ok: false, kind: "unavailable" };
      },
      expected: [503, 503, 503, 503],
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const repo = newRepoId();
      const v = newViewer([repo]);
      const t = await seedTask({ repository_id: repo, title: "TABLE-CASE-TITLE" });
      c.setup(v);
      const got = [
        await api(v, overviewPath()),
        await api(v, `/tasks/${t.id}`),
        await api(v, `/tasks/${t.id}/events`),
        await api(v, "/budget"),
      ];
      expect(got.map((g) => g.status)).toEqual(c.expected);
      for (const g of got) {
        if (g.status >= 400) {
          // 失敗の本文は ErrorDto だけ。理由・タスク・リポジトリの名前を出さない
          expect(ErrorDtoSchema.parse(g.json())).toBeTruthy();
          expect(g.whole).not.toContain("TABLE-CASE-TITLE");
          expect(g.whole).not.toContain(t.id);
        }
      }
    });
  }

  it("repository_id が NULL のタスク: 詳細・events は 404、overview の tasks にも出ない", async () => {
    const v = newViewer([newRepoId()]);
    const t = await seedTask({ repository_id: null });
    expect((await api(v, `/tasks/${t.id}`)).status).toBe(404);
    expect((await api(v, `/tasks/${t.id}/events`)).status).toBe(404);
    const overview = await api(v, overviewPath());
    expect(overview.text).not.toContain(t.id);
  });
});

describe("waiting（日をまたいだ待ち）", () => {
  const PRW = (n: number, repository = "acme/widgets") => ({
    pr_number: n,
    pr_url: `https://github.com/${repository}/pull/${n}`,
    pr_draft: false,
    pr_merged: false,
    repository,
  });
  const waitingPath = (extra = "") => `/waiting${extra}`;
  const parse = async (v: Viewer, extra = "") => {
    const r = await api(v, waitingPath(extra));
    expect(r.status).toBe(200);
    return { r, dto: WaitingDtoSchema.parse(r.json()) };
  };
  const ids = (dto: { tasks: { task_id: string }[] }) => dto.tasks.map((t) => t.task_id);

  it("入力待ちと、COMPLETED で PR が open かつ Draft でないものだけが出る。それ以外は出ない", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const input = await seedTask({ repository_id: repo }, { index: { status: "INPUT_REQUIRED" } });
    const review = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PRW(31, "acme/w-review") } },
    );
    const draft = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PRW(32, "acme/w-draft"), pr_draft: true } },
    );
    const draftUnknown = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PRW(33, "acme/w-unk"), pr_draft: null } },
    );
    const merged = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PRW(34, "acme/w-merged"), pr_merged: true } },
    );
    const noPr = await seedTask({ repository_id: repo }, { index: { status: "COMPLETED" } });
    const running = await seedTask(
      { repository_id: repo },
      { index: { status: "RUNNING", ...PRW(35, "acme/w-run") } },
    );
    const failed = await seedTask(
      { repository_id: repo },
      { index: { status: "FAILED", ...PRW(36, "acme/w-failed") } },
    );
    const { dto } = await parse(v);
    expect(new Set(ids(dto))).toEqual(new Set([input.id, review.id]));
    for (const x of [draft, draftUnknown, merged, noPr, running, failed]) {
      expect(ids(dto)).not.toContain(x.id);
    }
    expect(dto.scope).toBe("all");
    expect(dto.truncated).toBe(false);
  });

  it("日付に関係なく出る（古いタスクも）。新しい順（created_at の降順）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const day = 24 * HOUR;
    const old = await seedTask(
      { repository_id: repo },
      {
        index: {
          status: "INPUT_REQUIRED",
          created_at: Date.now() - 20 * day,
          updated_at: Date.now() - 20 * day,
        },
      },
    );
    const mid = await seedTask(
      { repository_id: repo },
      {
        index: {
          status: "INPUT_REQUIRED",
          created_at: Date.now() - 3 * day,
          updated_at: Date.now() - 3 * day,
        },
      },
    );
    const fresh = await seedTask(
      { repository_id: repo },
      { index: { status: "INPUT_REQUIRED", created_at: Date.now() - HOUR } },
    );
    const { dto } = await parse(v);
    expect(ids(dto)).toEqual([fresh.id, mid.id, old.id]);
  });

  it("D7: 見えないリポジトリの待ちは hidden_count にだけ数え、個別の値は応答のどこにも出ない。NULL の repository_id も数える", async () => {
    const repo = newRepoId();
    const hiddenRepo = newRepoId();
    const v = newViewer([repo]);
    const before = (await parse(v)).dto.hidden_count;
    await seedTask(
      { repository_id: repo, title: "WAIT-SHOWN" },
      { index: { status: "INPUT_REQUIRED" } },
    );
    const hidden = await seedTask(
      {
        repository_id: hiddenRepo,
        title: "WAIT-HIDDEN-TITLE-zq",
        owner_login: "wait-leak-owner-zq",
      },
      { index: { status: "INPUT_REQUIRED", model: "wait-leak/model-zq" } },
    );
    const hiddenReview = await seedTask(
      { repository_id: hiddenRepo },
      { index: { status: "COMPLETED", ...PRW(41, "wait-leak/repo-zq") } },
    );
    const nullRepo = await seedTask(
      { repository_id: repo },
      { index: { status: "INPUT_REQUIRED", repository_id: null } },
    );
    const { r, dto } = await parse(v);
    expect(dto.hidden_count - before).toBe(3);
    for (const needle of [
      hidden.id,
      hiddenReview.id,
      nullRepo.id,
      "WAIT-HIDDEN-TITLE-zq",
      "wait-leak-owner-zq",
      "wait-leak/model-zq",
      "wait-leak/repo-zq",
    ]) {
      expect(r.whole, needle).not.toContain(needle);
    }
    expect(dto.tasks.map((t) => t.title)).toContain("WAIT-SHOWN");
    // GitHub への照会にも、見えない PR を含めない
    expect(JSON.stringify(v.pullCalls)).not.toContain("wait-leak");
  });

  it("scope=me は所有者が閲覧者のタスクだけ（hidden_count も自分の分だけ）。scope の不正は 400", async () => {
    const repo = newRepoId();
    const hiddenRepo = newRepoId();
    const v = newViewer([repo]);
    const mine = await seedTask(
      { repository_id: repo },
      { index: { status: "INPUT_REQUIRED", owner_id: v.uid } },
    );
    const others = await seedTask(
      { repository_id: repo },
      { index: { status: "INPUT_REQUIRED", owner_id: v.uid + 1 } },
    );
    const beforeMe = (await parse(v, "?scope=me")).dto.hidden_count;
    await seedTask(
      { repository_id: hiddenRepo },
      { index: { status: "INPUT_REQUIRED", owner_id: v.uid + 1 } },
    );
    const { dto } = await parse(v, "?scope=me");
    expect(dto.scope).toBe("me");
    expect(ids(dto)).toEqual([mine.id]);
    expect(dto.hidden_count).toBe(beforeMe);
    expect(ids((await parse(v, "?scope=all")).dto)).toEqual(
      expect.arrayContaining([mine.id, others.id]),
    );
    const bad = await api(v, waitingPath("?scope=everyone"));
    expect(bad.status).toBe(400);
    expect(ErrorDtoSchema.parse(bad.json())).toEqual({ error: "bad_request" });
  });

  it("件数の上限（100）で打ち切り、truncated を立てる", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const base = await seedTask({ repository_id: repo }, { index: { status: "INPUT_REQUIRED" } });
    const dir = workerEnv.DIRECTORY_DO.getByName(DIRECTORY_NAME);
    const view = base.view as TaskIndexSnapshot;
    for (let i = 0; i < 104; i++) {
      const up = await dir.upsertTask(
        { ...view, task_id: ulid(), status: "INPUT_REQUIRED", created_at: Date.now() - i * 1000 },
        1,
      );
      if (!up.ok) throw new Error("upsert failed");
    }
    const { dto } = await parse(v);
    expect(dto.tasks).toHaveLength(100);
    expect(dto.truncated).toBe(true);
  });

  it("GitHub で閉じた・マージされた PR は待ちから外す（人が GitHub 上でマージしても索引は変わらないため）。取れない（unknown）ものは残す", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const open = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PRW(51, "acme/g-open") } },
    );
    const merged = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PRW(52, "acme/g-merged") } },
    );
    const closed = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PRW(53, "acme/g-closed") } },
    );
    const unknown = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PRW(54, "acme/g-unknown") } },
    );
    const input = await seedTask({ repository_id: repo }, { index: { status: "INPUT_REQUIRED" } });
    v.pullStates = {
      "acme/g-open#51": "open",
      "acme/g-merged#52": "merged",
      "acme/g-closed#53": "closed",
    };
    const { dto } = await parse(v);
    expect(new Set(ids(dto))).toEqual(new Set([open.id, unknown.id, input.id]));
    expect(ids(dto)).not.toContain(merged.id);
    expect(ids(dto)).not.toContain(closed.id);
    expect(dto.tasks.find((t) => t.task_id === open.id)?.pr?.state).toBe("open");
    expect(dto.tasks.find((t) => t.task_id === unknown.id)?.pr?.state).toBe("unknown");
  });

  it("GitHub への照会が失敗しても 200（fail-soft）。見える集合が空なら何も見えない。未ログインは 401、POST は 405", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const t = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PRW(61, "acme/f-soft") } },
    );
    v.pullStates = () => {
      throw new Error("boom");
    };
    expect(ids((await parse(v)).dto)).toEqual([t.id]);

    const empty = newViewer([]);
    expect((await parse(empty)).dto.tasks).toEqual([]);
    expect((await api(v, waitingPath(), { noCookie: true })).status).toBe(401);
    expect((await api(v, waitingPath(), { method: "POST" })).status).toBe(405);
    const unavailable = newViewer([repo]);
    unavailable.visible = { ok: false, code: "unavailable" };
    expect((await api(unavailable, waitingPath())).status).toBe(503);
  });
});

describe("漏れ: 権限の無いタスクの値が応答の全体のどこにも出ない", () => {
  it("overview / tasks/:id / events / budget / 404 の status・ヘッダ・本文のどこにも、task_id・owner_login・repository・pr_url・model・title が無い", async () => {
    const hiddenRepo = newRepoId();
    const v = newViewer([newRepoId()]);
    const secret = {
      owner_login: "leak-owner-zq",
      repository: "leak-org/leak-repo-zq",
      title: "LEAK-TITLE-zq 題名",
      model: "leak-vendor/leak-model-zq",
      pr_url: "https://github.com/leak-org/leak-repo-zq/pull/987654",
    };
    const t = await seedTask(
      {
        repository_id: hiddenRepo,
        owner_login: secret.owner_login,
        repository: secret.repository,
        title: secret.title,
      },
      {
        index: {
          model: secret.model,
          pr_url: secret.pr_url,
          pr_number: 987654,
          cost_micro: 1_234_567,
        },
      },
    );
    const responses = [
      await api(v, overviewPath()),
      await api(v, overviewPath("&scope=me")),
      await api(v, `/tasks/${t.id}`),
      await api(v, `/tasks/${t.id}/events`),
      await api(v, `/tasks/${t.id}/events?cursor=1`),
      await api(v, "/budget"),
      await api(v, "/tasks/01JZ0000000000000000000099"),
      await api(v, "/waiting"),
      await api(v, "/waiting?scope=me"),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 404, 404, 404, 200, 404, 200, 200]);
    const needles = [t.id, ...Object.values(secret), "leak-org", "987654", "1.234567"];
    for (const r of responses) {
      for (const needle of needles) {
        expect(r.whole, `${needle} が漏れた: ${r.status}`).not.toContain(needle);
      }
    }
    // 隠れた件数と合計だけは出る
    const overview = OverviewDtoSchema.parse(responses[0]?.json());
    expect(overview.month.hidden_tasks.count).toBeGreaterThanOrEqual(1);
  });
});

describe("PR の状態（GitHub から閲覧者のトークンで取る）", () => {
  const PR = (n: number, repository = "acme/widgets") => ({
    pr_number: n,
    pr_url: `https://github.com/${repository}/pull/${n}`,
    pr_draft: false,
    repository,
  });
  const prOf = (dto: { tasks: { task_id: string; pr: { state: string } | null }[] }, id: string) =>
    dto.tasks.find((t) => t.task_id === id)?.pr?.state;

  it("overview: COMPLETED で rovo が未マージの PR だけを、見えるタスクの分だけ照会する。結果が state に入る", async () => {
    const repo = newRepoId();
    const hiddenRepo = newRepoId();
    const v = newViewer([repo]);
    const open = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PR(11, "acme/pr-open") } },
    );
    const closed = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PR(12, "acme/pr-closed") } },
    );
    const mergedByRovo = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", pr_merged: true, ...PR(13, "acme/pr-rovo") } },
    );
    const running = await seedTask(
      { repository_id: repo },
      { index: { status: "RUNNING", ...PR(14, "acme/pr-running") } },
    );
    const noPr = await seedTask({ repository_id: repo }, { index: { status: "COMPLETED" } });
    const hidden = await seedTask(
      { repository_id: hiddenRepo },
      { index: { status: "COMPLETED", ...PR(15, "acme/pr-hidden-zq") } },
    );
    v.pullStates = { "acme/pr-open#11": "open", "acme/pr-closed#12": "closed" };

    const r = await api(v, overviewPath());
    expect(r.status).toBe(200);
    const dto = OverviewDtoSchema.parse(r.json());
    expect(prOf(dto, open.id)).toBe("open");
    expect(prOf(dto, closed.id)).toBe("closed");
    expect(prOf(dto, mergedByRovo.id)).toBe("merged"); // 記録が先。照会しない
    expect(prOf(dto, running.id)).toBe("unknown"); // COMPLETED 以外は照会しない
    expect(noPr.id && dto.tasks.find((t) => t.task_id === noPr.id)?.pr).toBeNull();
    expect(dto.tasks.map((t) => t.task_id)).not.toContain(hidden.id);

    // 照会したのは、見えるタスクの未マージの COMPLETED の PR だけ。閲覧者の uid で、権限のないタスクの PR は含まない
    expect(v.pullCalls).toHaveLength(1);
    expect(v.pullCalls[0]?.uid).toBe(v.uid);
    const asked = (v.pullCalls[0]?.refs ?? []).map((x) => `${x.repository}#${x.number}`).sort();
    expect(asked).toEqual(["acme/pr-closed#12", "acme/pr-open#11"]);
    expect(JSON.stringify(v.pullCalls)).not.toContain("pr-hidden-zq");
    expect(r.text).not.toContain("pr-hidden-zq");
  });

  it("照会するタスクが無ければ UserDO を呼ばない。見える集合が空でも呼ばない", async () => {
    const v = newViewer([newRepoId()]);
    await api(v, overviewPath());
    expect(v.pullCalls).toEqual([]);
    const none = newViewer([]);
    await seedTask({ repository_id: newRepoId() }, { index: { status: "COMPLETED", ...PR(21) } });
    await api(none, overviewPath());
    expect(none.pullCalls).toEqual([]);
  });

  it("同じ PR は 1 回だけ渡す。1 回の上限（200 件）を超える分は渡さず unknown", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const a = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PR(31, "acme/dup") } },
    );
    const b = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PR(31, "acme/dup") } },
    );
    v.pullStates = { "acme/dup#31": "closed" };
    const dto = OverviewDtoSchema.parse((await api(v, overviewPath())).json());
    expect(prOf(dto, a.id)).toBe("closed");
    expect(prOf(dto, b.id)).toBe("closed");
    expect(v.pullCalls[0]?.refs).toEqual([{ repository: "acme/dup", number: 31 }]);
  });

  it("fail-soft: UserDO が例外でも、不正な応答（件数違い・未知の値）でも、200 で state=unknown。pr_merged があれば merged", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const t = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PR(41, "acme/soft") } },
    );
    const m = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", pr_merged: true, ...PR(42, "acme/soft") } },
    );
    const modes: (() => unknown)[] = [
      () => {
        throw new Error("UserDO down: ghu_secretvalue");
      },
      () => ["open", "open", "open"], // 件数が違う
      () => ["weird"],
      () => "oops",
      () => null,
    ];
    for (const mode of modes) {
      v.pullStates = mode;
      const r = await api(v, overviewPath());
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("ghu_secretvalue");
      const dto = OverviewDtoSchema.parse(r.json());
      expect(prOf(dto, t.id)).toBe("unknown");
      expect(prOf(dto, m.id)).toBe("merged");
    }
  });

  it("UserDO の例外は、名前とマスクしたメッセージ（200 文字まで）をログに残す。トークンは出さない", async () => {
    const token = ["gh", "u", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("");
    const repo = newRepoId();
    const v = newViewer([repo]);
    await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PR(43, "acme/log") } },
    );
    v.pullStates = () => {
      throw new TypeError(
        `The RPC receiver does not implement the method ${token} ${"x".repeat(500)}`,
      );
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await api(v, overviewPath())).status).toBe(200);
      const call = spy.mock.calls.find((c) => c[0] === "dashboard_pr_state_error");
      expect(call?.[1]).toBe("TypeError");
      expect(String(call?.[2])).toContain("The RPC receiver does not implement the method");
      expect(String(call?.[2]).length).toBeLessThanOrEqual(200);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(token);
    } finally {
      spy.mockRestore();
    }
  });

  it("照会が遅くても、画面の応答は待たない（上限の時間で打ち切って unknown）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const t = await seedTask(
      { repository_id: repo },
      { index: { status: "COMPLETED", ...PR(51, "acme/slow") } },
    );
    v.pullStates = () => new Promise(() => {}); // 返ってこない
    const original = readApiTuning.pullStateDeadlineMs;
    readApiTuning.pullStateDeadlineMs = 50;
    const started = Date.now();
    let r: Awaited<ReturnType<typeof api>>;
    try {
      r = await api(v, overviewPath());
    } finally {
      readApiTuning.pullStateDeadlineMs = original;
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.status).toBe(200);
    expect(prOf(OverviewDtoSchema.parse(r.json()), t.id)).toBe("unknown");
  });

  /** 偽 GitHub の PR の URL は github.test。契約の URL（github.com）に直して、画面に出る PR にする */
  async function completedWithPr() {
    const t = await runToCompleted({ repository_id: 4242 });
    await runInDurableObject(t.stub, (_i, state) => {
      state.storage.sql.exec(
        "UPDATE github_link SET pr_url = 'https://github.com/acme/widgets/pull/' || pr_number",
      );
    });
    return t;
  }

  it("tasks/:id: COMPLETED の PR の状態が入る。権限のないタスクの詳細は 404 で、照会しない", async () => {
    const v = newViewer([4242]);
    const t = await completedWithPr();
    const detail0 = TaskDetailDtoSchema.parse((await api(v, `/tasks/${t.id}`)).json());
    expect(detail0.task.pr).not.toBeNull();
    const pr = detail0.task.pr as { number: number; url: string };
    const key = `acme/widgets#${pr.number}`;
    v.pullStates = { [key]: "closed" };
    v.pullCalls.length = 0;
    const detail = TaskDetailDtoSchema.parse((await api(v, `/tasks/${t.id}`)).json());
    expect(detail.task.pr?.state).toBe("closed");
    expect(v.pullCalls).toEqual([
      { uid: v.uid, refs: [{ repository: "acme/widgets", number: pr.number }] },
    ]);

    const outsider = newViewer([newRepoId()]);
    outsider.pullStates = { [key]: "open" };
    const denied = await api(outsider, `/tasks/${t.id}`);
    expect(denied.status).toBe(404);
    expect(outsider.pullCalls).toEqual([]);
    const missing = await api(outsider, "/tasks/01JZ0000000000000000000099");
    expect(missing.status).toBe(404);
    expect(outsider.pullCalls).toEqual([]);
  });

  it("tasks/:id の照会が失敗しても 200（state=unknown）。events・budget は照会しない（5 秒ごとのポーリングで GitHub を叩かない）", async () => {
    const v = newViewer([4242]);
    const t = await completedWithPr();
    v.pullStates = () => {
      throw new Error("down");
    };
    const r = await api(v, `/tasks/${t.id}`);
    expect(r.status).toBe(200);
    expect(TaskDetailDtoSchema.parse(r.json()).task.pr?.state).toBe("unknown");
    v.pullCalls.length = 0;
    expect((await api(v, `/tasks/${t.id}/events`)).status).toBe(200);
    expect((await api(v, "/budget")).status).toBe(200);
    expect(v.pullCalls).toEqual([]);
  });
});

describe("snapshotToVisibleTask（索引・TaskDO の値を契約の形に整える）", () => {
  const base = (): TaskIndexSnapshot => ({
    task_id: "01JZ0000000000000000000000",
    owner_id: 1,
    owner_login: "alice",
    repository: "acme/widgets",
    repository_id: 1,
    title: "t",
    status: "COMPLETED",
    model: "anthropic/claude-sonnet-5-5",
    effort: "medium",
    created_at: Date.UTC(2026, 9, 21, 0, 0, 0),
    updated_at: Date.UTC(2026, 9, 21, 1, 0, 0),
    started_at: Date.UTC(2026, 9, 21, 0, 1, 0),
    ended_at: Date.UTC(2026, 9, 21, 1, 0, 0),
    cost_micro: 1_500_000,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_write_tokens: 40,
    pr_number: 7,
    pr_url: "https://github.com/acme/widgets/pull/7",
    pr_draft: true,
    pr_merged: false,
    reason: null,
    failure_phase: null,
    deps_cache: null,
    sandbox_runtime_ms: null,
  });

  it("時刻は ISO、費用は USD。PR は番号と URL が揃っているときだけ", () => {
    const dto = snapshotToVisibleTask(base());
    expect(dto.created_at).toBe("2026-10-21T00:00:00.000Z");
    expect(dto.cost.cost_usd).toBe(1.5);
    expect(dto.pr).toEqual({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      draft: true,
      merged: false,
      state: "unknown", // GitHub の状態は、読み取り API が権限の判定の後に重ねる
    });
    expect(snapshotToVisibleTask({ ...base(), pr_number: null }).pr).toBeNull();
    // rovo の記録でマージ済みなら、GitHub に聞かなくても merged
    expect(snapshotToVisibleTask({ ...base(), pr_merged: true }).pr).toMatchObject({
      merged: true,
      state: "merged",
    });
  });

  it("契約の形でない任意の文字列は、画面に流さず落とす（reason は理由コードだけ・PR は GitHub の PR の URL だけ）", () => {
    const dto = snapshotToVisibleTask({
      ...base(),
      reason: "Something went wrong: ghs_secret value",
      pr_url: "https://evil.example/acme/widgets/pull/7",
    });
    expect(dto.reason).toBeUndefined();
    expect(dto.pr).toBeNull();
    expect(snapshotToVisibleTask({ ...base(), reason: "base_sha_not_found" }).reason).toBe(
      "base_sha_not_found",
    );
  });

  it("failure_phase は setup のときだけ付く。長い題名は上限で切る", () => {
    expect(snapshotToVisibleTask(base())).not.toHaveProperty("failure_phase");
    expect(snapshotToVisibleTask({ ...base(), failure_phase: "setup" }).failure_phase).toBe(
      "setup",
    );
    expect(snapshotToVisibleTask({ ...base(), title: "あ".repeat(1_000) }).title).toHaveLength(300);
  });

  it("kind（task / review）は索引にあれば付け、無い古い行では付けない", () => {
    expect(snapshotToVisibleTask(base())).not.toHaveProperty("kind");
    expect(snapshotToVisibleTask({ ...base(), kind: "review" }).kind).toBe("review");
    expect(snapshotToVisibleTask({ ...base(), kind: "task" }).kind).toBe("task");
  });
});

describe("TaskDO.dashboardDetail", () => {
  it("repository_id が NULL なら not_found。view・設定を返し、入力は返さない", async () => {
    const nul = await createTask({ repository_id: null }, 4_002);
    expect(await nul.stub.dashboardDetail()).toEqual({ ok: false, code: "not_found" });
    const t = await createTask(
      { repository_id: 4242, instructions: "SECRET-BODY", review_policy: "client_review" },
      4_002,
    );
    const r = await t.stub.dashboardDetail();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.task_id).toBe(t.id);
    expect(r.review_policy).toBe("client_review");
    expect(JSON.stringify(r)).not.toContain("SECRET-BODY");
  });
});

describe("cloudflare（M9）", () => {
  it("未ログインは 401、GET 以外は 405、range が列挙以外なら 400（認証が先）", async () => {
    const v = newViewer([newRepoId()]);
    const unauth = await api(v, "/cloudflare", { noCookie: true });
    expect(unauth.status).toBe(401);
    const badUnauth = await api(v, "/cloudflare?range=2h", { noCookie: true });
    expect(badUnauth.status).toBe(401);
    expect((await api(v, "/cloudflare", { method: "POST" })).status).toBe(405);
    for (const q of [
      "range=2h",
      "range=",
      "range=24H",
      "range=now-1d",
      "range=1h%2C7d",
      "range=30d",
    ]) {
      const r = await api(v, `/cloudflare?${q}`);
      expect(r.status, q).toBe(400);
      expect(ErrorDtoSchema.parse(r.json())).toEqual({ error: "bad_request" });
    }
  });

  it("range の省略は month（今月）。トークン・アカウント ID が未設定なら全項目 not_configured の 200（閲覧者の集合は取らない）", async () => {
    const v = newViewer([newRepoId()]);
    const r = await api(v, "/cloudflare");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    const dto = CloudflareSummaryDtoSchema.parse(r.json());
    expect(dto.range).toBe("month");
    expect(dto.open_url).toBeNull();
    for (const k of [
      "containers",
      "workers",
      "ai_gateway",
      "workers_ai",
      "credit_balance",
    ] as const) {
      expect(dto[k]).toEqual({ ok: false, reason: "not_configured" });
    }
    expect(v.visibleCalls).toHaveLength(0);
    for (const range of ["1h", "24h", "7d", "month"]) {
      const ok = await api(v, `/cloudflare?range=${range}`);
      expect(ok.status, range).toBe(200);
      expect(CloudflareSummaryDtoSchema.parse(ok.json()).range).toBe(range);
    }
  });
});

describe("overview: 人ごとの今月の費用（month.by_owner / month.hidden）", () => {
  const dir = () => workerEnv.DIRECTORY_DO.getByName(DIRECTORY_NAME);
  async function seedConsultFor(login: string, cost_micro: number) {
    const r = await dir().upsertConsult(
      {
        consult_id: `consult-${ulid()}`,
        owner_id: 2,
        owner_login: login,
        at: Date.now(),
        model: "consult-vendor/model-x",
        cost_micro,
        estimated: false,
      },
      1,
    );
    if (!r.ok) throw new Error("upsertConsult failed");
  }
  const parse = async (v: Viewer) => OverviewDtoSchema.parse((await api(v, overviewPath())).json());

  it("見えるリポジトリのタスク + 相談を人ごとに出し、見えない分は人に割り振らず hidden にまとめる。持ち主は応答に出ない", async () => {
    const repo = newRepoId();
    const hiddenRepo = newRepoId();
    const v = newViewer([repo]);
    const tag = `${v.uid}`;
    const ghost = `ghost-${tag}`;
    const pal = `pal-${tag}`;
    await seedTask({ repository_id: repo }, { index: { owner_login: pal, cost_micro: 2_000_000 } });
    await seedTask(
      { repository_id: hiddenRepo },
      { index: { owner_login: ghost, cost_micro: 3_000_000 } },
    );
    await seedConsultFor(pal, 500_000);
    const r = await api(v, overviewPath());
    const dto = OverviewDtoSchema.parse(r.json());
    expect(dto.month.by_owner?.find((o) => o.login === pal)).toEqual({
      login: pal,
      task_cost_usd: 2,
      consult_cost_usd: 0.5,
    });
    expect(dto.month.hidden?.count).toBeGreaterThanOrEqual(1);
    expect(dto.month.hidden?.cost_usd).toBeGreaterThanOrEqual(3);
    expect(r.whole).not.toContain(ghost);
  });

  it("漏れ: 見えないリポジトリだけを持つ利用者の owner_login は応答のどこにも出ない", async () => {
    const v = newViewer([newRepoId()]);
    const ghost = `leak-owner-${v.uid}`;
    await seedTask(
      { repository_id: newRepoId() },
      { index: { owner_login: ghost, cost_micro: 1_000_000 } },
    );
    const r = await api(v, overviewPath());
    expect(r.status).toBe(200);
    expect(r.whole).not.toContain(ghost);
    expect(JSON.stringify(r.json())).not.toContain(ghost);
  });

  it("月の集計は 60 秒キャッシュされる（捨てると最新になる）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const pal = `cache-${v.uid}`;
    await seedTask({ repository_id: repo }, { index: { owner_login: pal, cost_micro: 1_000_000 } });
    const first = await parse(v);
    await seedTask({ repository_id: repo }, { index: { owner_login: pal, cost_micro: 4_000_000 } });
    const second = await parse(v);
    expect(second.month.by_owner).toEqual(first.month.by_owner);
    resetLedgerCache();
    const third = await parse(v);
    expect(third.month.by_owner?.find((o) => o.login === pal)?.task_cost_usd).toBe(5);
  });

  it("漏れ: 月の集計のキャッシュは、見えるリポジトリが違う閲覧者の間で使い回されない", async () => {
    const repo = newRepoId();
    const seer = newViewer([repo]);
    const blind = newViewer([newRepoId()]);
    const ghost = `cache-leak-${seer.uid}`;
    await seedTask(
      { repository_id: repo },
      { index: { owner_login: ghost, cost_micro: 1_000_000 } },
    );
    const first = await api(seer, overviewPath());
    expect(first.whole).toContain(ghost);
    const second = await api(blind, overviewPath());
    expect(second.status).toBe(200);
    expect(second.whole).not.toContain(ghost);
  });
});

describe("overview: 成果の推移（flow）", () => {
  const parse = async (v: Viewer) => OverviewDtoSchema.parse((await api(v, overviewPath())).json());
  const endedAt = Date.now() - 1000;
  const flowIdx = (over: Partial<TaskIndexSnapshot>): Partial<TaskIndexSnapshot> => ({
    status: "COMPLETED",
    started_at: endedAt - 60_000,
    ended_at: endedAt,
    ...over,
  });

  it("見える分の日ごとの数・中央値・マージ数を出し、見えない分は hidden だけ。持ち主は応答に出ない", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const ghost = `flow-ghost-${v.uid}`;
    await seedTask({ repository_id: repo }, { index: flowIdx({ pr_merged: true }) });
    await seedTask({ repository_id: repo }, { index: flowIdx({ status: "FAILED" }) });
    await seedTask(
      { repository_id: newRepoId() },
      { index: flowIdx({ status: "FAILED", owner_login: ghost }) },
    );
    const r = await api(v, overviewPath());
    const dto = OverviewDtoSchema.parse(r.json());
    const flow = dto.flow;
    expect(flow).toBeDefined();
    const today = new Date(endedAt).toISOString().slice(0, 10);
    expect(flow?.days.find((x) => x.date === today)).toMatchObject({ completed: 1, failed: 1 });
    expect(flow?.median_duration_ms).toBe(60_000);
    expect(flow?.pr_merged).toBe(1);
    expect(flow?.hidden.count).toBeGreaterThanOrEqual(1);
    expect(flow?.hidden.failed).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.json())).not.toContain(ghost);
  });

  it("漏れ: 見えないリポジトリだけを持つ利用者の login は flow にも出ない", async () => {
    const v = newViewer([newRepoId()]);
    const ghost = `flow-leak-${v.uid}`;
    await seedTask({ repository_id: newRepoId() }, { index: flowIdx({ owner_login: ghost }) });
    const r = await api(v, overviewPath());
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json())).not.toContain(ghost);
    expect(r.whole).not.toContain(ghost);
  });

  it("60 秒キャッシュされ、見えるリポジトリが違う閲覧者の間で使い回されない", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    await seedTask({ repository_id: repo }, { index: flowIdx({}) });
    const first = await parse(v);
    await seedTask({ repository_id: repo }, { index: flowIdx({}) });
    const second = await parse(v);
    expect(second.flow).toEqual(first.flow);
    const blind = await parse(newViewer([newRepoId()]));
    expect(blind.flow?.days.every((x) => x.completed === 0)).toBe(true);
    resetLedgerCache();
    const third = await parse(v);
    expect(third.flow?.days.reduce((a, x) => a + x.completed, 0)).toBe(2);
  });

  it("DO が失敗したら flow を省き、console.warn で理由を出す（画面は落とさない）", async () => {
    const v = newViewer([newRepoId()]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = envFor(v);
    const real = e.DIRECTORY_DO;
    (e as { DIRECTORY_DO: unknown }).DIRECTORY_DO = {
      getByName: (n: string) =>
        new Proxy(real.getByName(n), {
          get(t, p) {
            if (p === "summarizeFlow") return async () => ({ ok: false, code: "invalid_input" });
            if (p === "then") return undefined;
            return (...args: unknown[]) =>
              (t as unknown as Record<string, (...a: unknown[]) => unknown>)[p as string]?.(
                ...args,
              );
          },
        }),
    };
    const res = await handleDashboard(
      new Request(`${BASE}/dashboard/api${overviewPath()}`, {
        headers: { ...SAME, cookie: await cookieFor(v) },
      }),
      e,
    );
    expect(res.status).toBe(200);
    expect(OverviewDtoSchema.parse(await res.json()).flow).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
