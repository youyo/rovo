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
/** 制御文字（C0・DEL・C1）と双方向の制御文字があるか（正規表現に制御文字を書かないため、コード単位で見る） */
const hasUnsafeChar = (s: string) =>
  [...s].some((ch) => {
    const c = ch.charCodeAt(0);
    return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e);
  });
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

  it("予算の延長の承認待ちの INPUT_REQUIRED は、入力待ちに一言添える（waiting for budget approval）", () => {
    expect(buildNow([cmd("ls")], "INPUT_REQUIRED", "run", true)).toEqual({
      kind: "waiting",
      text: "waiting for budget approval",
    });
    // INPUT_REQUIRED でなければ効かない
    expect(buildNow([cmd("ls")], "RUNNING", "run", true)?.kind).toBe("command");
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

  describe("bash の tool_start: 切れた JSON からコマンドを取り出す", () => {
    const text = (summary: string, name = "bash") =>
      buildNow([start("c1", name, summary)], "RUNNING", "run")?.text;

    it("完全な JSON は今までどおり。… は付けない", () => {
      expect(text('{"command":"pnpm test --filter agent"}')).toBe("$ pnpm test --filter agent");
    });

    it("途中で切れた JSON（要約は 200 字で切られる）でも bash のコマンドを取り出し、末尾に … を付ける", () => {
      const cut = '{"command":"npm run build && npm test -- --reporter=ver';
      expect(text(cut)).toBe("$ npm run build && npm test -- --reporter=ver…");
    });

    it("agent が切り詰めに付ける ... や … は、… に 1 つにまとめる（… を重ねない）", () => {
      expect(text('{"command":"pnpm exec vitest ru...')).toBe("$ pnpm exec vitest ru…");
      expect(text('{"command":"pnpm exec vitest ru…')).toBe("$ pnpm exec vitest ru…");
    });

    it('閉じる " まで読めていれば、後ろが切れていても値は完全（… を付けない）', () => {
      expect(text('{"command":"ls","timeout":12...')).toBe("$ ls");
    });

    it('JSON の文字列のエスケープ（\\" \\\\ \\n \\t \\uXXXX）を戻す', () => {
      const cut = String.raw`{"command":"echo \"hi\" \\ done\nnext\tTab \u3042 \u00e9 tail`;
      expect(text(cut)).toBe('$ echo "hi" \\ done next Tab あ é tail…');
      const closed = String.raw`{"command":"grep \"a\\b\" f","timeout":1`;
      expect(text(closed)).toBe('$ grep "a\\b" f');
    });

    it("末尾が中途半端なエスケープで切れていても、壊れた文字を出さない", () => {
      const t = (tail: string) => text(`{"command":"echo ok ${tail}`);
      expect(t("\\")).toBe("$ echo ok…");
      expect(t("\\u")).toBe("$ echo ok…");
      expect(t("\\u1")).toBe("$ echo ok…");
      expect(t("\\u12")).toBe("$ echo ok…");
      expect(t("\\u00e")).toBe("$ echo ok…");
      expect(t("\\ud83d")).toBe("$ echo ok…");
      expect(t("\\ud83d\\ude")).toBe("$ echo ok…");
      expect(t("\\...")).toBe("$ echo ok…");
      expect(t("\\u12...")).toBe("$ echo ok…");
      expect(t("\\ud83d\\ude00 x")).toBe("$ echo ok 😀 x…");
      expect(t("\\\\")).toBe("$ echo ok \\…");
    });

    it("取り出せないとき（未知のキーで始まる・値が文字列でない・エスケープが壊れている）は、生の JSON を出さずツール名だけ", () => {
      expect(text('{"foo":"bar","command":"ls')).toBe("bash");
      expect(text('{"cmd":"ls')).toBe("bash");
      expect(text('{"command":{"a":1')).toBe("bash");
      expect(text('{"command":"ls \\q')).toBe("bash");
      expect(text('{"command":"ls \\uZZZZ')).toBe("bash");
      expect(text('{"command":"')).toBe("bash");
      // 既知のキーでも、そのツールのキーでなければ取り出さない
      expect(text('{"command":"ls', "read_file")).toBe("read_file");
    });

    it("read_file など bash 以外も、切れた JSON から既知のキーの値を取り出す", () => {
      expect(text('{"path":"src/very-long/pa', "read_file")).toBe("read_file: src/very-long/pa…");
      expect(text('{"pattern":"foo.*ba', "search")).toBe("search: foo.*ba…");
    });

    it("取り出した値も、制御文字・双方向文字を除いて 1 行にし、秘密はマスクする", () => {
      const cut = String.raw`{"command":"echo a\nrm\u202e -rf\u0007 b\u001b[31m c`;
      const t = text(cut) ?? "";
      // gateway の sanitizeText は ANSI のエスケープ（\u001b[31m）も除く
      expect(t).toBe("$ echo a rm -rf b c…");
      expect(hasUnsafeChar(t)).toBe(false);
      expect(text(`{"command":"curl -H x ${GHP} ${"y".repeat(500)}`)).not.toContain(GHP);
      expect((text(`{"command":"curl ${"y".repeat(500)}`) ?? "").length).toBeLessThanOrEqual(300);
    });
  });

  describe("コマンドの cd /workspace の前置き", () => {
    const tool = (command: string) =>
      buildNow([start("c1", "bash", JSON.stringify({ command }))], "RUNNING", "run")?.text;
    const cmdText = (command: string) => buildNow([cmd(command)], "RUNNING", "run")?.text;

    it("cd /workspace/<相対パス> && は外し、「<相対パス> で」を先頭に添える（tool も command も）", () => {
      expect(tool("cd /workspace/apps/agent && pnpm exec vitest run")).toBe(
        "apps/agent で $ pnpm exec vitest run",
      );
      expect(cmdText("cd /workspace/apps/gateway && pnpm test")).toBe("apps/gateway で pnpm test");
      expect(buildNow([cmd("cd /workspace/a && ls")], "RUNNING", "run")?.kind).toBe("command");
    });

    it("切れた JSON でも前置きを外す（… は残る）", () => {
      const cut = '{"command":"cd /workspace/apps/agent && pnpm exec vitest ru';
      expect(buildNow([start("c1", "bash", cut)], "RUNNING", "run")?.text).toBe(
        "apps/agent で $ pnpm exec vitest ru…",
      );
    });

    it("cd /workspace && は前置きだけ外し、場所は付けない", () => {
      expect(tool("cd /workspace && git status")).toBe("$ git status");
      expect(cmdText("cd /workspace && git status")).toBe("git status");
      expect(cmdText("cd /workspace/ && git status")).toBe("git status");
    });

    it("前置きの無いコマンドはそのまま", () => {
      expect(tool("pnpm test")).toBe("$ pnpm test");
      expect(cmdText("pnpm test")).toBe("pnpm test");
      expect(cmdText("echo cd /workspace/a && b")).toBe("echo cd /workspace/a && b");
    });

    it("外してよいのは素直な相対パスだけ。..・/workspace の外・変数・引用符・空のコマンドはそのまま", () => {
      for (const c of [
        "cd /workspace/../etc && rm x",
        "cd /workspace/a/../b && ls",
        "cd /workspace/a//b && ls",
        "cd /workspace/./a && ls",
        "cd /workspaces/a && ls",
        "cd /tmp && ls",
        "cd /workspace/$HOME && ls",
        'cd "/workspace/my dir" && ls',
        "cd /workspace/a; ls",
        "cd /workspace/a &&",
      ]) {
        expect(cmdText(c), c).toBe(c);
        expect(tool(c), c).toBe(`$ ${c}`);
      }
    });

    it("末尾のスラッシュ・複数の &&。場所も制御文字は除き、秘密はマスクし、300 字に収める", () => {
      expect(cmdText("cd /workspace/apps/agent/ && ls")).toBe("apps/agent で ls");
      expect(cmdText("cd /workspace/a && cd b && ls")).toBe("a で cd b && ls");
      expect(cmdText("cd /workspace/a &&\nls\u0007")).toBe("a で ls");
      const long = cmdText(`cd /workspace/a && echo ${GHP} ${"z".repeat(500)}`) ?? "";
      expect(long).not.toContain(GHP);
      expect(long.startsWith("a で echo")).toBe(true);
      expect(long.length).toBeLessThanOrEqual(300);
    });

    it("契約（TaskDetailDto の now）に合う", () => {
      const now = buildNow([cmd("cd /workspace/apps/agent && ls")], "RUNNING", "run");
      expect(TaskDetailDtoSchema.shape.now.safeParse(now).success).toBe(true);
    });
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
