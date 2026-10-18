import { describe, expect, it } from "vitest";
import { MAX_COMMAND_SECTION_BYTES, parseReceivePackHead } from "../../src/git-pkt";

const Z = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const REF = "refs/heads/agent/task-t1";
const enc = new TextEncoder();

/** pkt-line（長さは 4 桁の 16 進、長さ自身を含む）。 */
function pkt(payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === "string" ? enc.encode(payload) : payload;
  const head = (body.length + 4).toString(16).padStart(4, "0");
  return cat(enc.encode(head), body);
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const FLUSH = enc.encode("0000");
const PACK = enc.encode("PACK\0\0\0\x02rest-of-pack");
const cmd = (o: string, n: string, r: string, caps = "report-status side-band-64k agent=git/2.x") =>
  pkt(`${o} ${n} ${r}\0${caps}`);

describe("parseReceivePackHead: 許可するもの", () => {
  it("コマンド 1 本 + flush を読み、packfile の手前（headEnd）を返す", () => {
    const head = cat(cmd(A, B, REF), FLUSH);
    const r = parseReceivePackHead(cat(head, PACK));
    expect(r).toMatchObject({
      kind: "ok",
      command: { oldSha: A, newSha: B, ref: REF },
      headEnd: head.length,
    });
    if (r.kind === "ok")
      expect(r.capabilities).toEqual(["report-status", "side-band-64k", "agent=git/2.x"]);
  });

  it("ブランチの作成（old が全 0）は許可する", () => {
    expect(parseReceivePackHead(cat(cmd(Z, B, REF), FLUSH, PACK))).toMatchObject({
      kind: "ok",
      command: { oldSha: Z, newSha: B },
    });
  });

  it("capabilities が無い（NUL なし）1 行目も読める。末尾の LF は 1 つだけ落とす", () => {
    expect(parseReceivePackHead(cat(pkt(`${A} ${B} ${REF}`), FLUSH))).toMatchObject({
      kind: "ok",
      command: { ref: REF },
      capabilities: [],
    });
    expect(parseReceivePackHead(cat(pkt(`${A} ${B} ${REF}\n`), FLUSH))).toMatchObject({
      kind: "ok",
      command: { ref: REF },
    });
  });

  it("flush だけで終わる本文（packfile なし）でも headEnd は flush の直後", () => {
    const head = cat(cmd(A, B, REF), FLUSH);
    expect(parseReceivePackHead(head)).toMatchObject({ kind: "ok", headEnd: head.length });
  });

  it("object-format=sha1 は許可する", () => {
    expect(
      parseReceivePackHead(cat(cmd(A, B, REF, "report-status object-format=sha1"), FLUSH)),
    ).toMatchObject({ kind: "ok" });
  });
});

describe("parseReceivePackHead: 続きが必要なもの", () => {
  const full = cat(cmd(A, B, REF), FLUSH);
  it("どの位置で切っても、flush の前なら need_more（途中で ok や reject にならない）", () => {
    for (let i = 0; i < full.length; i++) {
      expect(parseReceivePackHead(full.subarray(0, i)), `len=${i}`).toEqual({ kind: "need_more" });
    }
  });
  it("空の入力は need_more", () => {
    expect(parseReceivePackHead(new Uint8Array(0))).toEqual({ kind: "need_more" });
  });
});

describe("parseReceivePackHead: 拒否するもの", () => {
  const rej = (buf: Uint8Array, code: string) =>
    expect(parseReceivePackHead(buf)).toEqual({ kind: "reject", code });

  it("削除（new が全 0）", () => rej(cat(cmd(A, Z, REF), FLUSH), "delete"));
  it("コマンドが 2 本", () =>
    rej(cat(cmd(A, B, REF), cmd(A, B, "refs/heads/agent/task-t2"), FLUSH), "multiple_commands"));
  it("2 本目の位置にコマンド以外のものがあっても拒否する", () =>
    rej(cat(cmd(A, B, REF), pkt("anything"), FLUSH), "multiple_commands"));
  it("shallow 行（コマンドの前）", () =>
    rej(cat(pkt(`shallow ${A}`), cmd(A, B, REF), FLUSH), "shallow"));
  it("push-cert", () => rej(cat(pkt("push-cert\0report-status"), FLUSH), "push_cert"));
  it("push-options の capability", () =>
    rej(cat(cmd(A, B, REF, "report-status push-options"), FLUSH), "push_options"));
  it("object-format=sha256", () =>
    rej(cat(cmd(A, B, REF, "report-status object-format=sha256"), FLUSH), "object_format"));
  it("sha256 の 64 桁の SHA", () =>
    rej(cat(cmd("a".repeat(64), "b".repeat(64), REF), FLUSH), "bad_command"));
  it("40 桁以外の 16 進（短い・長い・大文字・16 進以外）", () => {
    for (const bad of ["a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40)]) {
      rej(cat(cmd(bad, B, REF), FLUSH), "bad_command");
      rej(cat(cmd(A, bad, REF), FLUSH), "bad_command");
    }
  });
  it("区切りが 1 つの空白でない", () => {
    rej(cat(pkt(`${A}  ${B} ${REF}`), FLUSH), "bad_command");
    rej(cat(pkt(`${A} ${B}\t${REF}`), FLUSH), "bad_command");
    rej(cat(pkt(`${A} ${B}`), FLUSH), "bad_command");
    rej(cat(pkt(""), FLUSH), "bad_command");
  });
  it("不正な ref（refs/heads 以外、.. 、制御文字、空白、末尾 .lock など）", () => {
    for (const ref of [
      "refs/tags/v1",
      "HEAD",
      "refs/heads/",
      "refs/heads/a..b",
      "refs/heads/a b",
      "refs/heads/a\x01b",
      "refs/heads/a~1",
      "refs/heads/a:b",
      "refs/heads/a.lock",
      "refs/heads/a//b",
      "refs/heads/a/",
      "refs/heads/日本語",
      `refs/heads/${"a".repeat(300)}`,
    ]) {
      rej(cat(cmd(A, B, ref), FLUSH), "bad_ref");
    }
  });
  it("コマンド 1 本の後に flush が無く、packfile がそのまま来る", () =>
    rej(cat(cmd(A, B, REF), PACK), "bad_pkt_len"));
  it("先頭が flush（コマンドなし）", () => rej(cat(FLUSH, PACK), "no_command"));
  it("delim-pkt / response-end-pkt / 長さ 3 は拒否する", () => {
    rej(enc.encode("0001"), "bad_pkt_len");
    rej(enc.encode("0002"), "bad_pkt_len");
    rej(enc.encode("0003"), "bad_pkt_len");
  });
  it("長さが 16 進でない・符号付き・空白入り", () => {
    rej(enc.encode("zzzz"), "bad_pkt_len");
    rej(enc.encode("+004"), "bad_pkt_len");
    rej(enc.encode(" 0f0"), "bad_pkt_len");
    rej(enc.encode("PACK"), "bad_pkt_len");
  });
  it("pkt-line の長さが上限（65520）を超える", () => rej(enc.encode("fff1"), "bad_pkt_len"));
  it("コマンド部が上限を超えても flush が来なければ拒否する", () => {
    const big = pkt(`${A} ${B} ${REF}\0${"x".repeat(2000)}`);
    expect(parseReceivePackHead(big, { maxBytes: 1024 })).toEqual({
      kind: "reject",
      code: "head_too_large",
    });
    expect(parseReceivePackHead(new Uint8Array(2048), { maxBytes: 1024 })).toMatchObject({
      kind: "reject",
    });
    // flush まで届いていても、コマンド部が上限を超えていれば拒否する
    expect(parseReceivePackHead(cat(big, FLUSH), { maxBytes: 1024 })).toEqual({
      kind: "reject",
      code: "head_too_large",
    });
    expect(MAX_COMMAND_SECTION_BYTES).toBe(64 * 1024);
  });
  it("NUL が ref の途中にあれば、その後ろは capabilities として扱う（ref は NUL までで切る）", () => {
    const r = parseReceivePackHead(cat(pkt(`${A} ${B} ${REF}\0refs/heads/other`), FLUSH));
    expect(r).toMatchObject({
      kind: "ok",
      command: { ref: REF },
      capabilities: ["refs/heads/other"],
    });
  });
});
