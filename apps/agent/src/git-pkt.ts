/**
 * git-receive-pack（protocol v0）のリクエスト本文の先頭（コマンド部）を解析する純粋関数。
 * OutboundGateway が、upstream への転送を始める前に「何を push しようとしているか」を検証するために使う。
 *
 * 本文の形: `pkt(old SP new SP ref NUL caps)` flush(`0000`) [packfile]
 * 1 本のコマンドだけを許可し、それ以外（複数コマンド・shallow・push-cert・push-options・sha256 など）は拒否する。
 */

/** コマンド部（flush まで）の大きさの上限。これを超えたら flush を待たずに拒否する。 */
export const MAX_COMMAND_SECTION_BYTES = 64 * 1024;
/** pkt-line 1 個の最大長（長さの 4 バイトを含む）。git の LARGE_PACKET_MAX と同じ。 */
const MAX_PKT_LEN = 65520;

export interface ReceivePackCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

export type ReceivePackHead =
  /** flush までまだ届いていない。続きを読んでからもう一度呼ぶ。 */
  | { kind: "need_more" }
  /** code は固定の識別子（ログ用。入力を含まない） */
  | { kind: "reject"; code: string }
  /** headEnd は flush の直後のオフセット（以降が packfile）。 */
  | { kind: "ok"; command: ReceivePackCommand; capabilities: string[]; headEnd: number };

const reject = (code: string): ReceivePackHead => ({ kind: "reject", code });
const SHA1 = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);
const HEX4 = /^[0-9a-fA-F]{4}$/;
const REF_RE = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** ref として安全な形か（git の check-ref-format の主な規則を、ASCII の範囲でさらに絞ったもの）。 */
export function isSafeBranchRef(ref: string): boolean {
  if (ref.length > 200 || !REF_RE.test(ref)) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("/.")) return false;
  if (ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) return false;
  return true;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

type PktRead =
  | { kind: "need_more" }
  | { kind: "reject"; code: string }
  | { kind: "flush"; next: number }
  | { kind: "data"; payload: Uint8Array; next: number };

function readPkt(buf: Uint8Array, pos: number): PktRead {
  if (buf.length - pos < 4) return { kind: "need_more" };
  const head = latin1(buf.subarray(pos, pos + 4));
  if (!HEX4.test(head)) return { kind: "reject", code: "bad_pkt_len" };
  const len = Number.parseInt(head, 16);
  if (len === 0) return { kind: "flush", next: pos + 4 };
  // 1: delim-pkt、2: response-end-pkt、3: 中身のない長さ。receive-pack のリクエストには現れない
  if (len < 4 || len > MAX_PKT_LEN) return { kind: "reject", code: "bad_pkt_len" };
  if (buf.length - pos < len) return { kind: "need_more" };
  return { kind: "data", payload: buf.subarray(pos + 4, pos + len), next: pos + len };
}

function parseCommand(
  payload: Uint8Array,
): ReceivePackHead | { command: ReceivePackCommand; capabilities: string[] } {
  let line = latin1(payload);
  // git は pkt-line の末尾の LF を 1 つ落として読む（PACKET_READ_CHOMP_NEWLINE）。同じ解釈にそろえる
  if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line.startsWith("shallow ")) return reject("shallow");
  if (line.startsWith("push-cert")) return reject("push_cert");
  const nul = line.indexOf("\0");
  const head = nul < 0 ? line : line.slice(0, nul);
  const capabilities =
    nul < 0
      ? []
      : line
          .slice(nul + 1)
          .split(" ")
          .filter(Boolean);
  const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/s.exec(head);
  if (!m) return reject("bad_command");
  const [, oldSha, newSha, ref] = m as unknown as [string, string, string, string];
  if (!SHA1.test(oldSha) || !SHA1.test(newSha)) return reject("bad_command");
  if (newSha === ZERO) return reject("delete");
  if (!isSafeBranchRef(ref)) return reject("bad_ref");
  for (const cap of capabilities) {
    if (cap === "push-options" || cap.startsWith("push-options=")) return reject("push_options");
    if (cap.startsWith("object-format=") && cap !== "object-format=sha1")
      return reject("object_format");
  }
  return { command: { oldSha, newSha, ref }, capabilities };
}

/**
 * buf（本文の先頭から現在までに読んだ分）を解析する。続きが必要なら need_more を返す。
 * 呼び出し側は、ok が返るまで upstream へ何も送ってはいけない。
 */
export function parseReceivePackHead(
  buf: Uint8Array,
  opts: { maxBytes?: number } = {},
): ReceivePackHead {
  const max = opts.maxBytes ?? MAX_COMMAND_SECTION_BYTES;
  const first = readPkt(buf, 0);
  if (first.kind === "need_more") return buf.length > max ? reject("head_too_large") : first;
  if (first.kind === "reject") return reject(first.code);
  if (first.kind === "flush") return reject("no_command");
  const parsed = parseCommand(first.payload);
  if ("kind" in parsed) return parsed;
  const second = readPkt(buf, first.next);
  if (second.kind === "need_more") return buf.length > max ? reject("head_too_large") : second;
  if (second.kind === "reject") return reject(second.code);
  if (second.kind === "data") return reject("multiple_commands");
  if (second.next > max) return reject("head_too_large");
  return { kind: "ok", ...parsed, headEnd: second.next };
}
