import {
  TASK_STATUSES,
  type TaskDetailDto,
  type TaskEventDto,
  type TaskStatusDto,
  type VisibleTaskDto,
} from "@rovo/dashboard-contract";
import { overviewFixture, taskEventsFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import { buildSteps, describeEvent, mergeEvents, nowSentence, phaseBand } from "../src/steps";

type Phase = TaskDetailDto["phase"];
type Now = TaskDetailDto["now"];

const at = "2026-10-21T05:50:00Z";
const SHA = "a".repeat(40);
const ev = (seq: number, rest: Record<string, unknown>) =>
  ({ seq, at, ...rest }) as unknown as TaskEventDto;
const task = (over: Partial<VisibleTaskDto> = {}): VisibleTaskDto => ({
  ...(overviewFixture.tasks[0] as VisibleTaskDto),
  ...over,
});
/** 改行・タブ以外の制御文字（C0・DEL・C1）と、双方向の制御文字があるか（正規表現に制御文字を書かないため、コード単位で見る） */
const hasUnsafeChar = (s: string) =>
  [...s].some((ch) => {
    const c = ch.charCodeAt(0);
    return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e);
  });
const usage = (seq: number) =>
  ev(seq, {
    type: "usage",
    cost_usd: 1,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });

describe("describeEvent（人の言葉の動詞への変換。全イベントの型 × 成功 / 失敗 / 実行中）", () => {
  it("command: 成功・失敗・実行中", () => {
    const base = { type: "command", command: "pnpm test", exit_code: 0, duration_ms: 42_000 };
    const ok = describeEvent(ev(1, base), { current: false });
    expect(ok).toMatchObject({ what: "コマンドを実行した", target: "pnpm test", tone: "normal" });
    expect(ok?.note).toContain("42 秒");
    const fail = describeEvent(ev(1, { ...base, exit_code: 2 }), { current: false });
    expect(fail).toMatchObject({ what: "コマンドが失敗した", tone: "fail" });
    expect(fail?.note).toContain("終了コード 2");
    const run = describeEvent(ev(1, { ...base, exit_code: null }), { current: true });
    expect(run).toMatchObject({ what: "コマンドを実行中", tone: "normal" });
    const stale = describeEvent(ev(1, { ...base, exit_code: null }), { current: false });
    expect(stale?.what).toBe("コマンドを実行した");
    expect(stale?.note).toContain("終了コード不明");
  });

  it("command: 複数行・制御文字は 1 行にして除く", () => {
    const d = describeEvent(
      ev(1, { type: "command", command: "echo a\nrm‮ -rf\u0007 b", exit_code: 0 }),
      { current: false },
    );
    expect(d?.target).toBe("echo a rm -rf b");
  });

  it("edit: 作った / 編集した / 消した", () => {
    const e = (op: string) =>
      describeEvent(ev(1, { type: "edit", path: "src/a.ts", op, added: 12, removed: 3 }), {
        current: false,
      });
    expect(e("create")).toMatchObject({ what: "ファイルを作った", target: "src/a.ts" });
    expect(e("modify")).toMatchObject({ what: "ファイルを編集した", target: "src/a.ts" });
    expect(e("delete")).toMatchObject({ what: "ファイルを消した", target: "src/a.ts" });
    expect(e("modify")?.note).toBe("12 行追加、3 行削除");
  });

  it("edit: 実行中（current）でも失敗にはならない", () => {
    const d = describeEvent(
      ev(1, { type: "edit", path: "a", op: "modify", added: 0, removed: 0 }),
      {
        current: true,
      },
    );
    expect(d?.tone).toBe("normal");
  });

  it("commit", () => {
    const d = describeEvent(ev(1, { type: "commit", message: "fix: 直す", sha: SHA, files: 2 }), {
      current: false,
    });
    expect(d).toMatchObject({ what: "コミットした", target: "fix: 直す" });
    expect(d?.note).toContain("2 ファイル");
    expect(d?.note).toContain("aaaaaaa");
  });

  it("web: 検索した / ページを読んだ / ページを開いた（host は無くてもよい）", () => {
    const w = (kind: string, host?: string) =>
      describeEvent(ev(1, { type: "web", kind, ...(host ? { host } : {}) }), { current: false });
    expect(w("search", "example.com")).toMatchObject({ what: "検索した", target: "example.com" });
    expect(w("fetch", "registry.npmjs.org")).toMatchObject({ what: "ページを読んだ" });
    expect(w("browse", "example.com")).toMatchObject({ what: "ページを開いた" });
    expect(w("search")?.target).toBe("");
  });

  it("status_changed: 全状態に文がある。reason は note に出る", () => {
    for (const s of TASK_STATUSES) {
      const d = describeEvent(ev(1, { type: "status_changed", to: s }), { current: false });
      expect(d?.what.length, s).toBeGreaterThan(0);
    }
    const f = describeEvent(
      ev(1, { type: "status_changed", to: "FAILED", reason: "base_sha_not_found" }),
      { current: false },
    );
    expect(f).toMatchObject({ what: "失敗した", tone: "fail" });
    expect(f?.note).toContain("base_sha_not_found");
    expect(
      describeEvent(ev(1, { type: "status_changed", to: "COMPLETED" }), { current: false })?.tone,
    ).toBe("normal");
  });

  it("draft_pr_created", () => {
    const d = describeEvent(
      ev(1, { type: "draft_pr_created", pr_number: 23, pr_url: "https://github.com/a/b/pull/23" }),
      { current: false },
    );
    expect(d).toMatchObject({ what: "Draft PR を作った", target: "#23" });
  });

  it("tool_start: 既知のツールは summary の JSON から既知のキーだけ取り出して人の言葉にする", () => {
    const start = (name: string, summary: string) =>
      describeEvent(ev(1, { type: "tool_start", call_id: "c", name, summary }), { current: false });
    expect(start("read_file", '{"path":"src/x.ts","start_line":3}')).toMatchObject({
      what: "ファイルを読んだ",
      target: "src/x.ts",
    });
    expect(start("list_files", '{"path":"/workspace"}')).toMatchObject({
      what: "一覧を見た",
      target: "/workspace",
    });
    expect(start("search", '{"pattern":"title","path":"src"}')).toMatchObject({
      what: "検索した",
      target: "title",
    });
    expect(start("bash", '{"command":"ls; cat README.md | head -5"}')).toMatchObject({
      what: "コマンドを実行した",
      target: "ls; cat README.md | head -5",
    });
    expect(start("web_search", '{"query":"vitest"}')).toMatchObject({
      what: "検索した",
      target: "vitest",
    });
    expect(start("report_completion", '{"summary":"本文は出さない"}')).toEqual({
      what: "完了を報告した",
      target: "",
      note: "",
      tone: "normal",
    });
    // 実行中
    const running = describeEvent(
      ev(1, { type: "tool_start", call_id: "c", name: "bash", summary: '{"command":"pnpm test"}' }),
      { current: true },
    );
    expect(running).toMatchObject({ what: "コマンドを実行中", target: "pnpm test" });
  });

  it("tool_start: JSON でない・既知のキーで始まらない切れ方・未知のキーだけのときは、sanitize した文字列のまま", () => {
    const start = (name: string, summary: string) =>
      describeEvent(ev(1, { type: "tool_start", call_id: "c", name, summary }), { current: false });
    // 既知のキーで始まる切れた JSON は値を取り出す（… 付き）。そうでない切れ方は生のまま
    expect(start("read_file", '{"path":"src/very-long')?.target).toBe("src/very-long…");
    const cut = start("read_file", '{"start_line":3,"path":"src/very-long');
    expect(cut?.target).toBe('{"start_line":3,"path":"src/very-long');
    const weird = start("read_file", '{"foo":"bar"}');
    expect(weird?.target).toBe('{"foo":"bar"}');
    const wrongType = start("read_file", '{"path":{"a":1}}');
    expect(wrongType?.target).toBe('{"path":{"a":1}}');
    const unknown = start("some_new_tool", "x\u0007y");
    expect(unknown).toMatchObject({ what: "some_new_tool を実行した", target: "xy" });
    // 配列・数値の JSON でも壊れない
    expect(start("read_file", "[1,2]")?.target).toBe("[1,2]");
    expect(start("read_file", "123")?.target).toBe("123");
  });

  describe("tool_start（bash）: 切れた JSON からコマンドを取り出す", () => {
    const bash = (summary: string, current = false) =>
      describeEvent(ev(1, { type: "tool_start", call_id: "c", name: "bash", summary }), {
        current,
      });

    it("完全な JSON は今までどおり。「…」は付けない", () => {
      const d = bash('{"command":"pnpm test --filter agent"}');
      expect(d?.target).toBe("pnpm test --filter agent");
    });

    it("途中で切れた JSON でも、生の JSON ではなくコマンドを出す。切れていれば末尾に … を付ける", () => {
      const d = bash('{"command":"npm run build && npm test -- --reporter=ver');
      expect(d).toMatchObject({
        what: "コマンドを実行した",
        target: "npm run build && npm test -- --reporter=ver…",
      });
      expect(d?.target).not.toContain('{"command"');
      expect(bash('{"command":"ls -la', true)).toMatchObject({
        what: "コマンドを実行中",
        target: "ls -la…",
      });
    });

    it("agent が切り詰めに付ける ... や … は、… に 1 つにまとめる（… を重ねない）", () => {
      expect(bash('{"command":"pnpm exec vitest ru...')?.target).toBe("pnpm exec vitest ru…");
      expect(bash('{"command":"pnpm exec vitest ru…')?.target).toBe("pnpm exec vitest ru…");
    });

    it('閉じる " まで読めていれば、後ろが切れていても値は完全（… を付けない）', () => {
      expect(bash('{"command":"ls","timeout":12...')?.target).toBe("ls");
    });

    it('JSON の文字列のエスケープ（\\" \\\\ \\n \\t \\uXXXX）を戻す', () => {
      const cut = String.raw`{"command":"echo \"hi\" \\ done\nnext\tTab \u3042 \u00e9 tail`;
      // \n と \t は 1 行にするときに空白 1 つになる
      expect(bash(cut)?.target).toBe('echo "hi" \\ done next Tab あ é tail…');
      // 閉じていれば、後ろに別のキーが続いても同じ（完全な JSON でないとき）
      const closed = String.raw`{"command":"grep \"a\\b\" f","timeout":1`;
      expect(bash(closed)?.target).toBe('grep "a\\b" f');
    });

    it("末尾が中途半端なエスケープで切れていても、壊れた文字を出さない", () => {
      const t = (tail: string) => bash(`{"command":"echo ok ${tail}`)?.target;
      expect(t("\\")).toBe("echo ok…");
      expect(t("\\u")).toBe("echo ok…");
      expect(t("\\u1")).toBe("echo ok…");
      expect(t("\\u12")).toBe("echo ok…");
      expect(t("\\u00e")).toBe("echo ok…");
      // サロゲートペアの前半だけで切れた
      expect(t("\\ud83d")).toBe("echo ok…");
      expect(t("\\ud83d\\ude")).toBe("echo ok…");
      // 切り詰めの印（...）が付いていても同じ
      expect(t("\\...")).toBe("echo ok…");
      expect(t("\\u12...")).toBe("echo ok…");
      // 完全なペアは戻す
      expect(t("\\ud83d\\ude00 x")).toBe("echo ok 😀 x…");
      // 直前の \\\\ は 1 つの \\ になり、そのあとで切れていても壊れない
      expect(t("\\\\")).toBe("echo ok \\…");
    });

    it("取り出せないとき（未知のキーで始まる・値が文字列でない・エスケープが壊れている）は、生の文字列のまま", () => {
      expect(bash('{"foo":"bar","command":"ls')?.target).toBe('{"foo":"bar","command":"ls');
      expect(bash('{"cmd":"ls')?.target).toBe('{"cmd":"ls');
      expect(bash('{"command":{"a":1')?.target).toBe('{"command":{"a":1');
      expect(bash('{"command":"ls \\q')?.target).toBe('{"command":"ls \\q');
      expect(bash('{"command":"ls \\uZZZZ')?.target).toBe('{"command":"ls \\uZZZZ');
      expect(bash('{"command":"')?.target).toBe('{"command":"');
      // 既知のキーでも、そのツールの keys に無ければ取り出さない
      const read = describeEvent(
        ev(1, { type: "tool_start", call_id: "c", name: "read_file", summary: '{"command":"ls' }),
        { current: false },
      );
      expect(read?.target).toBe('{"command":"ls');
    });

    it("read_file など bash 以外も、切れた JSON から既知のキーの値を取り出す", () => {
      const start = (name: string, summary: string) =>
        describeEvent(ev(1, { type: "tool_start", call_id: "c", name, summary }), {
          current: false,
        });
      expect(start("read_file", '{"path":"src/very-long/pa')?.target).toBe("src/very-long/pa…");
      expect(start("search", '{"pattern":"foo.*ba')?.target).toBe("foo.*ba…");
      expect(start("web_fetch", '{"url":"https://example.com/a?b=1')?.target).toBe(
        "https://example.com/a?b=1…",
      );
    });

    it("取り出した値も、制御文字・双方向文字を除いて 1 行にする（エスケープで書かれていても）", () => {
      const cut = String.raw`{"command":"echo a\nrm\u202e -rf\u0007 b\u001b[31m c`;
      const d = bash(cut);
      expect(d?.target).toBe("echo a rm -rf b[31m c…");
      expect(hasUnsafeChar(d?.target ?? "")).toBe(false);
      // 生の制御文字・双方向文字が混じっていても同じ
      expect(bash('{"command":"echo \u0007x\u202ey')?.target).toBe("echo xy…");
      // <script> などは文字のまま（HTML にはしない）
      expect(bash('{"command":"echo <script>alert(1)</script>')?.target).toBe(
        "echo <script>alert(1)</script>…",
      );
    });
  });

  describe("コマンドの cd /workspace の前置き", () => {
    const bash = (summary: string) =>
      describeEvent(ev(1, { type: "tool_start", call_id: "c", name: "bash", summary }), {
        current: false,
      });
    const command = (c: string) =>
      describeEvent(ev(1, { type: "command", command: c, exit_code: 0 }), { current: false });

    it("cd /workspace/<相対パス> && は外し、場所（<相対パス>）を添える", () => {
      const d = bash('{"command":"cd /workspace/apps/agent && pnpm exec vitest run"}');
      expect(d).toMatchObject({
        what: "コマンドを実行した",
        target: "pnpm exec vitest run",
        where: "apps/agent",
      });
      expect(d?.target).not.toContain("cd /workspace");
      // 構造化イベント（command）も同じ見せ方
      expect(command("cd /workspace/apps/gateway && pnpm test")).toMatchObject({
        target: "pnpm test",
        where: "apps/gateway",
      });
    });

    it("切れた JSON でも前置きを外す（… は残る）", () => {
      const d = bash('{"command":"cd /workspace/apps/agent && pnpm exec vitest ru');
      expect(d).toMatchObject({ target: "pnpm exec vitest ru…", where: "apps/agent" });
    });

    it("cd /workspace && は前置きだけ外し、場所は付けない", () => {
      const d = bash('{"command":"cd /workspace && git status"}');
      expect(d?.target).toBe("git status");
      expect(d).not.toHaveProperty("where");
      expect(command("cd /workspace && git status")?.target).toBe("git status");
      expect(command("cd /workspace && git status")).not.toHaveProperty("where");
      expect(command("cd /workspace/ && git status")?.target).toBe("git status");
    });

    it("前置きの無いコマンドはそのまま（場所も付けない）", () => {
      const d = bash('{"command":"pnpm test"}');
      expect(d?.target).toBe("pnpm test");
      expect(d).not.toHaveProperty("where");
      expect(command("echo cd /workspace/a && b")?.target).toBe("echo cd /workspace/a && b");
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
        "cd /workspace/a && ",
      ]) {
        const d = command(c);
        expect(d?.target, c).toBe(c.trim());
        expect(d, c).not.toHaveProperty("where");
      }
    });

    it("末尾のスラッシュ・入れ子のパス・複数の && ", () => {
      expect(command("cd /workspace/apps/agent/ && ls")).toMatchObject({
        target: "ls",
        where: "apps/agent",
      });
      expect(command("cd /workspace/a && cd b && ls")).toMatchObject({
        target: "cd b && ls",
        where: "a",
      });
    });

    it("buildSteps でも、現在の手順の行に同じ見せ方で出る", () => {
      const steps = buildSteps(
        [
          ev(1, {
            type: "tool_start",
            call_id: "a",
            name: "bash",
            summary: '{"command":"cd /workspace/apps/agent && pnpm test"}',
          }),
        ],
        true,
      );
      expect(steps[0]).toMatchObject({
        what: "コマンドを実行中",
        target: "pnpm test",
        where: "apps/agent",
        current: true,
        command: true,
      });
    });
  });

  it("tool_end: 失敗のときだけ出す。成功は null", () => {
    const ok = describeEvent(
      ev(2, { type: "tool_end", call_id: "c", is_error: false, summary: "ok" }),
      { current: false },
    );
    expect(ok).toBeNull();
    const bad = describeEvent(
      ev(2, { type: "tool_end", call_id: "c", is_error: true, summary: "x" }),
      { current: false },
    );
    expect(bad).toMatchObject({ what: "失敗した", target: "x", tone: "fail" });
  });

  it("agent_event（gateway が知らない型）は型名だけ。usage は進み具合に出さない（null）", () => {
    expect(
      describeEvent(ev(1, { type: "agent_event", agent_type: "future" }), { current: false }),
    ).toMatchObject({ what: "その他の処理", target: "future" });
    expect(describeEvent(usage(1), { current: false })).toBeNull();
  });

  it("fixtures の全イベントを変換できる（usage 以外は null にならない）", () => {
    for (const e of taskEventsFixture.events) {
      const d = describeEvent(e, { current: false });
      if (e.type === "usage") expect(d).toBeNull();
      else expect(d?.what.length, e.type).toBeGreaterThan(0);
    }
  });

  it("<script>・<img onerror>・javascript: のリンク記法は文字のまま。制御文字・双方向文字だけ除く", () => {
    const evil =
      "<script>window.__xss=1</script><img src=x onerror=alert(1)>[x](javascript:alert(1))";
    const d = describeEvent(ev(1, { type: "commit", message: `${evil}‮`, sha: SHA, files: 1 }), {
      current: false,
    });
    expect(d?.target).toBe(evil);
  });
});

describe("mergeEvents（seq で重複排除・昇順）", () => {
  const e = (seq: number) => ev(seq, { type: "agent_event", agent_type: `t${seq}` });
  it("重複を積まない。順序は seq の昇順", () => {
    const merged = mergeEvents([e(3), e(4)], [e(5), e(4), e(3), e(6)]);
    expect(merged.map((x) => x.seq)).toEqual([3, 4, 5, 6]);
  });
  it("古い側（before）を前に足せる", () => {
    expect(mergeEvents([e(5), e(6)], [e(3), e(4)]).map((x) => x.seq)).toEqual([3, 4, 5, 6]);
  });
  it("同じ seq は後から来た方で置き換える", () => {
    const a = ev(1, { type: "agent_event", agent_type: "old" });
    const b = ev(1, { type: "agent_event", agent_type: "new" });
    const m = mergeEvents([a], [b]);
    expect(m).toHaveLength(1);
    expect((m[0] as { agent_type: string }).agent_type).toBe("new");
  });
  it("元の配列を変えない", () => {
    const prev = [e(2)];
    mergeEvents(prev, [e(1)]);
    expect(prev.map((x) => x.seq)).toEqual([2]);
  });
});

describe("buildSteps", () => {
  it("時系列で、実行中のタスクは最後の手順が「いま」。usage は含めない", () => {
    const steps = buildSteps(taskEventsFixture.events, true);
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
    expect(steps.filter((s) => s.current).map((s) => s.seq)).toEqual([9]);
  });
  it("終端のタスクには「いま」が無い", () => {
    expect(buildSteps(taskEventsFixture.events, false).some((s) => s.current)).toBe(false);
  });
  it("最後が usage でも、その前の手順が「いま」", () => {
    const evs = [ev(1, { type: "web", kind: "search" }), usage(2)];
    expect(buildSteps(evs, true).map((s) => [s.seq, s.current])).toEqual([[1, true]]);
  });
  it("空なら空", () => {
    expect(buildSteps([], true)).toEqual([]);
  });
  it("コマンドの手順には command の印（画面で `$ コマンド` の行にする）。ほかの手順には付けない", () => {
    const steps = buildSteps(taskEventsFixture.events, false);
    expect(steps.filter((s) => s.command).map((s) => s.seq)).toEqual([6]);
    // 古い履歴の bash の tool_start も、コマンドの行
    const legacy = buildSteps(
      [ev(1, { type: "tool_start", call_id: "a", name: "bash", summary: '{"command":"ls"}' })],
      false,
    );
    expect(legacy[0]?.command).toBe(true);
    const other = buildSteps(
      [ev(1, { type: "tool_start", call_id: "b", name: "read_file", summary: '{"path":"a"}' })],
      false,
    );
    expect(other[0]?.command).toBe(false);
  });

  const start = (seq: number, id: string, name: string, summary: string) =>
    ev(seq, { type: "tool_start", call_id: id, name, summary });
  const end = (seq: number, id: string, is_error = false, summary = "out") =>
    ev(seq, { type: "tool_end", call_id: id, is_error, summary });
  const command = (seq: number, c: string) =>
    ev(seq, { type: "command", command: c, exit_code: 0, duration_ms: 44_000 });
  const whats = (evs: TaskEventDto[], active = false) =>
    buildSteps(evs, active).map((s) => `${s.what}|${s.target}`);

  describe("構造化イベントのあるツールは 1 行に畳む", () => {
    it("bash: tool_start / tool_end を出さず、command の 1 行だけ", () => {
      const evs = [start(1, "a", "bash", '{"command":"ls"}'), command(2, "ls"), end(3, "a")];
      expect(whats(evs)).toEqual(["コマンドを実行した|ls"]);
    });

    it("write_file / edit_file / git_commit / web_* も同じ", () => {
      const evs = [
        start(1, "a", "write_file", '{"path":"a.ts"}'),
        ev(2, { type: "edit", path: "a.ts", op: "create", added: 1, removed: 0 }),
        end(3, "a"),
        start(4, "b", "edit_file", '{"path":"a.ts"}'),
        ev(5, { type: "edit", path: "a.ts", op: "modify", added: 1, removed: 1 }),
        end(6, "b"),
        start(7, "c", "git_commit", '{"message":"m"}'),
        ev(8, { type: "commit", message: "m", sha: SHA, files: 1 }),
        end(9, "c"),
        start(10, "d", "web_search", '{"query":"q"}'),
        ev(11, { type: "web", kind: "search" }),
        end(12, "d"),
        start(13, "e", "web_fetch", '{"url":"https://example.com/"}'),
        ev(14, { type: "web", kind: "fetch", host: "example.com" }),
        end(15, "e"),
        start(16, "f", "web_browse", '{"url":"https://example.com/"}'),
        ev(17, { type: "web", kind: "browse", host: "example.com" }),
        end(18, "f"),
      ];
      expect(buildSteps(evs, false).map((s) => s.seq)).toEqual([2, 5, 8, 11, 14, 17]);
    });

    it("同じ call の失敗の tool_end も、構造化イベントがあれば出さない", () => {
      const evs = [
        start(1, "a", "bash", '{"command":"false"}'),
        ev(2, { type: "command", command: "false", exit_code: 1 }),
        end(3, "a", true),
      ];
      expect(buildSteps(evs, false).map((s) => s.seq)).toEqual([2]);
    });

    it("構造化イベントが来ていない古い履歴は、縮退して出す（開始は人の言葉、成功の終了は出さない）", () => {
      const evs = [start(1, "a", "bash", '{"command":"ls"}'), end(2, "a")];
      expect(whats(evs)).toEqual(["コマンドを実行した|ls"]);
      const failed = [start(1, "a", "bash", '{"command":"ls"}'), end(2, "a", true, "boom")];
      expect(whats(failed)).toEqual(["コマンドを実行した|ls", "失敗した|boom"]);
    });

    it("実行中（start だけ）は「実行中」の 1 行。command が来たら置き換わる", () => {
      const running = [start(1, "a", "bash", '{"command":"pnpm test"}')];
      expect(whats(running, true)).toEqual(["コマンドを実行中|pnpm test"]);
      expect(buildSteps(running, true)[0]?.current).toBe(true);
      const done = [...running, command(2, "pnpm test")];
      expect(whats(done, true)).toEqual(["コマンドを実行した|pnpm test"]);
    });

    it("1 つの構造化イベントは 1 つの call にしか対応しない（連続する bash）", () => {
      const evs = [
        start(1, "a", "bash", '{"command":"one"}'),
        command(2, "one"),
        end(3, "a"),
        start(4, "b", "bash", '{"command":"two"}'),
        end(5, "b", true, "spawn failed"),
      ];
      expect(whats(evs)).toEqual([
        "コマンドを実行した|one",
        "コマンドを実行した|two",
        "失敗した|spawn failed",
      ]);
    });

    it("構造化イベントの無いツール（read_file など）は start を人の言葉で出し、成功の end は出さない", () => {
      const evs = [
        start(1, "a", "read_file", '{"path":"src/x.ts"}'),
        end(2, "a"),
        start(3, "b", "report_completion", '{"summary":"done"}'),
        end(4, "b"),
      ];
      expect(whats(evs)).toEqual(["ファイルを読んだ|src/x.ts", "完了を報告した|"]);
    });
  });
});

describe("phaseBand: gateway の stopped_phase を優先する", () => {
  const stoppedAt = (stopped: "prepare" | "run" | "verify" | null | undefined) =>
    phaseBand(task({ status: "FAILED" }), "done", new Set(), stopped).findIndex(
      (b) => b.state === "stopped",
    );
  it("stopped_phase があればそれで止まった段を決める（events からの推定より優先）", () => {
    expect(stoppedAt("prepare")).toBe(0);
    expect(stoppedAt("run")).toBe(1);
    expect(stoppedAt("verify")).toBe(2);
    const b = phaseBand(task({ status: "FAILED" }), "done", new Set(["VERIFYING"]), "run");
    expect(b.findIndex((x) => x.state === "stopped")).toBe(1);
  });
  it("無い（undefined / null）ときは従来の推定", () => {
    expect(stoppedAt(undefined)).toBe(1);
    expect(stoppedAt(null)).toBe(1);
  });
});

describe("phaseBand（準備 → 実行 → 検証 → 完了）", () => {
  const states = (s: TaskStatusDto, over: Partial<VisibleTaskDto> = {}, phase: Phase = "run") =>
    phaseBand(task({ status: s, ...over }), phase).map((b) => b.state);
  it("名前は 準備・実行・検証・完了 の 4 つ", () => {
    expect(phaseBand(task({ status: "RUNNING" }), "run").map((b) => b.name)).toEqual([
      "準備",
      "実行",
      "検証",
      "完了",
    ]);
  });
  it("CREATING → 準備がいま", () => {
    expect(states("CREATING", {}, "prepare")).toEqual(["now", "todo", "todo", "todo"]);
  });
  it("RUNNING → 実行がいま", () => {
    expect(states("RUNNING")).toEqual(["done", "now", "todo", "todo"]);
  });
  it("VERIFYING → 検証がいま", () => {
    expect(states("VERIFYING", {}, "verify")).toEqual(["done", "done", "now", "todo"]);
  });
  it("INPUT_REQUIRED → 実行で止まって入力待ち（waiting）", () => {
    expect(states("INPUT_REQUIRED")).toEqual(["done", "waiting", "todo", "todo"]);
  });
  it("RECOVERING → 実行のまま復旧中（recovering）", () => {
    expect(states("RECOVERING")).toEqual(["done", "recovering", "todo", "todo"]);
  });
  it("COMPLETED → すべて済み", () => {
    expect(states("COMPLETED", {}, "done")).toEqual(["done", "done", "done", "done"]);
  });
  it("failure_phase が setup → 準備で止まった（stopped）", () => {
    expect(
      states("FAILED", { failure_phase: "setup", reason: "base_sha_not_found" }, "prepare"),
    ).toEqual(["stopped", "todo", "todo", "todo"]);
    // サーバーの phase が done でも、failure_phase が優先
    expect(states("FAILED", { failure_phase: "setup" }, "done")).toEqual([
      "stopped",
      "todo",
      "todo",
      "todo",
    ]);
  });
  it("実行中に失敗 / 予算超過 / キャンセル → サーバーの phase の段階で止まった", () => {
    for (const s of ["FAILED", "BUDGET_EXCEEDED", "CANCELLED"] as const) {
      expect(states(s, {}, "run"), s).toEqual(["done", "stopped", "todo", "todo"]);
      expect(states(s, {}, "verify"), s).toEqual(["done", "done", "stopped", "todo"]);
    }
  });
  it("終端で phase が done のとき: VERIFYING に入った記録があれば検証で、無ければ実行で止まった", () => {
    const withVerify = phaseBand(task({ status: "FAILED" }), "done", new Set(["VERIFYING"]));
    expect(withVerify.map((b) => b.state)).toEqual(["done", "done", "stopped", "todo"]);
    const without = phaseBand(
      task({ status: "FAILED", started_at: "2026-10-21T01:06:10Z" }),
      "done",
    );
    expect(without.map((b) => b.state)).toEqual(["done", "stopped", "todo", "todo"]);
    const never = phaseBand(task({ status: "CANCELLED", started_at: null }), "done");
    expect(never.map((b) => b.state)).toEqual(["stopped", "todo", "todo", "todo"]);
  });
  it("全状態で、色に頼らない文字（label）が全段にある", () => {
    for (const s of TASK_STATUSES) {
      for (const b of phaseBand(task({ status: s }), "run")) {
        expect(b.label.length, `${s}/${b.name}`).toBeGreaterThan(0);
      }
    }
  });
  it("止まった段の文字は状態ごとに違う（失敗 / 予算超過 / キャンセル）", () => {
    const l = (s: TaskStatusDto) =>
      phaseBand(task({ status: s }), "run").find((b) => b.state === "stopped")?.label;
    expect(new Set([l("FAILED"), l("BUDGET_EXCEEDED"), l("CANCELLED")]).size).toBe(3);
  });
});

describe("nowSentence（「いまは X を実行しています」）", () => {
  const now = (kind: string, text: string) => ({ kind, text }) as unknown as Now;
  const sentence = (n: Now, s: TaskStatusDto) => nowSentence(n, s);
  it("now がある: 種類ごとの動詞", () => {
    expect(sentence(now("command", "npm ci"), "RUNNING")).toEqual({
      before: "いまは ",
      target: "npm ci",
      after: " を実行しています。",
    });
    expect(sentence(now("edit", "a.ts"), "RUNNING").after).toBe(" を編集しています。");
    expect(sentence(now("commit", "m"), "RUNNING").after).toBe(" をコミットしています。");
    expect(sentence(now("web", "example.com"), "RUNNING").after).toBe(" を調べています。");
    expect(sentence(now("tool", "x"), "RUNNING").after).toBe(" を実行しています。");
  });
  it("「$ 」で始まる text はプロンプトとコマンドに分ける（コンソールと同じ見た目にするため）", () => {
    expect(sentence(now("tool", "$ ls -la"), "RUNNING")).toEqual({
      before: "いまは ",
      prompt: "$ ",
      target: "ls -la",
      after: " を実行しています。",
    });
    expect(sentence(now("tool", "read_file: a.ts"), "RUNNING")).not.toHaveProperty("prompt");
  });
  it("cd /workspace/<相対パス> && の前置きは外し、「<相対パス> で」を添える（タイムラインと同じ見せ方）", () => {
    const expected = {
      before: "いまは apps/agent で ",
      prompt: "$ ",
      target: "pnpm test",
      after: " を実行しています。",
    };
    // 前置きがそのまま入っている text
    expect(sentence(now("tool", "$ cd /workspace/apps/agent && pnpm test"), "RUNNING")).toEqual(
      expected,
    );
    // gateway が「<相対パス> で」を添えた text
    expect(sentence(now("tool", "apps/agent で $ pnpm test"), "RUNNING")).toEqual(expected);
    // command の種類（$ なし）
    expect(sentence(now("command", "cd /workspace/apps/agent && pnpm test"), "RUNNING")).toEqual({
      before: "いまは apps/agent で ",
      target: "pnpm test",
      after: " を実行しています。",
    });
    expect(sentence(now("command", "apps/agent で pnpm test"), "RUNNING")).toEqual({
      before: "いまは apps/agent で ",
      target: "pnpm test",
      after: " を実行しています。",
    });
  });
  it("cd /workspace && は前置きだけ外す。場所は添えない。前置きの無い text はそのまま", () => {
    expect(sentence(now("tool", "$ cd /workspace && ls -la"), "RUNNING")).toEqual({
      before: "いまは ",
      prompt: "$ ",
      target: "ls -la",
      after: " を実行しています。",
    });
    expect(sentence(now("command", "cd /workspace && ls"), "RUNNING").target).toBe("ls");
    expect(sentence(now("command", "cd /workspace/../etc && ls"), "RUNNING")).toEqual({
      before: "いまは ",
      target: "cd /workspace/../etc && ls",
      after: " を実行しています。",
    });
    // コマンド以外の種類には、場所の読み取りをしない
    expect(sentence(now("commit", "commit で x"), "RUNNING")).toEqual({
      before: "いまは ",
      target: "commit で x",
      after: " をコミットしています。",
    });
  });
  it("waiting は固定の文（英語の text をそのまま出さない）", () => {
    expect(sentence(now("waiting", "waiting for input"), "INPUT_REQUIRED")).toEqual({
      before: "入力を待っています。",
      target: "",
      after: "",
    });
  });
  it("waiting のうち予算の延長の承認待ち（text が waiting for budget approval）は、入力待ちに一言添える", () => {
    expect(sentence(now("waiting", "waiting for budget approval"), "INPUT_REQUIRED")).toEqual({
      before: "予算の承認を待っています（入力待ち）。",
      target: "",
      after: "",
    });
  });
  it("now が null: 状態ごとの文", () => {
    for (const s of TASK_STATUSES) {
      const n = sentence(null, s);
      expect(`${n.before}${n.target}${n.after}`.length, s).toBeGreaterThan(0);
      expect(n.target).toBe("");
    }
    expect(sentence(null, "INPUT_REQUIRED").before).toContain("待");
    expect(sentence(null, "COMPLETED").before).toContain("完了");
  });
  it("target は制御文字を除いた 1 行", () => {
    expect(sentence(now("command", "a\nb‮"), "RUNNING").target).toBe("a b");
  });
});
