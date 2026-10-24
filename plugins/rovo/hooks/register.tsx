import type { EngineInterface, McpToolResult, Register, Timer } from "claude-code";
import { atom, read, update } from "claude-code";

import type { RovoConsole, RovoTask } from "../types";
import type { Awaiting, LaneState, LogLine, ParsedConsole, PrLink, TaskKind } from "./lib";
import {
  appendLines,
  budgetToastText,
  CONSOLE_RETRY_MS,
  cleanTitle,
  coerceLogs,
  coerceTasks,
  displayWidth,
  formatElapsed,
  headingText,
  httpsOnly,
  isTerminal,
  isWaiting,
  labelRow,
  laneCells,
  laneColumns,
  logStyle,
  MAX_LOG_PAGES,
  matchRovoTool,
  matchTaskStart,
  mergeListed,
  padWidth,
  parseConsole,
  parseStartResult,
  parseStatus,
  parseTaskList,
  pruneTasks,
  repoName,
  rightText,
  STATIONS,
  STORED_LOG_LINES,
  shortModel,
  shortText,
  slideShift,
  stageIndex,
  statusColor,
  tailLines,
  taskKey,
  toastText,
  truncateWidth,
} from "./lib";

type Dollar = EngineInterface;

const PANE_ID = "rovo";
const POLL_MS = 4000;
const STORE_KEY = "tasks";
const LOGS_KEY = "logs";

// 読み取り専用: 呼ぶ MCP ツールはこの 3 つだけ（task_start は model が呼んだ結果を見るだけ）。
const TOOL_CONSOLE = "task_console";
const TOOL_STATUS = "task_status";
const TOOL_LIST = "task_list";
const ENDPOINTS_KEY = "endpoints";
const MAX_ENDPOINTS = 4;
// 流れ（▶・スピナー・点滅）の描き直し。動いているワーカーがいる間だけ回す。
const ANIM_MS = 700;
// 着いた直後の ◉ を出しておくフレーム数。
const ARRIVE_FRAMES = 3;
// task_list を取り直す間隔。動いているワーカーがいなければゆっくり。
const LIST_IDLE_MS = 20_000;
// 1 回の tick で task_console を取るワーカーの上限（選んでいるものを先頭に、残りは順番に回す）。
const MAX_CONSOLE_POLLS = 6;

const tasksAtom = atom({ plugin: "rovo", key: "tasks" } as const, []);
const consolesAtom = atom({ plugin: "rovo", key: "consoles" } as const, {});
const frameAtom = atom({ plugin: "rovo", key: "frame" } as const, 0);
const arrivalsAtom = atom({ plugin: "rovo", key: "arrivals" } as const, {});
const listsAtom = atom({ plugin: "rovo", key: "lists" } as const, {});
const endpointsAtom = atom({ plugin: "rovo", key: "endpoints" } as const, []);
// 積み上がるログ（ワーカーごと）と、log_after を受け付けなかった接続先。
const logsAtom = atom({ plugin: "rovo", key: "logs" } as const, {});
const logOffAtom = atom({ plugin: "rovo", key: "logOff" } as const, {});
const selectedAtom = atom({ plugin: "rovo", key: "selected" } as const, null);
// 出力の窓。follow が true の間は末尾に追従する。offset は追従を止めたときの先頭行（出力の中の行番号）。
const scrollAtom = atom({ plugin: "rovo", key: "scroll" } as const, { follow: true, offset: 0 });
// 直近に出していたタスク。ボタン以外（自動の切り替え・一覧から消えた）で変わったら追従に戻す。
const shownAtom = atom({ plugin: "rovo", key: "shown" } as const, null);
// /rovo:create-task が実行された時刻。タスクを拾うまで「タスクを作成中…」を出す。
const creatingAtom = atom({ plugin: "rovo", key: "creating" } as const, null);
const CREATING_MS = 10 * 60 * 1000;
const CREATE_COMMAND = "create-task";
const OPEN_COMMAND = "open-console";
const CLOSE_COMMAND = "close-console";
// 名前空間なし（create-task）と rovo: 付き（rovo:create-task）だけを同じ名前として扱う。旧名は拾わない。
const baseName = (command: string): string =>
  command.startsWith("rovo:") ? command.slice(5) : command;

// 自分のコマンド（名前空間なし・rovo: 付き）。baseName と同じ範囲。
const OWN_COMMANDS = /^(?:rovo:)?(?:create-task|open-console|close-console)$/;

// 一覧に出すワーカーの最大数（ペインが狭いことがある）。選んでいるワーカーは必ず入れる。
const LIST_MAX = 4;
// 一覧以外の行（見出し・「他 n 件」・題名・リンク・枠・コマンド）と、出力の窓の最低の行数。
const FIXED_ROWS = 7;
const MIN_WINDOW = 3;
const LANE_ROWS = 3;
// 1 行目の列の幅の上限（題名は残りを使う）。
const REPO_MAX = 16;
const MODEL_MAX = 14;
const ELAPSED_MAX = 12;

const endpointKey = (e: { server: string; prefix: string }): string => `${e.server}/${e.prefix}`;

const textOf = (result: McpToolResult): string =>
  result.content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");

let timer: Timer | null = null;
let animTimer: Timer | null = null;
let isPolling = false;
let pollCursor = 0;

/** ペインを開く。描かれたか（isPlaced）を返す。開けなくても追跡は続ける。 */
const openPane = async ($: Dollar): Promise<boolean> => {
  try {
    return (await $.ui.open({ id: PANE_ID, title: "rovo" })).isPlaced;
  } catch {
    return false;
  }
};

/** 出すタスク: 選択中 → 最新の実行中 → 最新。 */
const pickSelected = (
  tasks: readonly RovoTask[],
  selectedKey: string | null,
): RovoTask | undefined =>
  tasks.find((t) => taskKey(t) === selectedKey) ??
  [...tasks].reverse().find((t) => !isTerminal(t.status)) ??
  tasks[tasks.length - 1];

/** いまペインに出しているタスクの taskKey（無ければ null）。 */
const shownKeyNow = async ($: Dollar): Promise<string | null> => {
  const now = await $.clock.now();
  const visible = (await read($, tasksAtom)).filter(
    (t) => t.terminalAt === undefined || now - t.terminalAt < 60 * 60 * 1000,
  );
  const picked = pickSelected(visible, await read($, selectedAtom));
  return picked === undefined ? null : taskKey(picked);
};

/** 出しているタスクが変わっていたら、窓を追従に戻す（ボタンで選んだときは押した側が shown も更新する）。 */
const syncShown = async ($: Dollar, tasks: readonly RovoTask[]): Promise<void> => {
  const now = await $.clock.now();
  const visible = tasks.filter(
    (t) => t.terminalAt === undefined || now - t.terminalAt < 60 * 60 * 1000,
  );
  const picked = pickSelected(visible, await read($, selectedAtom));
  const key = picked === undefined ? null : taskKey(picked);
  if (key === (await read($, shownAtom))) return;
  await update($, shownAtom, () => key);
  await update($, scrollAtom, () => ({ follow: true, offset: 0 }));
};

const showStatus = (tasks: readonly RovoTask[], $: Dollar): void => {
  const running = tasks.filter((t) => !isTerminal(t.status)).length;
  $.ui.status(running > 0 ? `${running} 件実行中` : undefined);
};

/** 追跡リストを書き換える。古いものを落とし、$.store に残し、ステータスラインを直す。 */
const mutate = async ($: Dollar, change: (list: RovoTask[]) => RovoTask[]): Promise<RovoTask[]> => {
  const now = await $.clock.now();
  let before: RovoTask[] = [];
  const after = await update($, tasksAtom, (list) => {
    before = list;
    return pruneTasks(change(list), now);
  });
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await $.store.set(STORE_KEY, after);
  }
  showStatus(after, $);
  await syncShown($, after);
  return after;
};

/** task_list を取り直す必要があるか: 取れている接続先が 1 つでもある。 */
const hasListSupport = async ($: Dollar): Promise<boolean> =>
  Object.values(await read($, listsAtom)).some((l) => l.supported);

const stopIfIdle = async ($: Dollar): Promise<void> => {
  const list = await read($, tasksAtom);
  const active = list.some((t) => !isTerminal(t.status));
  if (timer !== null && !active && !(await hasListSupport($))) {
    timer.cancel();
    timer = null;
  }
  if (animTimer !== null && !active) {
    animTimer.cancel();
    animTimer = null;
  }
};

/** task_console 自体が無いサーバーのエラー（引数を変えても直らない）。 */
const UNKNOWN_TOOL = /unknown tool|no such tool|tool not found|method not found/i;

const callConsole = async (
  $: Dollar,
  t: RovoTask,
  args: Record<string, unknown>,
): Promise<{ parsed: ParsedConsole | null; toolMissing: boolean }> => {
  try {
    const res = await $.mcp.call(t.server, t.prefix + TOOL_CONSOLE, args);
    if (res.isError) return { parsed: null, toolMissing: UNKNOWN_TOOL.test(textOf(res)) };
    return { parsed: parseConsole(textOf(res)), toolMissing: false };
  } catch {
    return { parsed: null, toolMissing: false };
  }
};

/** ログを取り込んだ結果。logSeen はこのサーバーが log を返したこと。 */
type LogOutcome = { seen: boolean; added: LogLine[]; cursor: string; rejected: boolean };

/** 取り込んだログを buffer に足す。古い行が落ちたぶんだけ、追従を止めている窓も前へ寄せる。 */
const applyLog = async (
  $: Dollar,
  key: string,
  outcome: LogOutcome | null,
  parsedOk: boolean,
): Promise<void> => {
  const cur = (await read($, logsAtom))[key];
  if (outcome === null) return;
  if (!outcome.seen) {
    // log を返さない（古いサーバー・受け付けなかった・取得に失敗）: 無ければ印だけ作り、あれば触らない。
    // 取れたのに log が無いときは、前に積んだログがあっても最新のコマンドだけの表示に戻す。
    if (cur === undefined || (parsedOk && cur.supported)) {
      await update($, logsAtom, (m) => ({
        ...m,
        [key]: { supported: false, cursor: cur?.cursor ?? "0", lines: cur?.lines ?? [] },
      }));
    }
    return;
  }
  const { lines, dropped } = appendLines(cur?.lines ?? [], outcome.added);
  await update($, logsAtom, (m) => ({
    ...m,
    [key]: { supported: true, cursor: outcome.cursor, lines },
  }));
  if (dropped > 0 && (await shownKeyNow($)) === key) {
    await update($, scrollAtom, (s) =>
      s.follow ? s : { ...s, offset: Math.max(0, s.offset - dropped) },
    );
  }
  await persistLogs($);
};

/** ログを $.store に小さく残す（追跡中のワーカーの、最後の STORED_LOG_LINES 行とカーソル）。 */
const persistLogs = async ($: Dollar): Promise<void> => {
  const keys = new Set((await read($, tasksAtom)).map(taskKey));
  let kept: Record<string, { cursor: string; lines: LogLine[] }> = {};
  await update($, logsAtom, (m) => {
    const next: typeof m = {};
    kept = {};
    for (const [k, v] of Object.entries(m)) {
      if (!keys.has(k)) continue;
      next[k] = v;
      if (v.supported) kept[k] = { cursor: v.cursor, lines: v.lines.slice(-STORED_LOG_LINES) };
    }
    return Object.keys(next).length === Object.keys(m).length ? m : next;
  });
  await $.store.set(LOGS_KEY, kept);
};

const pollOne = async ($: Dollar, t: RovoTask): Promise<void> => {
  let parsed: ParsedConsole | null = null;
  const startedAt = await $.clock.now();
  // task_console が使えないタスクも、60 秒に 1 回は試し直す（同時 1 本は tick の isPolling が守る）。
  const isRetry = t.noConsole === true && startedAt >= (t.consoleRetryAt ?? 0);
  let isConsoleMissing = t.noConsole === true && !isRetry;
  const key = taskKey(t);
  const epKey = endpointKey(t);
  // ログ（log_after）を頼むのは、ペインに出しているワーカーだけ。受け付けなかったサーバーは 1 分あきらめる。
  const wantLog =
    !isConsoleMissing &&
    (await shownKeyNow($)) === key &&
    startedAt >= ((await read($, logOffAtom))[epKey] ?? 0);
  let outcome: LogOutcome | null = null;
  if (!isConsoleMissing) {
    if (!wantLog) {
      parsed = (await callConsole($, t, { task_id: t.taskId })).parsed;
    } else {
      outcome = {
        seen: false,
        added: [],
        cursor: (await read($, logsAtom))[key]?.cursor ?? "0",
        rejected: false,
      };
      for (let page = 0; page < MAX_LOG_PAGES; page++) {
        const { parsed: p, toolMissing } = await callConsole($, t, {
          task_id: t.taskId,
          log_after: outcome.cursor,
        });
        if (p === null) {
          if (page === 0 && !toolMissing) {
            // log_after を受け付けないサーバーかもしれない: 付けずにもう一度。
            parsed = (await callConsole($, t, { task_id: t.taskId })).parsed;
            outcome.rejected = parsed !== null;
          }
          break;
        }
        parsed = p;
        if (p.log === undefined) break;
        outcome.seen = true;
        outcome.added.push(...p.log.lines);
        const advanced = p.log.nextCursor !== outcome.cursor;
        outcome.cursor = p.log.nextCursor;
        if (!p.log.truncated || !advanced) break;
      }
      if (outcome.rejected) {
        await update($, logOffAtom, (m) => ({ ...m, [epKey]: startedAt + CONSOLE_RETRY_MS }));
      }
    }
    if (parsed === null) isConsoleMissing = true;
  }
  await applyLog($, key, outcome, parsed !== null);

  let status: string;
  let dashboardUrl: string | undefined;
  let pr: PrLink | undefined;
  let awaiting: Awaiting | undefined;
  let view: Omit<RovoConsole, "fetchedAt">;
  if (parsed !== null) {
    status = parsed.status;
    dashboardUrl = parsed.dashboardUrl;
    pr = parsed.pr;
    awaiting = parsed.awaiting;
    view = {
      phase: parsed.phase,
      stoppedPhase: parsed.stoppedPhase,
      nowText: parsed.nowText,
      command: parsed.command,
      ...(parsed.nowWhere !== undefined ? { nowWhere: parsed.nowWhere } : {}),
      ...(parsed.commandWhere !== undefined ? { commandWhere: parsed.commandWhere } : {}),
      tail: parsed.tail,
      isRunning: parsed.isRunning,
      hasOutput: true,
      ...(pr !== undefined ? { pr } : {}),
    };
  } else {
    let one: { status: string; dashboardUrl?: string; pr?: PrLink; awaiting?: Awaiting } | null =
      null;
    try {
      const res = await $.mcp.call(t.server, t.prefix + TOOL_STATUS, { task_id: t.taskId });
      one = res.isError ? null : parseStatus(textOf(res));
    } catch {
      one = null;
    }
    if (one === null) return;
    status = one.status;
    dashboardUrl = one.dashboardUrl;
    pr = one.pr;
    awaiting = one.awaiting;
    view = {
      phase: null,
      stoppedPhase: null,
      nowText: null,
      command: null,
      tail: null,
      isRunning: false,
      hasOutput: false,
      ...(pr !== undefined ? { pr } : {}),
    };
  }

  const now = await $.clock.now();
  const becameTerminal = !isTerminal(t.status) && isTerminal(status);
  const shouldToast = becameTerminal && t.notified !== true;
  const shouldToastBudget = awaiting !== undefined && t.awaiting === undefined;
  await mutate($, (list) =>
    list.map((x) =>
      taskKey(x) !== key
        ? x
        : {
            ...x,
            status,
            awaiting,
            ...(isConsoleMissing
              ? {
                  noConsole: true as const,
                  consoleRetryAt:
                    isRetry || t.noConsole !== true ? now + CONSOLE_RETRY_MS : t.consoleRetryAt,
                }
              : { noConsole: undefined, consoleRetryAt: undefined }),
            ...(x.dashboardUrl === undefined && dashboardUrl !== undefined ? { dashboardUrl } : {}),
            ...(becameTerminal ? { terminalAt: now, notified: true as const } : {}),
          },
    ),
  );
  // 追従を止めて読んでいる間は、末尾が前へずれた分だけ窓も前へ寄せ、同じ行を見せ続ける。
  const old = (await read($, consolesAtom))[key];
  if (outcome?.seen !== true && old?.tail != null && view.tail !== null) {
    const shift = slideShift(tailLines(old.tail).split("\n"), tailLines(view.tail).split("\n"));
    const stand = await read($, scrollAtom);
    if (shift > 0 && !stand.follow) {
      const shownTask = (await buildModel($, 30)).selected;
      if (shownTask !== undefined && taskKey(shownTask) === key) {
        await update($, scrollAtom, (s) => ({ ...s, offset: Math.max(0, s.offset - shift) }));
      }
    }
  }
  await update($, consolesAtom, (map) => ({ ...map, [key]: { ...view, fetchedAt: now } }));
  if (shouldToast) $.ui.toast(toastText(t.title, status));
  if (shouldToastBudget) $.ui.toast(budgetToastText(t.title));
};

/**
 * 呼んだ人の全タスク（task_list）を取って追跡リストに混ぜる。task_list が無いサーバー
 * （エラー・形が違う）は 1 分間あきらめ、その間は task_start で拾ったものだけで動く。
 * 呼び出し側が isPolling を握っていること。
 */
const syncLists = async ($: Dollar): Promise<void> => {
  const endpoints = await read($, endpointsAtom);
  for (const ep of endpoints) {
    const key = endpointKey(ep);
    const now = await $.clock.now();
    const state = (await read($, listsAtom))[key];
    if (state !== undefined) {
      if (!state.supported && now < state.retryAt) continue;
      const active = (await read($, tasksAtom)).some((t) => !isTerminal(t.status));
      if (state.supported && now - state.lastAt < (active ? POLL_MS - 500 : LIST_IDLE_MS)) continue;
    }
    let parsed: ReturnType<typeof parseTaskList> = null;
    try {
      const res = await $.mcp.call(ep.server, ep.prefix + TOOL_LIST, {
        scope: "recent",
        limit: 50,
      });
      parsed = res.isError ? null : parseTaskList(textOf(res));
    } catch {
      parsed = null;
    }
    const at = await $.clock.now();
    if (parsed === null) {
      await update($, listsAtom, (m) => ({
        ...m,
        [key]: { supported: false, retryAt: at + CONSOLE_RETRY_MS, lastAt: at },
      }));
      continue;
    }
    await update($, listsAtom, (m) => ({
      ...m,
      [key]: { supported: true, retryAt: 0, lastAt: at },
    }));
    const listed = parsed.tasks;
    const merged = await mutate($, (list) => mergeListed(list, listed, ep, at));
    await ensureTimer($);
    // 終端に変わったワーカーを知らせる（初めから終わっていたものは notified 済みで、ここに来ない）。
    const toAnnounce = merged.filter((t) => isTerminal(t.status) && t.notified !== true);
    if (toAnnounce.length > 0) {
      const keys = new Set(toAnnounce.map(taskKey));
      await mutate($, (list) =>
        list.map((x) => (keys.has(taskKey(x)) ? { ...x, notified: true as const } : x)),
      );
      for (const t of toAnnounce) $.ui.toast(toastText(t.title, t.status));
    }
  }
};

/** 今回 task_console を取るワーカー: 選んでいるものを先頭に、残りは順番に回して上限まで。並びは一覧のまま。 */
const chooseToPoll = async ($: Dollar, running: RovoTask[]): Promise<RovoTask[]> => {
  if (running.length <= MAX_CONSOLE_POLLS) return running;
  const selected = pickSelected(running, await read($, selectedAtom));
  const others = running.filter((t) => t !== selected);
  const room = MAX_CONSOLE_POLLS - (selected === undefined ? 0 : 1);
  const start = pollCursor % others.length;
  pollCursor += room;
  const rotated = [...others.slice(start), ...others.slice(0, start)].slice(0, room);
  const chosen = new Set<RovoTask>(selected === undefined ? rotated : [selected, ...rotated]);
  return running.filter((t) => chosen.has(t));
};

/** 前の呼び出しが終わるまで次を出さない。1 回の中でも 1 本ずつ。 */
const tick = async ($: Dollar): Promise<void> => {
  if (isPolling) return;
  isPolling = true;
  try {
    try {
      await syncLists($);
    } catch {
      // task_list がだめでも、task_console は取る。
    }
    await mutate($, (list) => list);
    const running = (await read($, tasksAtom)).filter((t) => !isTerminal(t.status));
    for (const t of await chooseToPoll($, running)) await pollOne($, t);
    await fetchMissingNow($, undefined, true);
  } catch {
    // 次の周期でやり直す。
  } finally {
    isPolling = false;
  }
  try {
    await stopIfIdle($);
  } catch {
    // タイマーが残るだけ。次の周期で止まる。
  }
};

/**
 * consolesAtom に中身が無い終端のタスクを 1 回ずつ取る（取れたら二度と取らない）。
 * pollOne をそのまま使う。task_list から入ったものは数が多いので、いま出しているもの
 * （か only で指したもの）だけ。失敗しても他の表示には触れない。呼び出し側が isPolling を握っていること。
 */
const fetchMissingNow = async ($: Dollar, only?: string, listedOnly = false): Promise<void> => {
  const tasks = await read($, tasksAtom);
  const now = await $.clock.now();
  const visible = tasks.filter(
    (t) => t.terminalAt === undefined || now - t.terminalAt < 60 * 60 * 1000,
  );
  const picked = pickSelected(visible, await read($, selectedAtom));
  const pickedKey = picked === undefined ? null : taskKey(picked);
  for (const t of tasks) {
    const key = taskKey(t);
    if (only !== undefined && key !== only) continue;
    if (only === undefined && t.listed === true && key !== pickedKey) continue;
    // タイマーの周期では、task_start で拾った終端のタスクは取り直さない（開いたときだけ）。
    if (listedOnly && t.listed !== true) continue;
    // 実行中のタスクはタイマーが取る。
    if (!isTerminal(t.status)) continue;
    // 中身がある終端のタスクは取り直さない。ただし出しているものは、ログをまだ頼んでいなければ 1 回頼む。
    const needsLog =
      key === pickedKey &&
      (await read($, logsAtom))[key] === undefined &&
      now >= ((await read($, logOffAtom))[endpointKey(t)] ?? 0);
    if ((await read($, consolesAtom))[key] !== undefined && !needsLog) continue;
    try {
      await pollOne($, t);
    } catch {
      // このタスクは今回あきらめる。次の機会にやり直す。
    }
  }
};

const fetchMissing = async ($: Dollar, only?: string): Promise<void> => {
  if (isPolling) return;
  isPolling = true;
  try {
    await fetchMissingNow($, only);
  } catch {
    // 読めなければ何もしない。
  } finally {
    isPolling = false;
  }
  try {
    await stopIfIdle($);
  } catch {
    // タイマーが残るだけ。
  }
};

/** task_list を取り直し、中身の無い終端のワーカーを 1 回取る。開いたとき・始まったときに使う。 */
const refresh = async ($: Dollar): Promise<void> => {
  if (isPolling) return;
  isPolling = true;
  try {
    await syncLists($);
    await fetchMissingNow($);
  } catch {
    // 次の機会にやり直す。
  } finally {
    isPolling = false;
  }
  try {
    await stopIfIdle($);
  } catch {
    // タイマーが残るだけ。
  }
};

/** いまの駅の番号と状態。list の stage を先に、無ければ task_console の phase を読む。 */
const laneOf = (
  t: RovoTask,
  view: RovoConsole | undefined,
): { kind: TaskKind; at: number | null; state: LaneState } => {
  const kind = t.kind ?? "task";
  const n = STATIONS[kind].length;
  const own = stageIndex(kind, t.stage);
  const seen = view?.hasOutput === true ? stageIndex(kind, view.phase) : null;
  const stopped = view?.hasOutput === true ? stageIndex(kind, view.stoppedPhase) : null;
  if (t.status === "COMPLETED") return { kind, at: n, state: "done" };
  if (isTerminal(t.status)) return { kind, at: stopped ?? own ?? seen, state: "failed" };
  return { kind, at: own ?? seen, state: isWaiting(t) ? "waiting" : "active" };
};

/** 描き直しを 1 つ進める。駅が変わったワーカーを覚え（着いた直後の ◉ のため）、動くものがなければ止める。 */
const advanceFrame = async ($: Dollar): Promise<void> => {
  const frame = await update($, frameAtom, (n) => n + 1);
  const tasks = await read($, tasksAtom);
  const consoles = await read($, consolesAtom);
  await update($, arrivalsAtom, (old) => {
    const next: Record<string, { at: number; since: number }> = {};
    for (const t of tasks) {
      if (isTerminal(t.status)) continue;
      const key = taskKey(t);
      const at = laneOf(t, consoles[key]).at ?? -1;
      const prev = old[key];
      next[key] =
        prev === undefined ? { at, since: -99 } : prev.at === at ? prev : { at, since: frame };
    }
    return JSON.stringify(next) === JSON.stringify(old) ? old : next;
  });
  if (!tasks.some((t) => !isTerminal(t.status))) {
    animTimer?.cancel();
    animTimer = null;
  }
};

const ensureTimer = async ($: Dollar): Promise<void> => {
  const list = await read($, tasksAtom);
  const active = list.some((t) => !isTerminal(t.status));
  if (timer === null && (active || (await hasListSupport($)))) {
    timer = $.clock.every(POLL_MS, () => {
      void tick($);
    });
  }
  if (animTimer === null && active) {
    animTimer = $.clock.every(ANIM_MS, () => {
      void advanceFrame($).catch(() => undefined);
    });
  }
};

/** $.store から読んだ接続先を、形を確かめて作り直す。 */
const coerceEndpoints = (value: unknown): { server: string; prefix: string }[] => {
  if (!Array.isArray(value)) return [];
  const out: { server: string; prefix: string }[] = [];
  for (const raw of value) {
    const e = raw as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null) continue;
    if (typeof e.server !== "string" || e.server === "" || typeof e.prefix !== "string") continue;
    if (!/^(?:[A-Za-z0-9-]+_)*$/.test(e.prefix)) continue;
    out.push({ server: e.server, prefix: e.prefix });
  }
  return out.slice(0, MAX_ENDPOINTS);
};

/** rovo のツールを呼んだ接続先を覚える（task_list を呼ぶ先）。新しい接続先なら true。 */
const rememberEndpoint = async (
  $: Dollar,
  ep: { server: string; prefix: string },
): Promise<boolean> => {
  const known = await read($, endpointsAtom);
  if (known.some((k) => endpointKey(k) === endpointKey(ep))) return false;
  const next = [...known, ep].slice(-MAX_ENDPOINTS);
  await update($, endpointsAtom, () => next);
  await $.store.set(ENDPOINTS_KEY, next);
  return true;
};

const track = async (
  $: Dollar,
  hit: { server: string; prefix: string },
  started: { taskId: string; status?: string; dashboardUrl?: string; model?: string },
  title: unknown,
  input: { repository?: unknown; model?: unknown } = {},
): Promise<void> => {
  const now = await $.clock.now();
  const status = started.status ?? "RUNNING";
  // task_list が答える前でも、1 行目にリポジトリとモデルを出せるよう、task_start の入力と応答から取る。
  const repository = shortText(input.repository, 100);
  const model = started.model ?? shortText(input.model, 60);
  const added: RovoTask = {
    taskId: started.taskId,
    title: cleanTitle(title, started.taskId),
    server: hit.server,
    prefix: hit.prefix,
    startedAt: now,
    status,
    ...(started.dashboardUrl !== undefined ? { dashboardUrl: started.dashboardUrl } : {}),
    ...(repository !== undefined ? { repository } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(isTerminal(status) ? { terminalAt: now, notified: true as const } : {}),
  };
  const isNew = !(await read($, tasksAtom)).some((x) => taskKey(x) === taskKey(added));
  await mutate($, (list) => [...list.filter((x) => taskKey(x) !== taskKey(added)), added]);
  await update($, creatingAtom, () => null);
  if (isNew) {
    // 新しいタスクを拾うたびに開く。狭い端末では待ちになるので、トーストで知らせる。
    const isPlaced = await openPane($);
    if (!isPlaced) $.ui.toast("rovo のタスクを始めました。/rovo:open-console で開けます");
  }
};

/** ヘッダー・出力の窓の寸法。描画と ui.scroll の両方が同じ計算を使う。 */
type PaneModel = {
  tasks: RovoTask[];
  selected: RovoTask | undefined;
  view: RovoConsole | undefined;
  now: number;
  /** 一覧に出すワーカー（新しい順）と、出さなかった件数。 */
  listed: RovoTask[];
  hidden: number;
  link: string | undefined;
  prLink: RovoConsole["pr"];
  /** ヘッダーの行数（枠の外）。 */
  headerRows: number;
  /** 出力の全行（ログがあればログ + いま流れている出力、無ければ末尾 TAIL_LINES まで）と、窓の高さ（枠の行を除く）・先頭行の範囲。 */
  lines: LogLine[];
  /** ログ（積み上がる表示）か。false なら最新のコマンドだけ（`$ コマンド` を枠の先頭に固定）。 */
  stacked: boolean;
  /** 枠の行数（上下の辺と、固定する `$ コマンド`）。枠の高さは frameRows + windowRows。 */
  frameRows: number;
  windowRows: number;
  maxStart: number;
  /** タスクを作成中（10 分以内）。true の間は案内だけを描き、一覧・詳細は出さない。 */
  creating: boolean;
};

const CREATING_ROWS = 2;

const buildModel = async ($: Dollar, bodyRows: number): Promise<PaneModel> => {
  const now = await $.clock.now();
  const creatingAt = await read($, creatingAtom);
  if (creatingAt !== null && now - creatingAt < CREATING_MS) {
    return {
      tasks: [],
      selected: undefined,
      view: undefined,
      now,
      listed: [],
      hidden: 0,
      link: undefined,
      prLink: undefined,
      headerRows: CREATING_ROWS,
      lines: [],
      stacked: false,
      frameRows: 0,
      windowRows: Math.max(1, bodyRows - CREATING_ROWS),
      maxStart: 0,
      creating: true,
    };
  }
  const all = await read($, tasksAtom);
  const tasks = all.filter(
    (t) => t.terminalAt === undefined || now - t.terminalAt < 60 * 60 * 1000,
  );
  const consoles = await read($, consolesAtom);
  const selectedKey = await read($, selectedAtom);
  const selected = pickSelected(tasks, selectedKey);
  const view = selected === undefined ? undefined : consoles[taskKey(selected)];
  const link = selected === undefined ? undefined : httpsOnly(selected.dashboardUrl);
  const prCandidate = view?.pr ?? selected?.pr;
  const prLink =
    prCandidate !== undefined && httpsOnly(prCandidate.url) !== undefined ? prCandidate : undefined;

  // 行が足りないときは、出すワーカーを減らして出力の窓を残す。
  const room = Math.floor((bodyRows - FIXED_ROWS - MIN_WINDOW) / LANE_ROWS);
  const workerMax = Math.max(1, Math.min(LIST_MAX, room));
  const newest = [...tasks].reverse();
  let listed = newest.slice(0, workerMax);
  if (selected !== undefined && !listed.includes(selected)) {
    listed = [...newest.slice(0, workerMax - 1), selected];
  }
  const hidden = newest.length - listed.length;

  // 数える行: 見出し + ワーカー 3 行ずつ + 「他 n 件」 + 題名 + (取得前・非対応の一言) + リンク
  let headerRows = 1 + listed.length * LANE_ROWS + (hidden > 0 ? 1 : 0);
  if (selected !== undefined) {
    headerRows += 1;
    if (view === undefined || !view.hasOutput) headerRows += 1;
    if (link !== undefined || prLink !== undefined) headerRows += 1;
  }
  const worker = selected === undefined ? undefined : (await read($, logsAtom))[taskKey(selected)];
  const stacked = view !== undefined && view.hasOutput && worker?.supported === true;
  const tailOf = (): LogLine[] =>
    view !== undefined && view.hasOutput && view.tail !== null
      ? tailLines(view.tail)
          .split("\n")
          .map((text) => ({ kind: "out" as const, text }))
      : [];
  let lines: LogLine[];
  if (stacked && view !== undefined) {
    // ログの末尾に、いま流れている出力を続ける（終わったコマンドは entries のほうにある）。
    const live: LogLine[] = [];
    if (view.isRunning) {
      if (view.command !== null) {
        live.push({
          kind: "cmd",
          text: `$ ${view.command}`,
          ...(view.commandWhere !== undefined ? { where: view.commandWhere } : {}),
        });
      }
      live.push(...tailOf());
    }
    lines = [...(worker?.lines ?? []), ...live];
  } else {
    lines = tailOf();
  }
  // 出力は枠で囲む: 上下の辺で 2 行。ログでなければ `$ コマンド` を枠の中の 1 行目に固定して 1 行。
  const frameRows =
    view !== undefined && view.hasOutput ? 2 + (!stacked && view.command !== null ? 1 : 0) : 0;
  const windowRows = Math.max(1, bodyRows - headerRows - frameRows);
  return {
    tasks,
    selected,
    view,
    now,
    listed,
    hidden,
    link,
    prLink,
    headerRows,
    lines,
    stacked,
    frameRows,
    windowRows,
    maxStart: Math.max(0, lines.length - windowRows),
    creating: false,
  };
};

const startOf = (m: PaneModel, s: { follow: boolean; offset: number }): number =>
  s.follow ? m.maxStart : Math.min(Math.max(0, s.offset), m.maxStart);

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    try {
      const stored = coerceTasks(await $.store.get(STORE_KEY));
      await mutate($, () => stored);
    } catch {
      // 読めなければ空から始める。
    }
    try {
      const logs = coerceLogs(await $.store.get(LOGS_KEY));
      await update($, logsAtom, () =>
        Object.fromEntries(
          Object.entries(logs).map(([k, v]) => [
            k,
            { supported: true, cursor: v.cursor, lines: v.lines },
          ]),
        ),
      );
    } catch {
      // ログが読めなければ空から積む。
    }
    try {
      const endpoints = coerceEndpoints(await $.store.get(ENDPOINTS_KEY));
      await update($, endpointsAtom, () => endpoints);
      await ensureTimer($);
    } catch {
      // 接続先が読めなければ task_start で拾ったものだけで動く。
    }
    // 起動を待たせない。task_list を取り、終端だけのときはタイマーが動かないので中身も 1 回取る。
    void refresh($).catch(() => undefined);

    return next(e);
  });

  // open-console / close-console は skill（中身なし）の実行を拾い、next を呼ばずに自分で答える。
  // create-task は next で本来の処理（モデルへ手順を渡す）に続ける。mod は task_start を呼ばない。
  // matcher で自分のコマンドだけに絞る（他の mod のコマンドの結果に rovo が混ざらないように）。
  on("command.run", { command: OWN_COMMANDS }, async ($, e, next) => {
    const name = baseName(e.command);
    if (name === CLOSE_COMMAND) {
      try {
        await $.ui.close({ id: PANE_ID });
      } catch {
        // 閉じられなくても続ける。
      }
      try {
        await update($, creatingAtom, () => null);
      } catch {
        // 作成中の表示が消せなくても続ける。
      }

      return { text: "コンソールのペインを閉じました。" };
    }
    if (name === OPEN_COMMAND) {
      try {
        // 作成中の逃げ道: 作成中の表示を消して、通常の表示（前のタスク）に戻す。
        await update($, creatingAtom, () => null);
      } catch {
        // 消せなくてもペインは開く。
      }
      await openPane($);
      try {
        await ensureTimer($);
      } catch {
        // ペインは開いた。
      }
      void refresh($).catch(() => undefined);

      return { text: "コンソールのペインを開きました（読み取り専用）。" };
    }
    if (name === CREATE_COMMAND) {
      try {
        const at = await $.clock.now();
        await update($, creatingAtom, () => at);
        await openPane($);
      } catch {
        // 表示に失敗しても本来の処理は続ける。
      }
    }

    return next(e);
  });

  // 呼び出しは変えない・止めない: next の結果をそのまま返す。
  on("tool.call", async ($, e, next) => {
    const ran = await next(e);
    try {
      const outcome = ran as { deny?: string; isError?: boolean; text?: string };
      const hit = matchTaskStart(String(e.tool));
      if (hit !== null && outcome.deny === undefined && outcome.isError !== true) {
        const started = parseStartResult(outcome.text ?? "");
        if (started !== null) {
          const input = e as Record<string, unknown>;
          await track($, hit, started, input.title, {
            repository: input.repository,
            model: input.model,
          });
        }
      }
      const rovoTool = outcome.deny === undefined ? matchRovoTool(String(e.tool)) : null;
      if (rovoTool !== null && (await rememberEndpoint($, rovoTool))) {
        void refresh($).catch(() => undefined);
      }
      await ensureTimer($);
    } catch {
      // 追跡に失敗しても tool の結果には触れない。
    }

    return ran;
  }).catch(($, e, next) => next(e));

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e);
    const m = await buildModel($, e.props.scroll.bodyRows);
    const { selected, view, listed, link, prLink, now } = m;

    // 作成中は案内だけ。前のタスクの一覧・詳細・出力は描かない（2 行なので bodyRows に収まる）。
    if (m.creating) {
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color="suggestion">●</Text>
            {" タスクを作成中…"}
          </Text>
          <Text dimColor wrap="truncate-end">
            rovo のタスクを作っています。始まるとここに表示されます。
          </Text>
        </Box>
      );
    }
    if (m.tasks.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>追跡中のタスクはありません。</Text>
        </Box>
      );
    }

    const elapsedOf = (t: RovoTask): string => formatElapsed((t.terminalAt ?? now) - t.startedAt);
    // 題名は、ペインの幅から他の列を引いた残りを使う（右端で折り返さないよう 1 桁あける）。
    const widest = (texts: string[], max: number): number =>
      Math.min(max, Math.max(0, ...texts.map(displayWidth)));
    const cols = laneColumns(e.props.bodyColumns - 1, {
      repo: widest(
        listed.map((t) => repoName(t.repository)),
        REPO_MAX,
      ),
      model: widest(
        listed.map((t) => shortModel(t.model ?? "")),
        MODEL_MAX,
      ),
      elapsed: widest(listed.map(elapsedOf), ELAPSED_MAX),
    });
    const start = startOf(m, await read($, scrollAtom));
    const shown = m.lines.slice(start, start + m.windowRows);
    const frame = await read($, frameAtom);
    const arrivals = await read($, arrivalsAtom);
    const consoles = await read($, consolesAtom);

    // 上から: 見出し・ワーカーの列（3 行ずつ）・選んだワーカーの題名とリンク（ヘッダー、出力の量に関わらず常に出す）、
    // 残りの行が出力の窓。ツリー全体を bodyRows に収めるので、エンジンはスクロールしない。
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="claude" weight="bold">
            rovo
          </Text>
          <Text dimColor>{`  ${headingText(m.tasks)}`}</Text>
        </Box>
        {listed.map((t) => {
          const key = taskKey(t);
          const isSelected = selected !== undefined && taskKey(selected) === key;
          const own = consoles[key];
          const lane = laneOf(t, own);
          const arrival = arrivals[key];
          const arrived =
            arrival !== undefined && lane.at !== null && arrival.at === lane.at
              ? frame - arrival.since < ARRIVE_FRAMES
              : false;
          const right = rightText(t, own?.hasOutput === true ? own.nowText : null, own?.pr);
          const repo = repoName(t.repository);
          const model = shortModel(t.model ?? "");
          const press = async () => {
            await update($, selectedAtom, () => key);
            await update($, shownAtom, () => key);
            await update($, scrollAtom, () => ({ follow: true, offset: 0 }));
            void fetchMissing($, key).catch(() => undefined);
          };
          return (
            <Box key={`worker:${key}`} flexDirection="column">
              <Button key={`row:${key}:0`} plain onPress={press}>
                {isSelected ? <Text color="claude">▸</Text> : " "}{" "}
                <Text weight={isSelected ? "bold" : undefined}>
                  {padWidth(truncateWidth(t.title, cols.title), cols.title)}
                </Text>
                <Text dimColor>
                  {` ${padWidth(truncateWidth(repo, cols.repo), cols.repo)} ${padWidth(truncateWidth(model, cols.model), cols.model)} ${padWidth(elapsedOf(t), cols.elapsed)}`}
                </Text>
              </Button>
              <Button key={`row:${key}:1`} plain onPress={press}>
                {"  "}
                {laneCells({ ...lane, frame, arrived }).map((c, i) => (
                  <Text key={`cell:${i}`} color={c.color} weight={c.bold ? "bold" : undefined}>
                    {c.text}
                  </Text>
                ))}
                {"   "}
                {right.text !== "" && <Text color={right.color}>{right.text}</Text>}
              </Button>
              <Button key={`row:${key}:2`} plain onPress={press}>
                {"  "}
                <Text dimColor>{labelRow(lane.kind)}</Text>
              </Button>
            </Box>
          );
        })}
        {m.hidden > 0 && <Text dimColor>{`他 ${m.hidden} 件`}</Text>}
        {selected !== undefined && (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text dimColor>{"─ "}</Text>
              <Text weight="bold">{selected.title}</Text>
            </Text>
            {view === undefined && <Text dimColor>まだ取得していません。</Text>}
            {view !== undefined && !view.hasOutput && (
              <Text dimColor>このサーバーは出力に対応していません。</Text>
            )}
            {(link !== undefined || prLink !== undefined) && (
              <Box>
                {link !== undefined && (
                  <Link href={link}>
                    <Text color="suggestion">ダッシュボードを開く</Text>
                  </Link>
                )}
                {prLink !== undefined && (
                  <Box marginLeft={link !== undefined ? 2 : 0}>
                    <Link href={prLink.url}>
                      <Text color="suggestion">
                        {prLink.number === null ? "PR" : `PR #${prLink.number}`}
                      </Text>
                    </Link>
                  </Box>
                )}
              </Box>
            )}
            {view !== undefined && view.hasOutput && (
              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor={
                  isTerminal(selected.status) ? statusColor(selected.status) : "suggestion"
                }
                height={m.frameRows + m.windowRows}
              >
                {!m.stacked && view.command !== null && (
                  <Box>
                    <Text mono wrap="truncate-end">{`$ ${view.command}`}</Text>
                    {view.commandWhere !== undefined && (
                      <Text dimColor wrap="truncate-end">{`  ${view.commandWhere} で`}</Text>
                    )}
                  </Box>
                )}
                {shown.map((line, i) => {
                  const style = logStyle(line.kind);
                  return (
                    <Box key={`out:${start + i}`}>
                      <Text
                        mono
                        wrap="truncate-end"
                        color={style.color}
                        dimColor={style.dim === true}
                        weight={style.bold === true ? "bold" : undefined}
                      >
                        {line.text}
                      </Text>
                      {line.where !== undefined && (
                        <Text dimColor wrap="truncate-end">{`  ${line.where} で`}</Text>
                      )}
                    </Box>
                  );
                })}
                {m.lines.length === 0 && (m.stacked || view.command === null) && (
                  <Text dimColor>まだ出力はありません。</Text>
                )}
              </Box>
            )}
          </Box>
        )}
      </Box>
    );
  });

  // ヘッダーを固定するため、出力の窓は mod が持つ。next を呼ばず {} を返す（エンジンは動かさない）。
  // 上へ動かしたら追従を止め、末尾まで戻したら再開する。
  on("ui.scroll", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const m = await buildModel($, e.bodyRows);
    const current = startOf(m, await read($, scrollAtom));
    const next = Math.min(Math.max(0, current + e.by), m.maxStart);
    await update($, scrollAtom, () => ({ follow: next >= m.maxStart, offset: next }));
    $.ui.invalidate("ui.render");

    return {};
  });
};
