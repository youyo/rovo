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
  note: string;
  tone: Tone;
};

export type Step = StepText & {
  seq: number;
  /** UTC のエポック ms */
  at: number;
  /** いま実行している手順（実行中のタスクの最後の手順） */
  current: boolean;
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

/**
 * イベント 1 件を、人の言葉の動詞にする。進み具合に出さないイベント（usage）は null。
 * `current` はそのイベントが「いまの手順」か（実行中のコマンドは「実行中」と言える）。
 */
export function describeEvent(ev: TaskEventDto, opts: { current: boolean }): StepText | null {
  switch (ev.type) {
    case "command": {
      const failed = ev.exit_code !== null && ev.exit_code !== 0;
      const running = ev.exit_code === null && opts.current;
      return {
        what: failed ? "コマンドが失敗した" : running ? "コマンドを実行中" : "コマンドを実行した",
        target: singleLine(ev.command),
        note: join([
          failed && `終了コード ${ev.exit_code}`,
          ev.exit_code === null && !opts.current && "終了コード不明",
          ev.duration_ms !== undefined && formatDuration(ev.duration_ms),
        ]),
        tone: failed ? "fail" : "normal",
      };
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
      return {
        what: `${singleLine(ev.name)} を${opts.current ? "実行中" : "実行した"}`,
        target: singleLine(ev.summary),
        note: "",
        tone: "normal",
      };
    case "tool_end":
      return {
        what: ev.is_error ? "ツールが失敗した" : "ツールが終わった",
        target: singleLine(ev.summary),
        note: "",
        tone: ev.is_error ? "fail" : "normal",
      };
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

/** 進み具合の一覧（時系列）。実行中のタスクは、進み具合に出る最後の手順が「いま」。 */
export function buildSteps(events: readonly TaskEventDto[], active: boolean): Step[] {
  const shown = events.filter((e) => e.type !== "usage");
  const lastSeq = shown.at(-1)?.seq;
  const steps: Step[] = [];
  for (const e of shown) {
    const current = active && e.seq === lastSeq;
    const d = describeEvent(e, { current });
    if (d) steps.push({ ...d, seq: e.seq, at: Date.parse(e.at), current });
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
 * 終端で phase が done のときは、検証に入った記録（reached）があれば検証、無ければ実行（開始前なら準備）で止まったとみる。
 */
export function phaseBand(
  task: VisibleTaskDto,
  phase: TaskDetailDto["phase"],
  reached: ReadonlySet<TaskStatusDto> = new Set(),
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
      if (task.failure_phase === "setup") at = 0;
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

export type NowSentence = { before: string; target: string; after: string };

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

/** 「いまは X を実行しています。」。X（target）だけ強調できるように 3 つに分ける。now が null なら状態に応じた文。 */
export function nowSentence(now: TaskDetailDto["now"], status: TaskStatusDto): NowSentence {
  if (now === null) return { before: STATE_SENTENCE[status], target: "", after: "" };
  if (now.kind === "waiting") return { before: "入力を待っています。", target: "", after: "" };
  return { before: "いまは ", target: singleLine(now.text), after: NOW_AFTER[now.kind] };
}
