import { TaskDetailDtoSchema } from "@rovo/dashboard-contract";
import { describe, expect, it } from "vitest";
import { buildNow, buildOutput } from "../../src/dashboard/detail-now";
import type { StoredEventRow } from "../../src/dashboard/events";

// 詳細の「いまの手順」と「出力の末尾」を、保存された最新の行から作る純関数。
const GHP = `ghp_${"a1B2".repeat(9)}`;
const T0 = Date.UTC(2026, 9, 22, 1, 0, 0);

let seq = 0;
function row(type: string, payload: Record<string, unknown>): StoredEventRow {
  seq += 1;
  return { seq, type, payload, created_at: T0 + seq * 1000 };
}
const cmd = (command: string, extra: Record<string, unknown> = {}) =>
  row("command", { command, exit_code: 0, ...extra });
const start = (id: string, name = "bash", summary = "ls") =>
  row("tool_start", { call_id: id, name, summary });
const end = (id: string) => row("tool_end", { call_id: id, is_error: false, summary: "ok" });

describe("buildNow", () => {
  it("終端（done）は構造化イベントがあっても null", () => {
    expect(buildNow([cmd("ls")], "COMPLETED", "done")).toBeNull();
    expect(buildNow([start("c1")], "CANCELLED", "done")).toBeNull();
  });

  it("INPUT_REQUIRED は waiting", () => {
    expect(buildNow([cmd("ls")], "INPUT_REQUIRED", "run")).toEqual({
      kind: "waiting",
      text: "waiting for input",
    });
  });

  it("最新の command から作る。複数行は 1 行にし、300 字に切り、時刻を付ける", () => {
    const long = `echo ${"x".repeat(500)}`;
    const now = buildNow([cmd("old"), cmd(`first\nsecond ${long}`)], "RUNNING", "run");
    expect(now?.kind).toBe("command");
    expect(now?.text.startsWith("first second echo")).toBe(true);
    expect(now?.text.length).toBeLessThanOrEqual(300);
    expect(now?.text).not.toMatch(/[\r\n]/);
    expect(now?.at).toMatch(/^2026-10-22T01:00:\d\d\.000Z$/);
  });

  it("command のテキストの秘密は再マスクされる", () => {
    const now = buildNow(
      [cmd(`curl -H "Authorization: Bearer ${"abcdef0123456789xyz"}" ${GHP}`)],
      "RUNNING",
      "run",
    );
    expect(now?.text).not.toContain(GHP);
    expect(now?.text).not.toContain("abcdef0123456789xyz");
  });

  it("edit / commit / web はそれぞれの種類で出す", () => {
    expect(
      buildNow(
        [row("edit", { path: "src/a.ts", op: "modify", added: 1, removed: 0 })],
        "RUNNING",
        "run",
      ),
    ).toMatchObject({ kind: "edit", text: "modify src/a.ts" });
    expect(
      buildNow(
        [
          row("commit", {
            message: "feat: x",
            sha: "0123456789abcdef0123456789abcdef01234567",
            files: 1,
          }),
        ],
        "VERIFYING",
        "verify",
      ),
    ).toMatchObject({ kind: "commit", text: "commit feat: x" });
    expect(
      buildNow([row("web", { kind: "fetch", host: "docs.example.com" })], "RUNNING", "run"),
    ).toMatchObject({ kind: "web", text: "web fetch docs.example.com" });
  });

  it("終わっていない tool_start が最新の構造化イベントより新しければ tool（実行中）", () => {
    const now = buildNow([cmd("ls"), start("c2", "bash", "pnpm test")], "RUNNING", "run");
    expect(now).toMatchObject({ kind: "tool", text: "$ pnpm test" });
  });

  it("tool_end 済みの tool_start は飛ばし、最新の構造化イベントを出す", () => {
    const now = buildNow([cmd("pnpm test"), start("c3"), end("c3")], "RUNNING", "run");
    expect(now).toMatchObject({ kind: "command", text: "pnpm test" });
  });

  it("古い agent（構造化イベントが無い）は最新の tool_start に縮退する。終わっていても出す", () => {
    expect(buildNow([start("c1", "read", "a.ts"), end("c1")], "RUNNING", "run")).toMatchObject({
      kind: "tool",
      text: "read: a.ts",
    });
    expect(buildNow([], "RUNNING", "run")).toBeNull();
  });

  it("ツールごとに人が読める形にする（bash は $ command、ファイル系はパス、検索はパターン）", () => {
    const j = (o: unknown) => JSON.stringify(o);
    const t = (name: string, args: unknown) =>
      buildNow([start("c1", name, j(args))], "RUNNING", "run")?.text;
    expect(t("bash", { command: 'for i in $(seq 1 15); do echo "p $i"; sleep 4; done' })).toBe(
      '$ for i in $(seq 1 15); do echo "p $i"; sleep 4; done',
    );
    expect(t("bash", { command: "echo a\necho b" })).toBe("$ echo a echo b");
    expect(t("read_file", { path: "src/a.ts", start_line: 1 })).toBe("read_file: src/a.ts");
    expect(t("write_file", { path: "src/b.ts", content: "x" })).toBe("write_file: src/b.ts");
    expect(t("edit_file", { path: "src/c.ts", old_string: "a", new_string: "b" })).toBe(
      "edit_file: src/c.ts",
    );
    expect(t("list_files", {})).toBe("list_files");
    expect(t("list_files", { path: "src" })).toBe("list_files: src");
    expect(t("search", { pattern: "foo.*bar", path: "src" })).toBe("search: foo.*bar");
  });

  it("途中で切れた JSON（要約は 200 字で切られる）でも bash のコマンドを取り出す", () => {
    const cut = '{"command":"npm run build && npm test -- --reporter=ver';
    expect(buildNow([start("c1", "bash", cut)], "RUNNING", "run")?.text).toBe(
      "$ npm run build && npm test -- --reporter=ver",
    );
  });

  it("未知のツールの JSON は出さずツール名だけにする。JSON でない要約はそのまま", () => {
    const text = (name: string, summary: string) =>
      buildNow([start("c1", name, summary)], "RUNNING", "run")?.text;
    expect(text("report_completion", '{"summary":"done"}')).toBe("report_completion");
    expect(text("mystery", "[1,2")).toBe("mystery");
    expect(text("mystery", "plain words")).toBe("mystery: plain words");
  });

  it("bash のコマンドも秘密はマスクし、300 字に切る", () => {
    const j = JSON.stringify({ command: `curl -H "x" ${GHP} ${"y".repeat(500)}` });
    const text = buildNow([start("c1", "bash", j)], "RUNNING", "run")?.text ?? "";
    expect(text.startsWith("$ curl")).toBe(true);
    expect(text).not.toContain(GHP);
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it("web ツールの tool_start は要約（URL）を出さない", () => {
    const now = buildNow(
      [start("c1", "web_fetch", "https://x.example/p?token=abc")],
      "RUNNING",
      "run",
    );
    expect(now?.text).not.toContain("token=abc");
  });

  it("契約（TaskDetailDto の now）に合う", () => {
    const now = buildNow([cmd("ls")], "RUNNING", "run");
    expect(TaskDetailDtoSchema.shape.now.safeParse(now).success).toBe(true);
  });
});

describe("buildOutput", () => {
  it("最新の command の output_tail と、その command・時刻を出す。伏せている旨は常に true", () => {
    const out = buildOutput(cmd("pnpm test", { output_tail: "ok\n3 passed" }));
    expect(out).toMatchObject({ tail: "ok\n3 passed", command: "pnpm test", redacted: true });
    expect(out.at).toBeDefined();
  });

  it("出力が無い / command が無いときは tail が null（command・at を付けない）", () => {
    expect(buildOutput(cmd("ls"))).toEqual({ tail: null, redacted: true });
    expect(buildOutput(null)).toEqual({ tail: null, redacted: true });
  });

  it("植えた秘密は再マスクされ、上限 2000 字を超えない", () => {
    const tail = `line\n${GHP}\nGITHUB_TOKEN=plain123\n${"y".repeat(3000)}`;
    const out = buildOutput(cmd(`echo ${GHP}`, { output_tail: tail }));
    const whole = JSON.stringify(out);
    expect(whole).not.toContain(GHP);
    expect(whole).not.toContain("plain123");
    expect(out.tail?.length ?? 0).toBeLessThanOrEqual(2000);
  });
});

describe("buildOutput の切り詰め", () => {
  it("上限を超える出力は、末尾を残して先頭を切る（… が先頭に付く）", () => {
    const body = `${"head-".repeat(2_000)}THE-LAST-LINE`;
    const out = buildOutput(row("command", { command: "ls", exit_code: 0, output_tail: body }));
    expect(out.tail).not.toBeNull();
    expect(out.tail?.endsWith("THE-LAST-LINE")).toBe(true);
    expect(out.tail?.startsWith("…")).toBe(true);
  });
});

describe("buildOutput: 実行中の進捗", () => {
  const progress = (extra: Record<string, unknown> = {}) => ({
    command: "pnpm test",
    started_at: T0,
    output_tail: "step 1\nstep 2\n",
    updated_at: T0 + 5_000,
    ...extra,
  });

  it("進捗があれば running: true と開始時刻つきで、進捗の出力を出す（直前の終わった command より優先）", () => {
    const out = buildOutput(cmd("old", { output_tail: "old out" }), progress());
    expect(out).toEqual({
      tail: "step 1\nstep 2\n",
      command: "pnpm test",
      at: "2026-10-22T01:00:05.000Z",
      running: true,
      started_at: "2026-10-22T01:00:00.000Z",
      redacted: true,
    });
    expect(TaskDetailDtoSchema.shape.output.safeParse(out).success).toBe(true);
  });

  it("出力がまだ無い進捗は tail が null のまま running を出す", () => {
    const out = buildOutput(null, progress({ output_tail: undefined }));
    expect(out).toMatchObject({ tail: null, running: true, command: "pnpm test" });
  });

  it("進捗が無ければ従来どおり（running を付けない）", () => {
    expect(buildOutput(cmd("ls"), null)).toEqual({ tail: null, redacted: true });
    expect(buildOutput(null)).not.toHaveProperty("running");
  });

  it("保存済みの進捗の秘密も、応答の前にもう一度マスクする。2,000 字を超えない", () => {
    const out = buildOutput(
      null,
      progress({
        command: `curl ${GHP}`,
        output_tail: `x\n${GHP}\nGITHUB_TOKEN=plain123value\n${"y".repeat(3000)}`,
      }),
    );
    const whole = JSON.stringify(out);
    expect(whole).not.toContain(GHP);
    expect(whole).not.toContain("plain123value");
    expect(out.tail?.length ?? 0).toBeLessThanOrEqual(2000);
  });
});
