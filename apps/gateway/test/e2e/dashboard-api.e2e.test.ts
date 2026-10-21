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
  directoryRow,
  INSTALLATION_ID,
  login,
  newUser,
  startArgs,
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

  it("A の権限が GitHub 側で外れると、次の詳細・events は 404（古い集合で通さない）。一覧からも消える", async () => {
    const s = await setup();
    const { secretTask } = s.tasks;
    expect((await dashboardGet(s.cookies.a, `/tasks/${secretTask}`)).status).toBe(200);
    expect((await dashboardGet(s.cookies.a, `/tasks/${secretTask}/events`)).status).toBe(200);

    await s.install([]); // secret はだれにも見えなくなる
    const detail = await dashboardGet(s.cookies.a, `/tasks/${secretTask}`);
    expect(detail.status).toBe(404);
    expect(detail.whole).not.toContain(s.titles.secretTitle);
    // 詳細の取り直しで集合のキャッシュも更新されるので、events も、一覧もすぐに反映される
    expect((await dashboardGet(s.cookies.a, `/tasks/${secretTask}/events`)).status).toBe(404);
    const overview = await dashboardGet(s.cookies.a, overviewPath());
    expect(overview.whole).not.toContain(secretTask);
  }, 180_000);

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
