import { env as workerEnv } from "cloudflare:workers";
import {
  BudgetMeDtoSchema,
  ErrorDtoSchema,
  OverviewDtoSchema,
  TaskDetailDtoSchema,
  TaskEventsPageDtoSchema,
} from "@rovo/dashboard-contract";
import { describe, expect, it } from "vitest";
import { snapshotToVisibleTask } from "../../src/dashboard/api";
import { handleDashboard } from "../../src/dashboard/serve";
import { SESSION_COOKIE, sealSession } from "../../src/dashboard/session";
import { DIRECTORY_NAME, type TaskIndexSnapshot } from "../../src/directory/types";
import { createTask } from "./pr-helpers";

// ダッシュボードの読み取り API（docs/specs/dashboard.md M5b）。認可の最後の関門なので、
// 「見えないタスクが応答のどこにも出ない」「失敗は fail closed」を、実 TaskDO・実 DirectoryDO で確かめる。
// UserDO だけは偽物（視聴者の見えるリポジトリの集合・予算・許可ルールを、テストが自由に差し込む）。

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
  };
}

function envFor(viewer: Viewer): Env {
  const userDo = {
    getByName(name: string) {
      if (name !== String(viewer.uid)) throw new Error(`想定外の UserDO: ${name}`);
      return {
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
    expect(dto.consults).toEqual([]); // consult の索引（M3b）が入るまでは空
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

describe("tasks/:id", () => {
  it("見えるタスクは TaskDetailDto。入力（instructions など）は返らない。最初に開くときは GitHub で取り直す（fresh）", async () => {
    const repo = newRepoId();
    const v = newViewer([repo]);
    const t = await seedTask({
      repository_id: repo,
      title: "DETAIL-TITLE",
      instructions: "SECRET-INSTRUCTIONS-BODY",
      merge_policy: "agent_merge",
    });
    const r = await api(v, `/tasks/${t.id}`);
    expect(r.status).toBe(200);
    const dto = TaskDetailDtoSchema.parse(r.json());
    expect(dto.task).toMatchObject({ task_id: t.id, title: "DETAIL-TITLE", status: "CREATING" });
    expect(dto.phase).toBe("prepare");
    expect(dto.settings.merge_policy).toBe("agent_merge");
    expect(dto.output).toEqual({ tail: null, redacted: true });
    expect(r.text).not.toContain("SECRET-INSTRUCTIONS-BODY");
    expect(r.text).not.toMatch(/instructions|git_token|ghs_|ghu_|"enc"/);
    expect(v.visibleCalls).toEqual([{ fresh: true }]);
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

describe("events（骨組み。中身は M7）", () => {
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

describe("budget", () => {
  it("視聴者本人の BudgetMeDto だけ（月額上限など他の項目は返さない）", async () => {
    const v = newViewer([newRepoId()]);
    const r = await api(v, "/budget");
    expect(r.status).toBe(200);
    expect(BudgetMeDtoSchema.parse(r.json()).startable).toBe(2);
    expect(r.text).not.toContain("monthly_budget_usd");
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
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 404, 404, 404, 200, 404]);
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
    });
    expect(snapshotToVisibleTask({ ...base(), pr_number: null }).pr).toBeNull();
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
});

describe("TaskDO.dashboardDetail", () => {
  it("repository_id が NULL なら not_found。view・設定を返し、入力は返さない", async () => {
    const nul = await createTask({ repository_id: null }, 4_002);
    expect(await nul.stub.dashboardDetail()).toEqual({ ok: false, code: "not_found" });
    const t = await createTask(
      { repository_id: 4242, instructions: "SECRET-BODY", merge_policy: "agent_merge" },
      4_002,
    );
    const r = await t.stub.dashboardDetail();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.task_id).toBe(t.id);
    expect(r.merge_policy).toBe("agent_merge");
    expect(JSON.stringify(r)).not.toContain("SECRET-BODY");
  });
});
