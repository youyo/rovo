import type {
  TaskDetailDto,
  TaskEventDto,
  TaskStatusDto,
  VisibleTaskDto,
} from "@rovo/dashboard-contract";
import { formatDuration, singleLine } from "./format";

/**
 * 詳細の画面の純関数: イベント → 人の言葉の動詞、イベントのマージ、段階の帯、「いまは X」の文。
 * 表示する文字列は、ここで必ず `singleLine`（制御文字・双方向文字を除いて 1 行にする）を通す（D14）。
 * React に依存しない。
 */

export type Tone = "normal" | "fail";

export type StepText = {
  what: string;
  target: string;
  /** コマンドを実行した場所（`cd /workspace/<相対パス> && ` や `cd <相対パス> && ` の前置きの <相対パス>）。画面では「<相対パス> で」と添える */
  where?: string;
  note: string;
  tone: Tone;
};

export type Step = StepText & {
  seq: number;
  /** UTC のエポック ms */
  at: number;
  /** いま実行している手順（実行中のタスクの最後の手順） */
  current: boolean;
  /** コマンドの手順か（画面では `$ コマンド` の行にする。古い履歴の bash の tool_start も含む） */
  command: boolean;
};

const STATUS_VERB: Record<TaskStatusDto, { what: string; tone: Tone }> = {
  CREATING: { what: "準備を始めた", tone: "normal" },
  RUNNING: { what: "実行を始めた", tone: "normal" },
  INPUT_REQUIRED: { what: "入力を待っている", tone: "normal" },
  VERIFYING: { what: "検証を始めた", tone: "normal" },
  RECOVERING: { what: "復旧している", tone: "normal" },
  COMPLETED: { what: "完了した", tone: "normal" },
  FAILED: { what: "失敗した", tone: "fail" },
  BUDGET_EXCEEDED: { what: "予算を超えた", tone: "fail" },
  CANCELLED: { what: "キャンセルされた", tone: "normal" },
};

const join = (parts: (string | false | null | undefined)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p !== "").join("、");

type ToolSpec = { done: string; running: string; keys: readonly string[] };

/** 子のツール名 → 人の言葉。keys は summary（JSON）から取り出してよいキー（先に見つかったものを使う） */
const TOOL_TEXT: Record<string, ToolSpec> = {
  bash: { done: "コマンドを実行した", running: "コマンドを実行中", keys: ["command"] },
  read_file: { done: "ファイルを読んだ", running: "ファイルを読んでいる", keys: ["path"] },
  list_files: { done: "一覧を見た", running: "一覧を見ている", keys: ["path"] },
  search: { done: "検索した", running: "検索している", keys: ["pattern", "query"] },
  write_file: { done: "ファイルを書いた", running: "ファイルを書いている", keys: ["path"] },
  edit_file: { done: "ファイルを編集した", running: "ファイルを編集している", keys: ["path"] },
  git_commit: { done: "コミットした", running: "コミットしている", keys: ["message"] },
  web_search: { done: "検索した", running: "検索している", keys: ["query"] },
  web_fetch: { done: "ページを読んだ", running: "ページを読んでいる", keys: ["url"] },
  web_browse: { done: "ページを開いた", running: "ページを開いている", keys: ["url"] },
};

/** 構造化イベント（command / edit / commit / web）を別に出すツール → その型 */
const STRUCTURED_OF: Record<string, TaskEventDto["type"]> = {
  bash: "command",
  write_file: "edit",
  edit_file: "edit",
  git_commit: "commit",
  web_search: "web",
  web_fetch: "web",
  web_browse: "web",
};

const MARK = "…";

/** 先頭が `{"<キー>":"` で始まる（文字列の値の手前まで）。キーは JSON のエスケープを含まないものだけ */
const STRING_HEAD = /^\s*\{\s*"([^"\\]*)"\s*:\s*"/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX_PART = /^[0-9a-fA-F]*$/;
const SIMPLE_ESCAPE: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * JSON の文字列の中身（開き " の次から）を読み、エスケープを戻す。閉じる " が無ければ、途中で切れている（cut）。
 * 切れているときは、切り詰めの印（agent の "..."・gateway の "…"）を外し、末尾の中途半端なエスケープ
 * （\ や \u12）と、対の片方だけのサロゲートは捨てる。エスケープが壊れていれば undefined。
 */
function readJsonString(body: string): { value: string; cut: boolean } | undefined {
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") i++;
    else if (c === '"') {
      end = i;
      break;
    }
  }
  const cut = end < 0;
  const raw = cut ? body.replace(/(?:\.\.\.|…)$/, "") : body.slice(0, end);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = raw[i + 1];
    if (n === undefined) break; // 切れた位置が \ の直後
    if (n === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4) {
        if (cut && HEX_PART.test(hex)) break; // 切れた位置が \uXX の途中
        return undefined;
      }
      if (!HEX4.test(hex)) return undefined;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 5;
      continue;
    }
    const e = SIMPLE_ESCAPE[n];
    if (e === undefined) return undefined;
    out += e;
    i++;
  }
  return { value: cut ? out.replace(/[\uD800-\uDBFF]$/, "") : out, cut };
}

/**
 * summary から、既知のキーの文字列の値を取り出して、表示できる 1 行（sanitize 済み。切れていれば末尾に …）にする。
 * JSON として読めるときはオブジェクトの既知のキー。読めない（切れた）ときは、先頭が `{"<既知のキー>":"` のときだけ、
 * その文字列を取り出す。取り出せなければ undefined。
 */
function pickString(summary: string, keys: readonly string[]): string | undefined {
  try {
    const v: unknown = JSON.parse(summary);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      for (const k of keys) {
        const x = (v as Record<string, unknown>)[k];
        if (typeof x === "string" && x !== "") return singleLine(x);
      }
    }
    return undefined;
  } catch {
    // 切れた JSON かもしれない
  }
  const head = STRING_HEAD.exec(summary);
  if (head === null || !keys.includes(head[1] as string)) return undefined;
  const read = readJsonString(summary.slice(head[0].length));
  if (read === undefined || read.value === "") return undefined;
  return `${singleLine(read.value)}${read.cut ? MARK : ""}`;
}

/**
 * summary は子が書いた非信頼データ。既知のキーの文字列を取り出せるときだけ取り出す（切れた JSON も）。
 * それ以外（配列・数値・未知のキー・文字列でない値・壊れたエスケープ）は、sanitize した文字列のまま。
 */
function pickTarget(summary: string, keys: readonly string[]): string {
  return pickString(summary, keys) ?? singleLine(summary);
}

/** 場所の 1 区切りに許す文字（素直なディレクトリ名だけ。空白・引用符・変数・シェルの記号は許さない） */
const DIR_SEGMENT = /^[\p{L}\p{N}_.@+-]+$/u;
const CD_PREFIX = /^cd\s+(\S+)\s+&&\s+(\S.*)$/;
const WORKSPACE = "/workspace";

/**
 * cd の行き先を /workspace からの相対パスにする。/workspace 自身・`.`・`./` は ""。
 * `/workspace/...` の絶対パスと、`/` `~` `-` `$` で始まらない相対パス（/workspace からの相対として読む。先頭の `./` は 1 つだけ外す）を読む。
 * 素直なパスでない（.. や // を含む・変な文字がある・/workspace の外・~ や $HOME や - など）ものは undefined
 */
function relativeDir(path: string): string | undefined {
  let rest: string;
  if (path === WORKSPACE || path.startsWith(`${WORKSPACE}/`)) {
    rest = path.slice(WORKSPACE.length + 1);
  } else if (/^[/~$-]/.test(path)) {
    return undefined;
  } else if (path === ".") {
    return "";
  } else {
    rest = path.startsWith("./") ? path.slice(2) : path;
  }
  if (rest === "") return "";
  const parts = rest.split("/");
  if (parts.at(-1) === "") parts.pop();
  for (const p of parts) {
    if (p === "." || p === ".." || !DIR_SEGMENT.test(p)) return undefined;
  }
  return parts.join("/");
}

/**
 * コマンドの先頭の `cd /workspace/<相対パス> && ` と `cd <相対パス> && `（/workspace からの相対。`./` 付きも）を外し、
 * <相対パス> を場所として返す。`cd /workspace && ` と `cd . && ` は前置きだけ外す（場所なし）。
 * ほかの形（.. を含む・/workspace の外・~ や $HOME や - ・引用符つきなど）は触らない。
 * text は sanitize 済みの 1 行。
 */
function splitCommand(text: string): { command: string; where?: string } {
  const m = CD_PREFIX.exec(text);
  if (m === null) return { command: text };
  const dir = relativeDir(m[1] as string);
  if (dir === undefined) return { command: text };
  const command = m[2] as string;
  return dir === "" ? { command } : { command, where: dir };
}

/** コマンドの手順の文。前置きを外し、場所があれば添える（タイムライン・「いま」・gateway で同じ見せ方） */
function commandText(text: string, base: { what: string; note: string; tone: Tone }): StepText {
  const c = splitCommand(text);
  return {
    what: base.what,
    target: c.command,
    ...(c.where === undefined ? {} : { where: c.where }),
    note: base.note,
    tone: base.tone,
  };
}

function describeToolStart(name: string, summary: string, current: boolean): StepText {
  if (name === "report_completion") {
    return { what: "完了を報告した", target: "", note: "", tone: "normal" };
  }
  const spec = TOOL_TEXT[name];
  if (spec === undefined) {
    return {
      what: `${singleLine(name)} を${current ? "実行中" : "実行した"}`,
      target: singleLine(summary),
      note: "",
      tone: "normal",
    };
  }
  const what = current ? spec.running : spec.done;
  const target = pickTarget(summary, spec.keys);
  if (name === "bash") return commandText(target, { what, note: "", tone: "normal" });
  return { what, target, note: "", tone: "normal" };
}

/**
 * イベント 1 件を、人の言葉の動詞にする。進み具合に出さないイベント（usage）は null。
 * `current` はそのイベントが「いまの手順」か（実行中のコマンドは「実行中」と言える）。
 */
export function describeEvent(ev: TaskEventDto, opts: { current: boolean }): StepText | null {
  switch (ev.type) {
    case "command": {
      const failed = ev.exit_code !== null && ev.exit_code !== 0;
      const running = ev.exit_code === null && opts.current;
      return commandText(singleLine(ev.command), {
        what: failed ? "コマンドが失敗した" : running ? "コマンドを実行中" : "コマンドを実行した",
        note: join([
          failed && `終了コード ${ev.exit_code}`,
          ev.exit_code === null && !opts.current && "終了コード不明",
          ev.duration_ms !== undefined && formatDuration(ev.duration_ms),
        ]),
        tone: failed ? "fail" : "normal",
      });
    }
    case "edit": {
      const what = {
        create: "ファイルを作った",
        modify: "ファイルを編集した",
        delete: "ファイルを消した",
      }[ev.op];
      return {
        what,
        target: singleLine(ev.path),
        note: join([
          ev.added > 0 && `${ev.added} 行追加`,
          ev.removed > 0 && `${ev.removed} 行削除`,
        ]),
        tone: "normal",
      };
    }
    case "commit":
      return {
        what: "コミットした",
        target: singleLine(ev.message),
        note: join([`${ev.files} ファイル`, ev.sha.slice(0, 7)]),
        tone: "normal",
      };
    case "web":
      return {
        what: { search: "検索した", fetch: "ページを読んだ", browse: "ページを開いた" }[ev.kind],
        target: ev.host === undefined ? "" : singleLine(ev.host),
        note: "",
        tone: "normal",
      };
    case "status_changed": {
      const v = STATUS_VERB[ev.to];
      return {
        what: v.what,
        target: "",
        note: ev.reason === undefined ? "" : `理由 ${singleLine(ev.reason)}`,
        tone: v.tone,
      };
    }
    case "draft_pr_created":
      return { what: "Draft PR を作った", target: `#${ev.pr_number}`, note: "", tone: "normal" };
    case "tool_start":
      return describeToolStart(ev.name, ev.summary, opts.current);
    case "tool_end":
      // 成功は出さない（構造化イベント・次の手順で分かる）。失敗のときだけ出す
      return ev.is_error
        ? { what: "失敗した", target: singleLine(ev.summary), note: "", tone: "fail" }
        : null;
    case "agent_event":
      return {
        what: "その他の処理",
        target: singleLine(ev.agent_type),
        note: "",
        tone: "normal",
      };
    case "usage":
      return null;
  }
}

/** seq で重複を排除して昇順にそろえる。同じ seq は後から来た方で置き換える。元の配列は変えない。 */
export function mergeEvents(prev: readonly TaskEventDto[], incoming: readonly TaskEventDto[]) {
  const bySeq = new Map<number, TaskEventDto>();
  for (const e of prev) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * 構造化イベントで置き換わる tool_start の call_id を返す。
 * tool_start から、その tool_end（まだ無ければ末尾）までの間に、そのツールの型の構造化イベントが
 * 来ていれば、その call は構造化イベントが表す（1 つの構造化イベントは 1 つの call にしか対応しない）。
 * events は seq の昇順。
 */
function pairedCalls(events: readonly TaskEventDto[]): Set<string> {
  const endAt = new Map<string, number>();
  for (const e of events) if (e.type === "tool_end") endAt.set(e.call_id, e.seq);
  const claimed = new Set<number>();
  const paired = new Set<string>();
  for (const s of events) {
    if (s.type !== "tool_start") continue;
    const want = STRUCTURED_OF[s.name];
    if (want === undefined) continue;
    const until = endAt.get(s.call_id) ?? Number.POSITIVE_INFINITY;
    const hit = events.find(
      (e) => e.type === want && e.seq > s.seq && e.seq < until && !claimed.has(e.seq),
    );
    if (hit) {
      claimed.add(hit.seq);
      paired.add(s.call_id);
    }
  }
  return paired;
}

/**
 * 進み具合の一覧（時系列）。実行中のタスクは、進み具合に出る最後の手順が「いま」。
 * 構造化イベントを出すツールの tool_start / tool_end は、構造化イベントがあれば出さない（1 つの操作を 1 行にする）。
 * 構造化イベントがまだ来ていない実行中の tool_start は「実行中」の 1 行で、来たら置き換わる。
 * 構造化イベントが無い古い履歴は、tool_start を人の言葉にして出す（成功の tool_end は出さない）。
 */
export function buildSteps(events: readonly TaskEventDto[], active: boolean): Step[] {
  const paired = pairedCalls(events);
  const shown = events.filter(
    (e) =>
      e.type !== "usage" &&
      !((e.type === "tool_start" || e.type === "tool_end") && paired.has(e.call_id)),
  );
  const lastSeq = shown.at(-1)?.seq;
  const steps: Step[] = [];
  for (const e of shown) {
    const current = active && e.seq === lastSeq;
    const d = describeEvent(e, { current });
    const command = e.type === "command" || (e.type === "tool_start" && e.name === "bash");
    if (d) steps.push({ ...d, seq: e.seq, at: Date.parse(e.at), current, command });
  }
  return steps;
}

export type BandKey = "prepare" | "run" | "verify" | "done";
export type BandState = "done" | "now" | "waiting" | "recovering" | "todo" | "stopped";
export type BandStep = { key: BandKey; name: string; state: BandState; label: string };

const BAND: { key: BandKey; name: string }[] = [
  { key: "prepare", name: "準備" },
  { key: "run", name: "実行" },
  { key: "verify", name: "検証" },
  { key: "done", name: "完了" },
];

const STOP_LABEL: Partial<Record<TaskStatusDto, string>> = {
  FAILED: "失敗",
  BUDGET_EXCEEDED: "予算超過",
  CANCELLED: "キャンセル",
};

const LABEL: Record<Exclude<BandState, "stopped">, string> = {
  done: "済み",
  now: "いま",
  waiting: "入力待ち",
  recovering: "復旧中",
  todo: "これから",
};

/**
 * 準備 → 実行 → 検証 → 完了の帯。状態から決める:
 * CREATING→準備、RUNNING→実行、VERIFYING→検証、INPUT_REQUIRED→実行で入力待ち、RECOVERING→実行で復旧中、
 * COMPLETED→すべて済み、失敗・予算超過・キャンセル→止まった段（failure_phase が setup なら準備）。
 * 止まった段は gateway の stopped_phase を使う。無いとき（旧い gateway）だけ、終端で phase が done なら
 * 検証に入った記録（reached）があれば検証、無ければ実行（開始前なら準備）で止まったとみる。
 */
export function phaseBand(
  task: VisibleTaskDto,
  phase: TaskDetailDto["phase"],
  reached: ReadonlySet<TaskStatusDto> = new Set(),
  stopped?: TaskDetailDto["stopped_phase"],
): BandStep[] {
  const indexOf = (p: TaskDetailDto["phase"]) => BAND.findIndex((b) => b.key === p);
  let at: number;
  let state: BandState = "now";
  switch (task.status) {
    case "CREATING":
      at = 0;
      break;
    case "RUNNING":
      at = 1;
      break;
    case "VERIFYING":
      at = 2;
      break;
    case "INPUT_REQUIRED":
      at = 1;
      state = "waiting";
      break;
    case "RECOVERING":
      at = 1;
      state = "recovering";
      break;
    case "COMPLETED":
      return BAND.map((b) => ({ ...b, state: "done", label: LABEL.done }));
    case "FAILED":
    case "BUDGET_EXCEEDED":
    case "CANCELLED":
      state = "stopped";
      if (stopped !== undefined && stopped !== null)
        at = { prepare: 0, run: 1, verify: 2 }[stopped];
      else if (task.failure_phase === "setup") at = 0;
      else if (phase !== "done") at = indexOf(phase);
      else if (reached.has("VERIFYING")) at = 2;
      else at = task.started_at === null ? 0 : 1;
      break;
  }
  const stopLabel = STOP_LABEL[task.status] ?? "止まった";
  return BAND.map((b, i) => {
    if (i < at) return { ...b, state: "done", label: LABEL.done };
    if (i > at) return { ...b, state: "todo", label: LABEL.todo };
    return { ...b, state, label: state === "stopped" ? stopLabel : LABEL[state] };
  });
}

export type NowSentence = { before: string; prompt?: string; target: string; after: string };

const NOW_AFTER = {
  command: " を実行しています。",
  edit: " を編集しています。",
  commit: " をコミットしています。",
  web: " を調べています。",
  tool: " を実行しています。",
} as const;

const STATE_SENTENCE: Record<TaskStatusDto, string> = {
  CREATING: "リポジトリと実行環境を準備しています。",
  RUNNING: "作業を進めています。",
  INPUT_REQUIRED: "入力を待っています。",
  VERIFYING: "検証コマンドを実行しています。",
  RECOVERING: "実行環境を復旧しています。",
  COMPLETED: "完了しました。",
  FAILED: "失敗しました。",
  BUDGET_EXCEEDED: "予算を超えたため止まりました。",
  CANCELLED: "キャンセルされました。",
};

/** gateway が添える「<相対パス> で 」（now.text の先頭）。素直なパス 1 つだけ */
const NOW_WHERE = /^([\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)*) で (\S.*)$/u;

/**
 * 「いまは X を実行しています。」。X（target）だけ強調できるように 3 つに分ける。now が null なら状態に応じた文。
 * コマンド（command・tool）は、タイムラインと同じ見せ方にする: `cd /workspace/<相対パス> && ` や `cd <相対パス> && ` の前置きを外し、
 * 場所を「いまは <相対パス> で $ コマンド を実行しています。」と添える（gateway が添えた「<相対パス> で 」も読む）。
 */
export function nowSentence(now: TaskDetailDto["now"], status: TaskStatusDto): NowSentence {
  if (now === null) return { before: STATE_SENTENCE[status], target: "", after: "" };
  if (now.kind === "waiting") {
    // gateway が固定で返す text。予算の延長の承認待ちには一言添える（入力待ちの一種）
    const before =
      now.text === "waiting for budget approval"
        ? "予算の承認を待っています（入力待ち）。"
        : "入力を待っています。";
    return { before, target: "", after: "" };
  }
  let text = singleLine(now.text);
  let where: string | undefined;
  if (now.kind === "command" || now.kind === "tool") {
    const w = NOW_WHERE.exec(text);
    if (w !== null) {
      where = w[1];
      text = w[2] as string;
    }
  }
  // 「$ コマンド」はコンソールと同じ見た目（プロンプトだけ別の色）にするため、プロンプトを分けて返す
  const prompt = text.startsWith("$ ");
  if (prompt) text = text.slice(2);
  if (where === undefined && (prompt || now.kind === "command")) {
    const c = splitCommand(text);
    text = c.command;
    where = c.where;
  }
  const before = where === undefined ? "いまは " : `いまは ${where} で `;
  const after = NOW_AFTER[now.kind];
  return prompt ? { before, prompt: "$ ", target: text, after } : { before, target: text, after };
}
