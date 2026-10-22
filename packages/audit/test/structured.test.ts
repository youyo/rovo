import { describe, expect, it } from "vitest";
import {
  hostOfUrl,
  normalizeStructuredEvent,
  STRUCTURED_LIMITS,
  type StructuredEvent,
} from "../src";

// 秘密の検出に反応しないよう、明らかな偽物を組み立てる
const GHP = `ghp_${"a1B2".repeat(9)}`;
const GHS = `ghs_${"c3D4".repeat(9)}`;
const PAT = `github_pat_${"E5f6".repeat(8)}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";

const norm = (type: string, data: unknown) => normalizeStructuredEvent(type, data);
const cmd = (data: Record<string, unknown>) =>
  norm("command", data) as Extract<StructuredEvent, { type: "command" }>;

describe("command", () => {
  it("命令・cwd・exit_code・所要時間・出力の末尾を、決まった形で返す", () => {
    expect(
      norm("command", {
        command: "pnpm test",
        cwd: "apps/gateway",
        exitCode: 1,
        durationMs: 1234,
        outputTail: "FAIL a\n",
        extra: "落とされる",
      }),
    ).toEqual({
      type: "command",
      command: "pnpm test",
      cwd: "apps/gateway",
      exitCode: 1,
      durationMs: 1234,
      outputTail: "FAIL a\n",
    });
  });

  it("秘密は、先頭でない位置でも command にも出力にも残らない", () => {
    const e = cmd({
      command: `echo start && wget --header "Authorization: Bearer ${"abcdef0123456789xyz"}" https://user:s3cretPass@h.example/x?t=${GHP} && GITHUB_TOKEN=plain123 run ${GHS} ${PAT}`,
      outputTail: `line1\nline2 ${GHP}\nAPI_KEY=plainvalue789\n`,
    });
    const whole = JSON.stringify(e);
    for (const s of [
      GHP,
      GHS,
      PAT,
      "abcdef0123456789xyz",
      "s3cretPass",
      "plain123",
      "plainvalue789",
    ]) {
      expect(whole, s).not.toContain(s);
    }
    expect(e.command).toContain("[REDACTED]");
    expect(e.command.startsWith("echo start")).toBe(true);
  });

  it("ANSI・制御文字・双方向制御を除く（改行とタブは残す）", () => {
    const e = cmd({
      command: "a\u001b[31mb\u0000c‮d\nline2\te",
      outputTail: "x\u001b[0m\u0007y⁦z\n",
    });
    expect(e.command).toBe("abcd\nline2\te");
    expect(e.outputTail).toBe("xyz\n");
  });

  it("長いコマンドは先頭と末尾を残して上限に収める。マルチバイトの途中では切らない", () => {
    const long = `START ${"あ".repeat(3000)} END`;
    const e = cmd({ command: long });
    expect(e.command.length).toBeLessThanOrEqual(STRUCTURED_LIMITS.command);
    expect(e.command.startsWith("START ")).toBe(true);
    expect(e.command.endsWith(" END")).toBe(true);
    expect(e.command).toContain("…");
    const emoji = cmd({ command: "😀".repeat(2000) });
    expect(emoji.command.length).toBeLessThanOrEqual(STRUCTURED_LIMITS.command);
    expect(emoji.command).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("出力の末尾は、末尾側を残して上限に収める", () => {
    const e = cmd({ command: "x", outputTail: `HEAD${"y".repeat(5000)}TAIL` });
    expect(e.outputTail?.length).toBeLessThanOrEqual(STRUCTURED_LIMITS.outputTail);
    expect(e.outputTail?.endsWith("TAIL")).toBe(true);
    expect(e.outputTail?.startsWith("HEAD")).toBe(false);
  });

  it("切り詰めの境界にまたがる秘密も漏れない（マスク → 切り詰めの順）", () => {
    const e = cmd({
      command: `${"x".repeat(1990)} ${GHP}`,
      outputTail: `${GHP}${"z".repeat(1990)}`,
    });
    expect(JSON.stringify(e)).not.toContain("ghp_");
  });

  it("exit_code は整数か null（壊れた値・タイムアウトは null）。所要時間は 0 以上の整数だけ", () => {
    expect(cmd({ command: "x", exitCode: null }).exitCode).toBeNull();
    expect(cmd({ command: "x", exitCode: "1" }).exitCode).toBeNull();
    expect(cmd({ command: "x", exitCode: 1.5 }).exitCode).toBeNull();
    expect(cmd({ command: "x", exitCode: 0 }).exitCode).toBe(0);
    expect(cmd({ command: "x", durationMs: -1 })).not.toHaveProperty("durationMs");
    expect(cmd({ command: "x", durationMs: Number.NaN })).not.toHaveProperty("durationMs");
    expect(cmd({ command: "x", durationMs: 12.7 }).durationMs).toBe(12);
  });

  it("cwd は相対パスだけ（不正・ワークスペース自身は付けない）", () => {
    expect(cmd({ command: "x", cwd: "/etc" })).not.toHaveProperty("cwd");
    expect(cmd({ command: "x", cwd: "../x" })).not.toHaveProperty("cwd");
    expect(cmd({ command: "x", cwd: "." })).not.toHaveProperty("cwd");
    expect(cmd({ command: "x", cwd: "a\u0000b" })).not.toHaveProperty("cwd");
    expect(cmd({ command: "x", cwd: "a/b" }).cwd).toBe("a/b");
  });

  it("command が文字列でない・空なら捨てる", () => {
    expect(norm("command", { command: 1 })).toBeUndefined();
    expect(norm("command", { command: "  " })).toBeUndefined();
    expect(norm("command", null)).toBeUndefined();
    expect(norm("command", "x")).toBeUndefined();
  });
});

describe("edit", () => {
  it("path・op・行数だけ。差分の本文は持たない", () => {
    expect(
      norm("edit", {
        path: "src/a.ts",
        op: "modify",
        added: 3,
        removed: 1,
        diff: "+secret body",
        content: "全文",
      }),
    ).toEqual({ type: "edit", path: "src/a.ts", op: "modify", added: 3, removed: 1 });
  });

  it.each([
    ["..", "../etc/passwd"],
    ["途中の ..", "a/../b"],
    ["絶対パス", "/etc/passwd"],
    ["NUL", "a\u0000b"],
    ["制御文字", "a\u001bb"],
    ["改行", "a\nb"],
    ["ワークスペース自身", "."],
    ["空", ""],
    ["長すぎる", `${"d/".repeat(200)}f`],
    ["文字列でない", 5],
  ])("path が %s なら、イベントごと捨てる", (_n, path) => {
    expect(norm("edit", { path, op: "modify", added: 1, removed: 0 })).toBeUndefined();
  });

  it("op が表に無ければ捨てる。行数の壊れた値は 0", () => {
    expect(norm("edit", { path: "a", op: "rewrite", added: 1, removed: 1 })).toBeUndefined();
    expect(norm("edit", { path: "a", op: "create", added: -1, removed: "x" })).toEqual({
      type: "edit",
      path: "a",
      op: "create",
      added: 0,
      removed: 0,
    });
  });

  it("path に秘密が混ざっていても伏せる", () => {
    const e = norm("edit", { path: `notes/${GHP}.txt`, op: "create", added: 1, removed: 0 });
    expect(JSON.stringify(e)).not.toContain(GHP);
  });
});

describe("commit", () => {
  it("メッセージの 1 行目（マスク済み・上限 200）、sha、ファイル数", () => {
    expect(
      norm("commit", { message: `feat: x ${GHP}\n\nbody: ${GHS}`, sha: SHA, files: 2 }),
    ).toEqual({ type: "commit", message: "feat: x [REDACTED]", sha: SHA, files: 2 });
    const long = norm("commit", { message: "あ".repeat(500), sha: SHA, files: 1 }) as Extract<
      StructuredEvent,
      { type: "commit" }
    >;
    expect(long.message.length).toBeLessThanOrEqual(STRUCTURED_LIMITS.commitMessage);
  });

  it("先頭の空行は飛ばし、制御文字は除く", () => {
    const e = norm("commit", {
      message: "\n\n  fix\u0007: y\u001b[1m  \nmore",
      sha: SHA,
      files: 0,
    });
    expect(e).toMatchObject({ message: "fix: y" });
  });

  it("本文の中の秘密は 2 行目以降でも出ない", () => {
    const e = norm("commit", {
      message: `subject\nAuthorization: Bearer ${"abcdef0123456789xyz"}`,
      sha: SHA,
      files: 1,
    });
    expect(JSON.stringify(e)).not.toContain("abcdef0123456789xyz");
  });

  it("sha が 40 桁の小文字 16 進でなければ捨てる", () => {
    expect(norm("commit", { message: "m", sha: "abc", files: 1 })).toBeUndefined();
    expect(norm("commit", { message: "m", sha: SHA.toUpperCase(), files: 1 })).toBeUndefined();
    expect(norm("commit", { message: "", sha: SHA, files: 1 })).toBeUndefined();
  });
});

describe("web", () => {
  it("kind と host だけ", () => {
    expect(
      norm("web", { kind: "fetch", host: "docs.example.com", url: "https://x/y?z=1" }),
    ).toEqual({
      type: "web",
      kind: "fetch",
      host: "docs.example.com",
    });
    expect(norm("web", { kind: "search" })).toEqual({ type: "web", kind: "search" });
  });

  it("host にパス・クエリ・資格・ポート・空白が混ざっていたら host を付けない", () => {
    for (const host of [
      "example.com/path",
      "example.com?q=1",
      "user:pass@example.com",
      "example.com:8080",
      "exa mple.com",
      "https://example.com",
      "",
    ]) {
      expect(norm("web", { kind: "fetch", host }), host).toEqual({ type: "web", kind: "fetch" });
    }
  });

  it("kind が表に無ければ捨てる", () => {
    expect(norm("web", { kind: "crawl", host: "a.com" })).toBeUndefined();
  });

  it("hostOfUrl は URL からホスト名だけを取り出す（パス・クエリ・資格・ポートは捨てる）", () => {
    expect(hostOfUrl("https://User:pw@Docs.Example.com:8443/a/b?q=1#f")).toBe("docs.example.com");
    expect(hostOfUrl("not a url")).toBeUndefined();
    expect(hostOfUrl("http://[::1]/x")).toBeUndefined();
    expect(hostOfUrl(42)).toBeUndefined();
  });
});

describe("未知の型", () => {
  it("捨てる", () => {
    expect(norm("tool_start", { name: "x" })).toBeUndefined();
    expect(norm("diff", { body: "x" })).toBeUndefined();
  });
});
