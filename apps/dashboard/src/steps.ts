import type {
  TaskDetailDto,
  TaskEventDto,
  TaskStatusDto,
  VisibleTaskDto,
} from "@rovo/dashboard-contract";
import { formatDuration, singleLine } from "./format";
import type { T } from "./i18n";

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

/** 状態の変化の手順の色（文言は辞書の status.<状態>） */
const STATUS_TONE: Record<TaskStatusDto, Tone> = {
  CREATING: "normal",
  RUNNING: "normal",
  INPUT_REQUIRED: "normal",
  VERIFYING: "normal",
  RECOVERING: "normal",
  COMPLETED: "normal",
  FAILED: "fail",
  BUDGET_EXCEEDED: "fail",
  CANCELLED: "normal",
};

const join = (t: T, parts: (string | false | null | undefined)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p !== "").join(t("common.sep"));

/** 子のツール名 → 辞書の文言（tool.<名前>.done / running）。keys は summary（JSON）から取り出してよいキー（先に見つかったものを使う） */
const TOOL_KEYS = {
  bash: ["command"],
  read_file: ["path"],
  list_files: ["path"],
  search: ["pattern", "query"],
  write_file: ["path"],
  edit_file: ["path"],
  git_commit: ["message"],
  web_search: ["query"],
  web_fetch: ["url"],
  web_browse: ["url"],
} as const satisfies Record<string, readonly string[]>;
type ToolName = keyof typeof TOOL_KEYS;
const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_KEYS, name);

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

function describeToolStart(name: string, summary: string, current: boolean, t: T): StepText {
  if (name === "report_completion") {
    return { what: t("step.reportCompletion"), target: "", note: "", tone: "normal" };
  }
  if (!isToolName(name)) {
    return {
      what: t(current ? "tool.other.running" : "tool.other.done", { name: singleLine(name) }),
      target: singleLine(summary),
      note: "",
      tone: "normal",
    };
  }
  const what = t(current ? `tool.${name}.running` : `tool.${name}.done`);
  const target = pickTarget(summary, TOOL_KEYS[name]);
  if (name === "bash") return commandText(target, { what, note: "", tone: "normal" });
  return { what, target, note: "", tone: "normal" };
}

/**
 * イベント 1 件を、人の言葉の動詞にする。進み具合に出さないイベント（usage）は null。
 * `current` はそのイベントが「いまの手順」か（実行中のコマンドは「実行中」と言える）。
 */
export function describeEvent(ev: TaskEventDto, opts: { current: boolean }, t: T): StepText | null {
  switch (ev.type) {
    case "command": {
      const failed = ev.exit_code !== null && ev.exit_code !== 0;
      const running = ev.exit_code === null && opts.current;
      return commandText(singleLine(ev.command), {
        what: failed
          ? t("step.commandFailed")
          : running
            ? t("tool.bash.running")
            : t("tool.bash.done"),
        note: join(t, [
          failed && t("step.exitCode", { code: String(ev.exit_code) }),
          ev.exit_code === null && !opts.current && t("step.exitUnknown"),
          ev.duration_ms !== undefined && formatDuration(ev.duration_ms, t),
        ]),
        tone: failed ? "fail" : "normal",
      });
    }
    case "edit": {
      const what = t(`step.edit.${ev.op}`);
      return {
        what,
        target: singleLine(ev.path),
        note: join(t, [
          ev.added > 0 && t("step.linesAdded", { n: ev.added }),
          ev.removed > 0 && t("step.linesRemoved", { n: ev.removed }),
        ]),
        tone: "normal",
      };
    }
    case "commit":
      return {
        what: t("tool.git_commit.done"),
        target: singleLine(ev.message),
        note: join(t, [t("step.files", { n: ev.files }), ev.sha.slice(0, 7)]),
        tone: "normal",
      };
    case "web":
      return {
        what: t(`step.web.${ev.kind}`),
        target: ev.host === undefined ? "" : singleLine(ev.host),
        note: "",
        tone: "normal",
      };
    case "status_changed": {
      return {
        what: t(`status.${ev.to}`),
        target: "",
        note: ev.reason === undefined ? "" : t("step.reason", { reason: singleLine(ev.reason) }),
        tone: STATUS_TONE[ev.to],
      };
    }
    case "draft_pr_created":
      return { what: t("step.draftPr"), target: `#${ev.pr_number}`, note: "", tone: "normal" };
    case "tool_start":
      return describeToolStart(ev.name, ev.summary, opts.current, t);
    case "tool_end":
      // 成功は出さない（構造化イベント・次の手順で分かる）。失敗のときだけ出す
      return ev.is_error
        ? { what: t("step.toolFailed"), target: singleLine(ev.summary), note: "", tone: "fail" }
        : null;
    case "agent_event":
      return {
        what: t("step.other"),
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
export function buildSteps(events: readonly TaskEventDto[], active: boolean, t: T): Step[] {
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
    const d = describeEvent(e, { current }, t);
    const command = e.type === "command" || (e.type === "tool_start" && e.name === "bash");
    if (d) steps.push({ ...d, seq: e.seq, at: Date.parse(e.at), current, command });
  }
  return steps;
}

/** 所要。open は終わっていない（今までの経過。画面は「6 秒…」のように末尾に … を付ける） */
export type StepTiming = { ms: number; open: boolean };
export type PhaseTiming = StepTiming;

/**
 * ステップの所要。次のステップの時刻との差（負は 0）。実行中（いま）の最後のステップだけ、更新時刻（generatedAt）までの経過で open。
 * 終わったタスクの最後のステップは、次が無いので所要を作らない（データに無いものは作らない）。generatedAt が読めないときも作らない。
 */
export function stepTimings(
  steps: readonly Step[],
  generatedAt: number,
): (StepTiming | undefined)[] {
  return steps.map((step, i) => {
    const next = steps[i + 1];
    if (next !== undefined) return { ms: Math.max(0, next.at - step.at), open: false };
    if (step.current && Number.isFinite(generatedAt)) {
      return { ms: Math.max(0, generatedAt - step.at), open: true };
    }
    return undefined;
  });
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatusDto> = new Set([
  "COMPLETED",
  "FAILED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
]);

/**
 * 段階（準備・実行・検証）の所要。status_changed の時刻だけから出す:
 * 準備 = 最初の CREATING から、実行 = 最初の RUNNING から、検証 = 最初の VERIFYING から、
 * 次の段階の始まり（または終端）まで。始まりの記録が無い段階（古い履歴を読んでいない・旧い記録）と、
 * 終わりの記録が無くて今も続いていない段階には、所要を作らない。今の段階（now・waiting・recovering）は更新時刻までの経過で open。
 * 完了の段階には所要が無い。events は seq の昇順。
 */
export function phaseTimings(
  events: readonly TaskEventDto[],
  band: readonly BandStep[],
  generatedAt: number,
): Partial<Record<BandKey, PhaseTiming>> {
  const firstAt = (match: (to: TaskStatusDto) => boolean): number | undefined => {
    for (const e of events) {
      if (e.type === "status_changed" && match(e.to)) {
        const t = Date.parse(e.at);
        return Number.isFinite(t) ? t : undefined;
      }
    }
    return undefined;
  };
  const starts: [Exclude<BandKey, "done">, number | undefined][] = [
    ["prepare", firstAt((to) => to === "CREATING")],
    ["run", firstAt((to) => to === "RUNNING")],
    ["verify", firstAt((to) => to === "VERIFYING")],
  ];
  const terminalAt = firstAt((to) => TERMINAL_STATUSES.has(to));
  const out: Partial<Record<BandKey, PhaseTiming>> = {};
  starts.forEach(([key, start], i) => {
    if (start === undefined) return;
    const ends = [...starts.slice(i + 1).map(([, t]) => t), terminalAt].filter(
      (t): t is number => t !== undefined && t >= start,
    );
    if (ends.length > 0) {
      out[key] = { ms: Math.min(...ends) - start, open: false };
      return;
    }
    const state = band.find((b) => b.key === key)?.state;
    const going = state === "now" || state === "waiting" || state === "recovering";
    if (going && Number.isFinite(generatedAt)) {
      out[key] = { ms: Math.max(0, generatedAt - start), open: true };
    }
  });
  return out;
}

export type BandKey = "prepare" | "run" | "verify" | "done";
export type BandState = "done" | "now" | "waiting" | "recovering" | "todo" | "stopped";
export type BandStep = { key: BandKey; name: string; state: BandState; label: string };

const BAND_KEYS: readonly BandKey[] = ["prepare", "run", "verify", "done"];

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
  t: T,
  reached: ReadonlySet<TaskStatusDto> = new Set(),
  stopped?: TaskDetailDto["stopped_phase"],
): BandStep[] {
  const BAND = BAND_KEYS.map((key) => ({ key, name: t(`band.${key}`) }));
  const LABEL = (s: Exclude<BandState, "stopped">) => t(`band.state.${s}`);
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
      return BAND.map((b) => ({ ...b, state: "done", label: LABEL("done") }));
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
  const stopLabel =
    task.status === "FAILED" || task.status === "BUDGET_EXCEEDED" || task.status === "CANCELLED"
      ? t(`band.stopped.${task.status}`)
      : t("band.state.stopped");
  return BAND.map((b, i) => {
    if (i < at) return { ...b, state: "done", label: LABEL("done") };
    if (i > at) return { ...b, state: "todo", label: LABEL("todo") };
    return { ...b, state, label: state === "stopped" ? stopLabel : LABEL(state) };
  });
}

export type NowSentence = { before: string; prompt?: string; target: string; after: string };

/** 「いまは X を…しています」の文の種類 → 辞書のキー（場所なし・場所あり）。 */
const NOW_KEY = {
  command: ["now.command", "now.commandIn"],
  edit: ["now.edit", "now.editIn"],
  commit: ["now.commit", "now.commitIn"],
  web: ["now.web", "now.webIn"],
  tool: ["now.tool", "now.toolIn"],
} as const;

/** 文の型の {target} の前後に分ける（target は強調するので文字列に混ぜない） */
const TARGET_MARK = "{target}";
function splitAtTarget(sentence: string): { before: string; after: string } {
  const i = sentence.indexOf(TARGET_MARK);
  return i < 0
    ? { before: sentence, after: "" }
    : { before: sentence.slice(0, i), after: sentence.slice(i + TARGET_MARK.length) };
}

/** gateway が添える「<相対パス> で 」（now.text の先頭。gateway の固定の書式で、言語によらない）。素直なパス 1 つだけ */
const NOW_WHERE = /^([\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)*) で (\S.*)$/u;

/**
 * 「いまは X を実行しています。」。X（target）だけ強調できるように 3 つに分ける。now が null なら状態に応じた文。
 * コマンド（command・tool）は、タイムラインと同じ見せ方にする: `cd /workspace/<相対パス> && ` や `cd <相対パス> && ` の前置きを外し、
 * 場所を「いまは <相対パス> で $ コマンド を実行しています。」と添える（gateway が添えた「<相対パス> で 」も読む）。
 */
export function nowSentence(now: TaskDetailDto["now"], status: TaskStatusDto, t: T): NowSentence {
  if (now === null) return { before: t(`now.state.${status}`), target: "", after: "" };
  if (now.kind === "waiting") {
    // gateway が固定で返す text。予算の延長の承認待ちには一言添える（入力待ちの一種）
    const before =
      now.text === "waiting for budget approval" ? t("now.waitingBudget") : t("now.waiting");
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
  const key = NOW_KEY[now.kind][where === undefined ? 0 : 1];
  const { before, after } = splitAtTarget(t(key, { target: TARGET_MARK, where: where ?? "" }));
  return prompt ? { before, prompt: "$ ", target: text, after } : { before, target: text, after };
}
