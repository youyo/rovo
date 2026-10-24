import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  bodyOf,
  completedResult,
  finishAgent,
  installApp,
  login,
  newUser,
  startArgs,
  waitForResult,
} from "./helpers";

// task_list（呼んだ人のタスクの一覧）を、実 Worker と偽のワーカーで通しで確かめる。
// 索引は TaskDO の alarm で配送されるので、並ぶまで待つ。

beforeEach(async () => {
  await admin.reset();
});

type Item = Record<string, unknown> & { task_id: string };
type Client = Awaited<ReturnType<typeof login>>;

async function listUntil(
  client: Client,
  args: Record<string, unknown>,
  until: (tasks: Item[]) => boolean,
): Promise<Item[]> {
  const deadline = Date.now() + 60_000;
  let last: Item[] = [];
  while (Date.now() < deadline) {
    last = (
      bodyOf(await client.callTool({ name: "task_list", arguments: args })) as { tasks: Item[] }
    ).tasks;
    if (until(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`task_list が条件を満たしませんでした: ${JSON.stringify(last)}`);
}

describe("task_list（実 DO）", () => {
  it("2 つのタスクが新しい順に並び、終端のあとは recent に残って active から消える", async () => {
    const user = newUser("list");
    await addMember(user);
    await installApp();
    const client = await login(user);
    try {
      // 同時に動かせるタスクは 1 つなので、1 つ目を終わらせてから 2 つ目を始める
      const first = (
        bodyOf(
          await client.callTool({ name: "task_start", arguments: startArgs("LIST-FIRST") }),
        ) as {
          task_id: string;
        }
      ).task_id;
      const head = await admin.app<string | null>("branch", "acme/widgets", `agent/task-${first}`);
      if (!head) throw new Error("作業ブランチがありません");
      await finishAgent(first, "completed", completedResult(head));
      expect((await waitForResult(client, first)).status).toBe("COMPLETED");
      const second = (
        bodyOf(
          await client.callTool({ name: "task_start", arguments: startArgs("LIST-SECOND") }),
        ) as { task_id: string }
      ).task_id;

      const recent = await listUntil(
        client,
        { scope: "recent" },
        (t) => t.length === 2 && t.some((x) => x.task_id === first && x.status === "COMPLETED"),
      );
      expect(recent.map((t) => t.task_id)).toEqual([second, first]);
      expect(recent[0]).toMatchObject({
        kind: "task",
        title: "LIST-SECOND",
        repository: "acme/widgets",
        waiting_for_answer: false,
      });
      // 完了して PR がマージ待ちのタスクは pr の段階
      expect(recent[1]).toMatchObject({ title: "LIST-FIRST", status: "COMPLETED", stage: "pr" });
      expect(recent[1]).toHaveProperty("ended_at");
      expect(JSON.stringify(recent)).not.toMatch(/cost/);

      // 終端のタスクは active に出ない
      const active = await listUntil(client, { scope: "active" }, (t) => t.length === 1);
      expect(active.map((t) => t.task_id)).toEqual([second]);
      expect((await listUntil(client, {}, (t) => t.length === 1)).map((t) => t.task_id)).toEqual([
        second,
      ]);

      bodyOf(await client.callTool({ name: "task_cancel", arguments: { task_id: second } }));
      const none = await listUntil(client, { scope: "active" }, (t) => t.length === 0);
      expect(none).toEqual([]);
      const after = await listUntil(client, { scope: "recent" }, (t) =>
        t.some((x) => x.task_id === second && x.status === "CANCELLED"),
      );
      expect(after.map((t) => t.task_id)).toEqual([second, first]);
      expect(after[0]).toMatchObject({ status: "CANCELLED", stage: "work" });
    } finally {
      await client.close();
    }
  }, 240_000);
});
