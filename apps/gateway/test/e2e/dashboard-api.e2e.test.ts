import {
  ErrorDtoSchema,
  OverviewDtoSchema,
  TaskDetailDtoSchema,
  TaskEventsPageDtoSchema,
} from "@rovo/dashboard-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { dashboardGet, dashboardLogin } from "./dashboard-session";
import {
  addMember,
  admin,
  baseUrl,
  bodyOf,
  completedResult,
  directoryRow,
  emitAgentEvent,
  finishAgent,
  INSTALLATION_ID,
  login,
  newUser,
  startArgs,
  waitForResult,
} from "./helpers";

// ダッシュボードの読み取り API（M5b）を、実 Worker（wrangler dev）+ 偽 GitHub で通しに確かめる。
// 3 人: A は acme/widgets（全員に見える）と acme/secret（A にだけ見える）の両方、B と C は acme/widgets だけ。
// A が secret で、B が widgets でタスクを作る。B からは A の secret のタスクが一覧にも詳細にも、応答のどこにも出ない。

beforeEach(async () => {
  await admin.reset();
});

const HOUR = 3_600_000;
const SECRET_REPO = { id: 4343, fullName: "acme/secret", push: true };
const WIDGETS = { id: 4242, fullName: "acme/widgets", push: true };

const overviewPath = (scope = "") => {
  const now = Date.now();
  return `/overview?from=${now - HOUR}&to=${now + HOUR}${scope}`;
};

async function waitForIndex(taskId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await directoryRow(taskId)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`索引に行が現れませんでした: ${taskId}`);
}

async function startTask(user: { id: number; login: string }, repository: string, title: string) {
  const client = await login(user);
  try {
    const { task_id: taskId } = bodyOf(
      await client.callTool({
        name: "task_start",
        arguments: startArgs(title, { repository }),
      }),
    ) as { task_id: string };
    return taskId;
  } finally {
    await client.close();
  }
}

async function setup() {
  const [a, b, c] = [newUser("dash-a"), newUser("dash-b"), newUser("dash-c")];
  for (const u of [a, b, c]) await addMember(u);
  const install = (secretVisibleTo: string[]) =>
    admin.setInstallation(INSTALLATION_ID, [
      WIDGETS,
      { ...SECRET_REPO, visibleTo: secretVisibleTo },
    ]);
  await install([a.login]);
  const secretTitle = `SECRET-REPO-TITLE-${a.id}`;
  const bTitle = `B-PUBLIC-TITLE-${b.id}`;
  const cTitle = `C-PUBLIC-TITLE-${c.id}`;
  const secretTask = await startTask(a, "acme/secret", secretTitle);
  const bTask = await startTask(b, "acme/widgets", bTitle);
  const cTask = await startTask(c, "acme/widgets", cTitle);
  await Promise.all([secretTask, bTask, cTask].map(waitForIndex));
  return {
    users: { a, b, c },
    tasks: { secretTask, bTask, cTask },
    titles: { secretTitle, bTitle, cTitle },
    install,
    cookies: {
      a: await dashboardLogin(a),
      b: await dashboardLogin(b),
      c: await dashboardLogin(c),
    },
  };
}

describe("ダッシュボードの読み取り API（2 ユーザーの見え方）", () => {
  it("B（widgets だけ）には A の secret のタスクが、一覧・詳細・events・件数のどこにも個別には出ない。A には全部見える", async () => {
    const s = await setup();
    const { secretTask, bTask, cTask } = s.tasks;

    // --- B: 見えるのは widgets のタスクだけ ---
    const bOverview = await dashboardGet(s.cookies.b, overviewPath());
    expect(bOverview.status).toBe(200);
    const bDto = OverviewDtoSchema.parse(bOverview.json());
    const bIds = bDto.tasks.map((t) => t.task_id);
    expect(bIds).toContain(bTask);
    expect(bIds).toContain(cTask);
    expect(bIds).not.toContain(secretTask);
    expect(bDto.month.hidden_tasks.count).toBeGreaterThanOrEqual(1);
    expect(bDto.viewer).toEqual({ login: s.users.b.login });

    // 応答の全体に、権限の無いタスクの task_id・題名・リポジトリが無い
    const secretNeedles = [secretTask, s.titles.secretTitle, "acme/secret"];
    const bResponses = [
      bOverview,
      await dashboardGet(s.cookies.b, overviewPath("&scope=me")),
      await dashboardGet(s.cookies.b, `/tasks/${secretTask}`),
      await dashboardGet(s.cookies.b, `/tasks/${secretTask}/events`),
      await dashboardGet(s.cookies.b, "/budget"),
    ];
    for (const r of bResponses) {
      for (const needle of secretNeedles) expect(r.whole, needle).not.toContain(needle);
    }
    expect(bResponses[2]?.status).toBe(404);
    expect(bResponses[3]?.status).toBe(404);
    expect(ErrorDtoSchema.parse(bResponses[2]?.json())).toEqual({ error: "not_found" });
    // 存在しないタスクと、本文もヘッダも見分けがつかない
    const missing = await dashboardGet(s.cookies.b, "/tasks/01JZ0000000000000000000099");
    expect(missing.text).toBe(bResponses[2]?.text);

    // 自分のタスクの詳細は見える
    const own = await dashboardGet(s.cookies.b, `/tasks/${bTask}`);
    expect(own.status).toBe(200);
    expect(TaskDetailDtoSchema.parse(own.json()).task.title).toBe(s.titles.bTitle);
    const ownEvents = await dashboardGet(s.cookies.b, `/tasks/${bTask}/events`);
    expect(TaskEventsPageDtoSchema.parse(ownEvents.json()).task_id).toBe(bTask);

    // scope=me: 自分のタスクだけ（C の widgets のタスクは出ない）
    const bMe = OverviewDtoSchema.parse(
      (await dashboardGet(s.cookies.b, overviewPath("&scope=me"))).json(),
    );
    expect(bMe.tasks.map((t) => t.task_id)).toContain(bTask);
    expect(bMe.tasks.map((t) => t.task_id)).not.toContain(cTask);

    // --- A: secret も widgets も見える ---
    const aDto = OverviewDtoSchema.parse((await dashboardGet(s.cookies.a, overviewPath())).json());
    const aIds = aDto.tasks.map((t) => t.task_id);
    expect(aIds).toEqual(expect.arrayContaining([secretTask, bTask, cTask]));
    const aDetail = await dashboardGet(s.cookies.a, `/tasks/${secretTask}`);
    expect(aDetail.status).toBe(200);
    expect(TaskDetailDtoSchema.parse(aDetail.json()).task).toMatchObject({
      task_id: secretTask,
      repository: "acme/secret",
      title: s.titles.secretTitle,
      owner_login: s.users.a.login,
    });
    // 入力（instructions）は詳細にも出ない
    expect(aDetail.text).not.toContain("do it");
    expect(aDetail.text).not.toMatch(/instructions|git_token|ghs_|ghu_/);
    const aMe = OverviewDtoSchema.parse(
      (await dashboardGet(s.cookies.a, overviewPath("&scope=me"))).json(),
    );
    expect(aMe.tasks.map((t) => t.task_id)).toEqual([secretTask]);
  }, 180_000);

  it("A の権限が GitHub 側で外れると、開いた最初の取得（?fresh=1）は 404（古い集合で通さない）。そのあとの events も一覧も反映される", async () => {
    const s = await setup();
    const { secretTask } = s.tasks;
    expect((await dashboardGet(s.cookies.a, `/tasks/${secretTask}?fresh=1`)).status).toBe(200);
    expect((await dashboardGet(s.cookies.a, `/tasks/${secretTask}/events`)).status).toBe(200);

    await s.install([]); // secret はだれにも見えなくなる
    // ポーリング（fresh なし）はキャッシュ（30 秒）の範囲で反映が遅れうる。開いた最初の取得（fresh=1）は厳密
    const detail = await dashboardGet(s.cookies.a, `/tasks/${secretTask}?fresh=1`);
    expect(detail.status).toBe(404);
    expect(detail.whole).not.toContain(s.titles.secretTitle);
    // 詳細の取り直しで集合のキャッシュも更新されるので、events も、一覧もすぐに反映される
    expect((await dashboardGet(s.cookies.a, `/tasks/${secretTask}/events`)).status).toBe(404);
    const overview = await dashboardGet(s.cookies.a, overviewPath());
    expect(overview.whole).not.toContain(secretTask);
  }, 180_000);

  it("構造化イベント: 偽 agent が秘密入りの command を出す台本 → 応答全体に平文の秘密が無い。末尾から 200 件のページング。権限なしは 404。task_wait には出ない", async () => {
    const s = await setup();
    const { bTask, secretTask } = s.tasks;
    const GHP = `ghp_${"a1B2".repeat(9)}`;
    const GHS = `ghs_${"c3D4".repeat(9)}`;
    const PAT = `github_pat_${"E5f6".repeat(8)}`;
    const SECRETS = [
      GHP,
      GHS,
      PAT,
      "abcdef0123456789xyz",
      "s3cretPass",
      "plain123",
      "plainvalue789",
    ];

    // 台本: 秘密を平文のまま含む command（agent のマスクが壊れていた想定）→ 通常の command を 205 件 → edit / commit / web
    await emitAgentEvent(bTask, "command", {
      command: `echo start && wget --header "Authorization: Bearer ${"abcdef0123456789xyz"}" https://user:s3cretPass@h.example/x ${GHP} && GITHUB_TOKEN=plain123 run`,
      cwd: "apps/gateway",
      exitCode: 1,
      durationMs: 42,
      outputTail: `line\n${GHS}\nAPI_KEY=plainvalue789\n${PAT}`,
    });
    for (let i = 1; i <= 205; i++) {
      await emitAgentEvent(bTask, "command", { command: `cmd-${i}`, exitCode: 0 });
    }
    await emitAgentEvent(bTask, "edit", { path: "src/a.ts", op: "modify", added: 3, removed: 1 });
    await emitAgentEvent(bTask, "commit", {
      message: `feat: x ${GHP}\n\nbody`,
      sha: "0123456789abcdef0123456789abcdef01234567",
      files: 2,
    });
    await emitAgentEvent(bTask, "web", { kind: "fetch", host: "docs.example.com" });
    // A の secret のタスクにも秘密入りの command（B には 404 で、中身が応答に出ない）
    await emitAgentEvent(secretTask, "command", { command: `echo SECRET-CMD ${GHP}`, exitCode: 0 });

    // TaskDO の取り込み（alarm / 次の poll）を待つ。最後の web が見えるまで
    let first: ReturnType<typeof TaskEventsPageDtoSchema.parse> | undefined;
    let raw = "";
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const r = await dashboardGet(s.cookies.b, `/tasks/${bTask}/events`);
      expect(r.status).toBe(200);
      raw = r.whole;
      first = TaskEventsPageDtoSchema.parse(r.json());
      if (first.events.some((e) => e.type === "web")) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!first) throw new Error("events が取れませんでした");
    expect(first.events.some((e) => e.type === "web")).toBe(true);

    // 詳細: いまの手順（最新は web）
    const nowDetail = await dashboardGet(s.cookies.b, `/tasks/${bTask}`);
    expect(nowDetail.status).toBe(200);
    expect(TaskDetailDtoSchema.parse(nowDetail.json()).now).toMatchObject({
      kind: "web",
      text: "web fetch docs.example.com",
    });

    // 末尾（新しい側）から最大 200 件、seq の昇順
    expect(first.events).toHaveLength(200);
    expect(first.has_older).toBe(true);
    const seqs = first.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(first.events.at(-1)).toMatchObject({
      type: "web",
      kind: "fetch",
      host: "docs.example.com",
    });
    expect(first.events.at(-3)).toMatchObject({ type: "edit", path: "src/a.ts" });
    expect(first.events.at(-2)).toMatchObject({ type: "commit", message: "feat: x [REDACTED]" });

    // 古い側へ（before）。秘密入りの最初の command がそこにある。応答全体に平文の秘密が無い
    const older = await dashboardGet(
      s.cookies.b,
      `/tasks/${bTask}/events?before=${first.oldest_seq}`,
    );
    const olderPage = TaskEventsPageDtoSchema.parse(older.json());
    expect(olderPage.events.length).toBeGreaterThan(0);
    expect(olderPage.has_older).toBe(false);
    const secretCmd = olderPage.events.find(
      (e) => e.type === "command" && e.command.startsWith("echo start"),
    );
    expect(secretCmd).toMatchObject({ cwd: "apps/gateway", exit_code: 1, duration_ms: 42 });
    for (const resp of [raw, older.whole]) {
      for (const secret of SECRETS) expect(resp, secret).not.toContain(secret);
    }
    expect(older.whole).toContain("[REDACTED]");

    // cursor: それより新しい側の差分だけ
    const none = TaskEventsPageDtoSchema.parse(
      (await dashboardGet(s.cookies.b, `/tasks/${bTask}/events?cursor=${first.newest_seq}`)).json(),
    );
    expect(none.events).toEqual([]);
    await emitAgentEvent(bTask, "command", { command: "cmd-after", exitCode: 0 });
    let diff = none;
    while (Date.now() < deadline && diff.events.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      diff = TaskEventsPageDtoSchema.parse(
        (
          await dashboardGet(s.cookies.b, `/tasks/${bTask}/events?cursor=${first.newest_seq}`)
        ).json(),
      );
    }
    expect(diff.events.map((e) => (e.type === "command" ? e.command : e.type))).toEqual([
      "cmd-after",
    ]);

    // C（widgets は見える）も B のタスクを読める。権限のない者（secret を見られない B）は A のタスクを 404
    const cView = await dashboardGet(s.cookies.c, `/tasks/${bTask}/events`);
    expect(cView.status).toBe(200);
    const denied = await dashboardGet(s.cookies.b, `/tasks/${secretTask}/events`);
    expect(denied.status).toBe(404);
    expect(denied.whole).not.toContain("SECRET-CMD");
    expect(denied.whole).not.toContain(secretTask);
    for (const secret of SECRETS) expect(denied.whole).not.toContain(secret);
    // A 自身は読める（中身は伏せられている）
    const aView = await dashboardGet(s.cookies.a, `/tasks/${secretTask}/events`);
    expect(aView.status).toBe(200);
    expect(aView.whole).not.toContain(GHP);

    // MCP の task_wait には新しい型が出ない
    const client = await login(s.users.b);
    try {
      const wait = bodyOf(
        await client.callTool({
          name: "task_wait",
          arguments: { task_id: bTask, cursor: "0", timeout_seconds: 0 },
        }),
      );
      const types = (wait.events as { type: string }[]).map((e) => e.type);
      for (const hidden of ["command", "edit", "commit", "web"]) {
        expect(types, hidden).not.toContain(hidden);
      }
      expect(JSON.stringify(wait)).not.toContain("cmd-1");
    } finally {
      await client.close();
    }

    // 出力の末尾: 秘密入りの出力を持つ command を足すと、伏せた形で tail に出る
    await emitAgentEvent(bTask, "command", {
      command: "pnpm test",
      exitCode: 0,
      outputTail: `PASS\n${GHS}\nAPI_KEY=plainvalue789\n${PAT}\n3 passed`,
    });
    let detail: ReturnType<typeof TaskDetailDtoSchema.parse> | undefined;
    let detailRaw = "";
    const detailDeadline = Date.now() + 90_000;
    while (Date.now() < detailDeadline) {
      const r = await dashboardGet(s.cookies.b, `/tasks/${bTask}`);
      expect(r.status).toBe(200);
      detailRaw = r.whole;
      detail = TaskDetailDtoSchema.parse(r.json());
      if (detail.output.tail !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(detail?.output.tail).toContain("PASS");
    expect(detail?.output.tail).toContain("3 passed");
    expect(detail?.output.command).toBe("pnpm test");
    expect(detail?.output.redacted).toBe(true);
    expect(detail?.now).toMatchObject({ kind: "command", text: "pnpm test" });
    for (const secret of SECRETS) expect(detailRaw).not.toContain(secret);
  }, 240_000);

  it("GitHub が落ちている間は fail closed（503）。中身は返さない。未ログイン・ヘッダ無しは拒否", async () => {
    const s = await setup();
    const { bTask } = s.tasks;
    await admin.setFault("api", 500);
    try {
      const detail = await dashboardGet(s.cookies.b, `/tasks/${bTask}`);
      expect(detail.status).toBe(503);
      expect(detail.whole).not.toContain(s.titles.bTitle);
      expect(ErrorDtoSchema.parse(detail.json())).toEqual({ error: "unavailable" });
    } finally {
      await admin.setFault("api", null);
    }
    const noLogin = await fetch(`${baseUrl}/dashboard/api${overviewPath()}`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(noLogin.status).toBe(401);
    const noHeader = await fetch(`${baseUrl}/dashboard/api${overviewPath()}`, {
      headers: { cookie: s.cookies.b },
    });
    expect(noHeader.status).toBe(403);
    expect(noHeader.headers.get("access-control-allow-origin")).toBeNull();
    expect(noHeader.headers.get("x-content-type-options")).toBe("nosniff");
  }, 180_000);
});

// PR の状態（open / merged / closed）を、閲覧時に gateway が閲覧者のユーザートークンで GitHub（偽）から取る。
// COMPLETED + 未マージの PR だけが対象。キャッシュは閲覧者ごと（UserDO）なので、閲覧者を替えて GitHub 側の変化を確かめる。
describe("ダッシュボードの PR の状態（GitHub から取る）", () => {
  it("overview・詳細に state が出る。GitHub 側で閉じると別の閲覧者には closed。GitHub の GraphQL が 500 でも 200 で state=unknown", async () => {
    const [a, b, c, d] = [
      newUser("dash-pr-a"),
      newUser("dash-pr-b"),
      newUser("dash-pr-c"),
      newUser("dash-pr-d"),
    ];
    for (const u of [a, b, c, d]) await addMember(u);
    await admin.setInstallation(INSTALLATION_ID, [WIDGETS]);
    // 契約の PR の URL は github.com だけ。偽 GitHub の PR の URL の host を合わせる
    await admin.app("setPrHost", "github.com");

    // A のタスクを COMPLETED にする（PR は Draft のまま = 未マージの open）
    const client = await login(a);
    let taskId: string;
    let head: string;
    try {
      taskId = (
        bodyOf(
          await client.callTool({ name: "task_start", arguments: startArgs("pr-state-task") }),
        ) as { task_id: string }
      ).task_id;
      const deadline = Date.now() + 30_000;
      for (;;) {
        const st = bodyOf(
          await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
        );
        if (st.status === "RUNNING") break;
        if (Date.now() > deadline)
          throw new Error(`RUNNING になりませんでした: ${JSON.stringify(st)}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      const branch = `agent/task-${taskId}`;
      const sha = await admin.app<string | null>("branch", "acme/widgets", branch);
      if (!sha) throw new Error("作業ブランチがありません");
      // 変更の無いまま終わると空の Draft PR が閉じられるので、子の commit を積んでから終端にする
      head = await admin.app<string>("addCommit", "acme/widgets", sha, "child commit");
      await admin.app("setBranch", "acme/widgets", branch, head);
      await finishAgent(taskId, "completed", completedResult(head));
      await waitForResult(client, taskId);
    } finally {
      await client.close();
    }
    const cookies = {
      a: await dashboardLogin(a),
      b: await dashboardLogin(b),
      c: await dashboardLogin(c),
      d: await dashboardLogin(d),
    };

    // 索引に COMPLETED と PR が入るまで待つ
    const find = async (cookie: string) => {
      const dto = OverviewDtoSchema.parse((await dashboardGet(cookie, overviewPath())).json());
      return dto.tasks.find((t) => t.task_id === taskId);
    };
    const deadline = Date.now() + 60_000;
    for (;;) {
      const t = await find(cookies.a);
      if (t?.status === "COMPLETED" && t.pr) break;
      if (Date.now() > deadline) throw new Error("索引に COMPLETED と PR が入りませんでした");
      await new Promise((r) => setTimeout(r, 500));
    }

    // A: open（GitHub に聞いた結果。rovo の記録は未マージ）
    const first = await find(cookies.a);
    expect(first?.pr).toMatchObject({ merged: false, state: "open" });
    expect(first?.pr?.url).toMatch(/^https:\/\/github\.com\/acme\/widgets\/pull\/\d+$/);
    const detail = TaskDetailDtoSchema.parse(
      (await dashboardGet(cookies.a, `/tasks/${taskId}`)).json(),
    );
    expect(detail.task.pr).toMatchObject({ merged: false, state: "open" });

    // GitHub 側で人が閉じた → 初めて見る閲覧者 B（キャッシュなし）には closed。A は 30 秒のキャッシュで open のまま
    await admin.app("closePull", "acme/widgets", first?.pr?.number);
    expect((await find(cookies.b))?.pr).toMatchObject({ merged: false, state: "closed" });
    expect((await find(cookies.a))?.pr?.state).toBe("open");

    // 同じ閲覧者の同時の閲覧（自動更新・複数のタブ・詳細と一覧）でも、どれも state が出る（UserDO の中で
    // 別のリクエストの I/O を待ち合わせても TypeError にならない）
    const burst = await Promise.all(Array.from({ length: 8 }, () => find(cookies.d)));
    expect(burst.map((t) => t?.pr?.state)).toEqual(Array(8).fill("closed"));

    // GitHub の GraphQL が 500: C（キャッシュなし）にも 200 で、state=unknown。画面の他の部分（tasks・budget）は壊れない
    await admin.app("setFault", { pattern: "^POST /graphql$", status: 500 });
    try {
      const res = await dashboardGet(cookies.c, overviewPath());
      expect(res.status).toBe(200);
      const dto = OverviewDtoSchema.parse(res.json());
      const t = dto.tasks.find((x) => x.task_id === taskId);
      expect(t).toMatchObject({ status: "COMPLETED", pr: { merged: false, state: "unknown" } });
      expect(dto.budget.concurrency_limit).toBeGreaterThan(0);
      const d = await dashboardGet(cookies.c, `/tasks/${taskId}`);
      expect(d.status).toBe(200);
      expect(TaskDetailDtoSchema.parse(d.json()).task.pr?.state).toBe("unknown");
    } finally {
      await admin.app("setFault", { pattern: "^POST /graphql$", status: null });
    }

    // 閲覧者のユーザートークンで GraphQL を呼んでいる（Installation Token ではない）
    const gh = await admin.app<{ method: string; path: string; auth: string }[]>("requests");
    const userGraphql = gh.filter((r) => r.path === "/graphql" && r.auth === "user");
    expect(userGraphql.length).toBeGreaterThanOrEqual(2);
  }, 240_000);
});
