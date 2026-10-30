import type { EngineInterface, McpToolResult, Register, Timer } from "claude-code";
import { atom, read, update } from "claude-code";

import type { RovoConsole, RovoTask } from "../types";
import type {
  Awaiting,
  LaneState,
  LogLine,
  ParsedConsole,
  PrLink,
  TaskKind,
  WorkerPlan,
} from "./lib";
import {
  agoText,
  appendLines,
  bestWorker,
  budgetToastText,
  CONSOLE_RETRY_MS,
  cleanTitle,
  coerceLogs,
  coerceTasks,
  columnHeader,
  detailText,
  displayWidth,
  expandTabs,
  formatElapsed,
  frameTop,
  glyph,
  headingText,
  httpsOnly,
  isTerminal,
  isWaiting,
  laneCells,
  logStyle,
  MAX_LOG_PAGES,
  matchRovoTool,
  matchTaskStart,
  mergeListed,
  moveTarget,
  orderTasks,
  padWidth,
  paneColumns,
  parseConsole,
  parseStartResult,
  parseStatus,
  parseTaskList,
  planWorkers,
  pruneTasks,
  repoName,
  reviewHeader,
  STATIONS,
  STORED_LOG_LINES,
  shortModel,
  shortText,
  slideShift,
  spacerRows,
  stageIndex,
  statusColor,
  TRACK_COL,
  tailLines,
  taskKey,
  terminalCell,
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
// 出力の窓。follow が true の間は末尾に追従する。offset は追従を止めたときの先頭行（出力の中の行番号）。
const scrollAtom = atom({ plugin: "rovo", key: "scroll" } as const, { follow: true, offset: 0 });
// いま出しているワーカー（taskKey）。描画のたびに選び直さない。動くのは、クリックと、
// イベント（新しい作業中のタスクを拾った・質問待ちに入った）で出しているものが終端か消えているときだけ。変わったら追従に戻す。
const shownAtom = atom({ plugin: "rovo", key: "shown" } as const, null);
// /rovo:create-task が実行された時刻。タスクを拾うまで「タスクを作成中…」を出す。
const creatingAtom = atom({ plugin: "rovo", key: "creating" } as const, null);
const CREATING_MS = 10 * 60 * 1000;
const CREATE_COMMAND = "create-task";
const CONSOLE_COMMAND = "rovo-console";
// 名前空間なし（create-task）と rovo: 付き（rovo:create-task）だけを同じ名前として扱う。旧名は拾わない。
const baseName = (command: string): string =>
  command.startsWith("rovo:") ? command.slice(5) : command;

// 自分のコマンド（名前空間なし・rovo: 付き）。baseName と同じ範囲。
// 正規表現ではなく名前の一覧にする（正規表現の matcher だと、他の mod のコマンドにも rovo が関わったと表示される）
const OWN_COMMANDS = ["create-task", "rovo:create-task", "rovo-console"];

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

const HOUR_MS = 60 * 60 * 1000;

const visibleOf = (tasks: readonly RovoTask[], now: number): RovoTask[] =>
  tasks.filter((t) => t.terminalAt === undefined || now - t.terminalAt < HOUR_MS);

/** 出すタスク: 出しているもの。無い・消えているときは見かけ上 best（保存はイベントのとき）。 */
const resolveShown = (tasks: readonly RovoTask[], shown: string | null): RovoTask | undefined =>
  tasks.find((t) => taskKey(t) === shown) ?? bestWorker(tasks);

/** いまペインに出しているタスクの taskKey（無ければ null）。 */
const shownKeyNow = async ($: Dollar): Promise<string | null> => {
  const now = await $.clock.now();
  const picked = resolveShown(visibleOf(await read($, tasksAtom), now), await read($, shownAtom));
  return picked === undefined ? null : taskKey(picked);
};

/** 出すワーカーを替える。替わったら窓を追従に戻す。 */
const setShown = async ($: Dollar, key: string | null): Promise<void> => {
  if (key === (await read($, shownAtom))) return;
  await update($, shownAtom, () => key);
  await update($, scrollAtom, () => ({ follow: true, offset: 0 }));
};

/** イベントのとき: 出しているものが終端・消えている・無いときだけ、質問待ち > 最新の実行中 > 最新へ移る。 */
const considerMove = async ($: Dollar, tasks: readonly RovoTask[]): Promise<void> => {
  const now = await $.clock.now();
  await setShown($, moveTarget(visibleOf(tasks, now), await read($, shownAtom)));
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
  // イベント: 新しい作業中のタスクを拾った・質問待ちに入った（まだ何も出していないときも決める）。
  const was = new Map(before.map((t) => [taskKey(t), t]));
  const isEvent = after.some((t) => {
    if (isTerminal(t.status)) return false;
    const old = was.get(taskKey(t));
    return old === undefined || (isWaiting(t) && !isWaiting(old));
  });
  // 出しているものが一覧から消えた（終端から 1 時間）ときも、同じ規則で移る。
  const shownNow = await read($, shownAtom);
  const isGone = shownNow !== null && !visibleOf(after, now).some((t) => taskKey(t) === shownNow);
  if (isEvent || isGone || shownNow === null) await considerMove($, after);
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
  const shownKey = await shownKeyNow($);
  const selected = running.find((t) => taskKey(t) === shownKey);
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
  const pickedKey = await shownKeyNow($);
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
    // ペインは自動では開かない（利用者が /rovo-console で開く）。代わりに、見えていなければトーストで案内する。
    let isShown = false;
    try {
      isShown = (await $.ui.panes()).some((p) => p.id === PANE_ID && p.isShown);
    } catch {
      // 分からなければ案内を出す側に倒す。
    }
    if (!isShown) $.ui.toast("rovo のタスクを始めました。/rovo-console で開けます");
  }
};

/** ヘッダー・出力の窓の寸法。描画と ui.scroll の両方が同じ計算を使う。 */
type PaneModel = {
  tasks: RovoTask[];
  selected: RovoTask | undefined;
  view: RovoConsole | undefined;
  now: number;
  /** 一覧に出すワーカー（並びは orderTasks）と、出さなかった件数・行の数。 */
  plan: WorkerPlan;
  link: string | undefined;
  prLink: RovoConsole["pr"];
  /** ヘッダーの行数（枠の外。空行を含む）。 */
  headerRows: number;
  /** 空行の数（0〜2）。1 以上で見出しの下、2 で一覧と枠の間にも入れる。 */
  spacers: number;
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
      plan: { shown: [], hidden: 0, hiddenAllTerminal: false, rows: 0 },
      link: undefined,
      prLink: undefined,
      headerRows: CREATING_ROWS,
      spacers: 0,
      lines: [],
      stacked: false,
      frameRows: 0,
      windowRows: Math.max(1, bodyRows - CREATING_ROWS),
      maxStart: 0,
      creating: true,
    };
  }
  const all = await read($, tasksAtom);
  const tasks = visibleOf(all, now);
  const consoles = await read($, consolesAtom);
  const selected = resolveShown(tasks, await read($, shownAtom));
  const view = selected === undefined ? undefined : consoles[taskKey(selected)];
  const link = selected === undefined ? undefined : httpsOnly(selected.dashboardUrl);
  const prCandidate = view?.pr ?? selected?.pr;
  const prLink =
    prCandidate !== undefined && httpsOnly(prCandidate.url) !== undefined ? prCandidate : undefined;

  // 行が足りないときは、終端の行 → 作業中の行の順に減らして出力の窓を残す（出しているワーカーは残す）。
  const plan = planWorkers(
    orderTasks(tasks),
    selected === undefined ? null : taskKey(selected),
    bodyRows,
  );

  // 数える行: 見出し + 列見出し + 一覧（plan.rows）。出力の枠が無いときだけ、タイトルとリンクの 1 行 + 取得前・非対応の一言。
  // 枠があるときのタイトルとリンクは枠の上辺に載る（frameRows に含まれる）。
  let headerRows = 2 + plan.rows;
  if (selected !== undefined && (view === undefined || !view.hasOutput)) headerRows += 2;
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
  // 空行は、窓が MIN_WINDOW を超えて余った行からだけ取る。
  const spacers = frameRows > 0 ? spacerRows(bodyRows - headerRows - frameRows) : 0;
  headerRows += spacers;
  const windowRows = Math.max(1, bodyRows - headerRows - frameRows);
  return {
    tasks,
    selected,
    view,
    now,
    plan,
    link,
    prLink,
    headerRows,
    spacers,
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
    // 開け閉めするだけなので、作業中のターンを待たせずその場で動かす（immediate）。
    // run はターンの状態に依存しない。スキルだと作業中に打ったとき終わりを待つため mod のコマンドにする。
    try {
      await $.command.register({
        name: CONSOLE_COMMAND,
        description: "rovo のペインを開く・閉じる",
        immediate: true,
      });
    } catch {
      // 登録できなくてもほかの機能は動かす。
    }
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

  // rovo-console は mod 自身が登録した immediate のコマンド（開閉の切り替え）で、next を呼ばずに自分で答える。
  // create-task は next で本来の処理（モデルへ手順を渡す）に続ける。mod は task_start を呼ばない。
  // matcher で自分のコマンドだけに絞る（他の mod のコマンドの結果に rovo が混ざらないように）。
  on("command.run", { command: OWN_COMMANDS }, async ($, e, next) => {
    const name = baseName(e.command);
    if (name === CONSOLE_COMMAND) {
      // 開いて見えているときは閉じる。閉じている・他のタブの裏にあるときは開く（前に出す）。
      let isShown = false;
      try {
        isShown = (await $.ui.panes()).some((p) => p.id === PANE_ID && p.isShown);
      } catch {
        // 分からなければ開く側に倒す。
      }
      if (isShown) {
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
    const { selected, view, link, prLink, now } = m;

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

    const W = e.props.bodyColumns - 1; // 右端で折り返さないよう 1 桁あける
    const cols = paneColumns(W);
    const start = startOf(m, await read($, scrollAtom));
    const shown = m.lines.slice(start, start + m.windowRows);
    const frame = await read($, frameAtom);
    const arrivals = await read($, arrivalsAtom);
    const consoles = await read($, consolesAtom);
    const padLeft = (text: string, width: number): string =>
      " ".repeat(Math.max(0, width - displayWidth(text))) + text;

    // 1 ワーカーぶんの行。作業中・質問待ちは 2 行（タイトル+線路+モデル+経過 / リポジトリ+いまの動き）、終端は 1 行。
    const workerRows = (t: RovoTask) => {
      const key = taskKey(t);
      const isShown = selected !== undefined && taskKey(selected) === key;
      const own = consoles[key];
      const lane = laneOf(t, own);
      const bar = isShown ? <Text color="claude">▎</Text> : " ";
      const track = laneCells({ ...lane, frame, arrived: false });
      const press = async () => {
        await setShown($, key);
        await update($, scrollAtom, () => ({ follow: true, offset: 0 }));
        void fetchMissing($, key).catch(() => undefined);
      };
      const trackCells = (cells: typeof track) =>
        cells.map((c, i) => (
          <Text key={`cell:${i}`} color={c.color} weight={c.bold ? "bold" : undefined}>
            {c.text}
          </Text>
        ));
      const trackPad = (cells: typeof track): string =>
        " ".repeat(Math.max(0, TRACK_COL - cells.reduce((n, c) => n + displayWidth(c.text), 0)));
      if (isTerminal(t.status)) {
        const cell = terminalCell(t, own?.pr);
        // 結果は線路の位置に文字で出す（✓ PR #n / ✕ 失敗 など）。タイトルの前は選択の帯の位置だけ。
        const result = truncateWidth(`${glyph(t.status)} ${cell.text}`, TRACK_COL - 2);
        const dim = t.status === "COMPLETED" || t.status === "CANCELLED";
        const ago = agoText(now - (t.terminalAt ?? now));
        const model = shortModel(t.model ?? "");
        return (
          <Button key={`row:${key}:0`} plain onPress={press}>
            {bar}{" "}
            <Text dimColor={dim} weight={isShown ? "bold" : undefined}>
              {padWidth(truncateWidth(t.title, cols.title), cols.title)}
            </Text>{" "}
            <Text color={cell.color}>{result}</Text>
            {" ".repeat(Math.max(0, TRACK_COL - displayWidth(result)))}
            {cols.model > 0 && (
              <Text dimColor={dim}>
                {`${padWidth(truncateWidth(model, cols.model), cols.model)} `}
              </Text>
            )}
            <Text dimColor>{padLeft(ago, cols.elapsed)}</Text>
          </Button>
        );
      }
      const arrival = arrivals[key];
      const arrived =
        arrival !== undefined && lane.at !== null && arrival.at === lane.at
          ? frame - arrival.since < ARRIVE_FRAMES
          : false;
      const live = laneCells({ ...lane, frame, arrived });
      const detail = detailText(t, own?.hasOutput === true ? own.nowText : null);
      const repo = repoName(t.repository);
      const detailW = Math.max(1, W - 4 - (repo === "" ? 0 : displayWidth(repo) + 2));
      return (
        <Box key={`worker:${key}`} flexDirection="column">
          <Button key={`row:${key}:0`} plain onPress={press}>
            {bar}{" "}
            <Text weight={isShown ? "bold" : undefined}>
              {padWidth(truncateWidth(t.title, cols.title), cols.title)}
            </Text>{" "}
            {trackCells(live)}
            {trackPad(live)}
            {cols.model > 0 && (
              <Text>{`${padWidth(truncateWidth(shortModel(t.model ?? ""), cols.model), cols.model)} `}</Text>
            )}
            <Text dimColor>{padLeft(formatElapsed(now - t.startedAt), cols.elapsed)}</Text>
          </Button>
          <Button key={`row:${key}:1`} plain onPress={press}>
            {bar}
            {"   "}
            {repo !== "" && <Text dimColor>{`${repo}  `}</Text>}
            {detail.text !== "" && (
              <Text color={detail.color}>{truncateWidth(detail.text, detailW)}</Text>
            )}
          </Button>
        </Box>
      );
    };

    const taskKind = m.plan.shown.filter((t) => t.kind !== "review");
    const reviewKind = m.plan.shown.filter((t) => t.kind === "review");
    const hiddenNote =
      m.plan.hidden > 0
        ? m.plan.hiddenAllTerminal
          ? `他 ${m.plan.hidden} 件（完了。終わって 1 時間で消えます）`
          : `他 ${m.plan.hidden} 件`
        : "";

    const heading = headingText(m.tasks);
    const prText =
      prLink === undefined ? "" : prLink.number === null ? "PR" : `PR #${prLink.number}`;
    const dashText = link === undefined ? "" : "ダッシュボード";
    // リンクの束。上辺は幅が足りないとき、ダッシュボード → PR の順に落とす。
    const linksOf = (withPr: boolean, withDash: boolean) => {
      const showPr = withPr && prLink !== undefined;
      const showDash = withDash && link !== undefined;
      return {
        text: [showPr ? prText : "", showDash ? dashText : ""].filter((x) => x !== "").join(" · "),
        // Fragment は Box になって inline に入れられないので、配列で返す
        node: [
          showPr && prLink !== undefined && (
            <Text key="pr" color="suggestion">
              <Link href={prLink.url}>{prText}</Link>
            </Text>
          ),
          showPr && showDash && (
            <Text key="sep" dimColor>
              {" · "}
            </Text>
          ),
          showDash && link !== undefined && (
            <Text key="dash" color="suggestion">
              <Link href={link}>{dashText}</Link>
            </Text>
          ),
        ],
      };
    };
    const { text: linkText, node: links } = linksOf(true, true);
    // 枠の色: 作業中は控えめ（光るのは列車だけ）。終端になったら状態の色。
    const frameColor =
      selected !== undefined && isTerminal(selected.status)
        ? (statusColor(selected.status) ?? "subtle")
        : "subtle";
    const FW = Math.max(4, W - 2); // 枠の幅（左に 2 桁ずらす）
    const innerW = FW - 2;
    const title = selected?.title ?? "";
    const variants = [linksOf(true, true), linksOf(true, false)].filter((v) => v.text !== "");
    const chosen =
      variants.find((v) => frameTop(FW, title, displayWidth(v.text)).showLinks) ??
      linksOf(false, false);
    const top = frameTop(FW, title, displayWidth(chosen.text));
    const isEmptyNote = m.lines.length === 0 && (m.stacked || view?.command === null);
    // 窓が満ちないときは空の行で枠の下辺を一番下に保つ。
    const padRows = Math.max(0, m.windowRows - shown.length - (isEmptyNote ? 1 : 0));
    const side = (key: string, body: React.ReactNode) => (
      <Box key={key}>
        <Text color={frameColor}>│</Text>
        <Box width={innerW} flexShrink={0}>
          {body}
        </Box>
        <Text color={frameColor}>│</Text>
      </Box>
    );

    // 上から: 見出し・列見出し・ワーカーの行・出力の枠（上辺にタイトルとリンク）。
    // 空行は余った行からだけ。ツリー全体を bodyRows に収めるので、エンジンはスクロールしない。
    return (
      <Box flexDirection="column">
        <Box key="heading">
          {heading.map((part, i) => (
            <Box key={`heading:${part.label}`}>
              <Text>{i === 0 ? "  " : "    "}</Text>
              <Text dimColor={part.n === 0}>{`${part.label} `}</Text>
              <Text
                color={part.tone}
                weight={part.tone === "warning" ? "bold" : undefined}
                dimColor={part.n === 0}
              >
                {String(part.n)}
              </Text>
            </Box>
          ))}
        </Box>
        {m.spacers >= 1 && <Box key="spacer:heading" height={1} />}
        <Text dimColor wrap="truncate-end">
          {columnHeader(cols, taskKind.length === 0 && reviewKind.length > 0 ? "review" : "task")}
        </Text>
        {taskKind.map(workerRows)}
        {taskKind.length > 0 && reviewKind.length > 0 && (
          <Text dimColor wrap="truncate-end">
            {reviewHeader(cols)}
          </Text>
        )}
        {reviewKind.map(workerRows)}
        {hiddenNote !== "" && <Text dimColor>{hiddenNote}</Text>}
        {m.spacers >= 2 && <Box key="spacer:frame" height={1} />}
        {selected !== undefined && (
          <Box flexDirection="column">
            {(view === undefined || !view.hasOutput) && (
              <Box key="titlebar" justifyContent="space-between">
                <Box flexShrink={1}>
                  <Text wrap="truncate-end">
                    <Text dimColor>{"─ "}</Text>
                    <Text weight="bold">{selected.title}</Text>
                  </Text>
                </Box>
                {linkText !== "" && (
                  <Box flexShrink={0} marginLeft={2}>
                    {links}
                  </Box>
                )}
              </Box>
            )}
            {view === undefined && <Text dimColor>まだ取得していません。</Text>}
            {view !== undefined && !view.hasOutput && (
              <Text dimColor>このサーバーは出力に対応していません。</Text>
            )}
            {view !== undefined && view.hasOutput && (
              <Box
                key="frame"
                flexDirection="column"
                marginLeft={2}
                height={m.frameRows + m.windowRows}
              >
                {/* 上辺は必ず 1 行・枠の幅ちょうど。全部を 1 つの Text の inline に並べ、Box で分けない（リンクは Link の inline） */}
                <Box key="frame-top" width={FW} flexShrink={0}>
                  <Text wrap="truncate-end">
                    <Text color={frameColor}>{"╭─ "}</Text>
                    <Text weight="bold">{top.title}</Text>
                    <Text color={frameColor}>
                      {` ${"─".repeat(top.dashes)}${top.showLinks ? " " : "╮"}`}
                    </Text>
                    {top.showLinks && chosen.node}
                    {top.showLinks && <Text color={frameColor}>{" ─╮"}</Text>}
                  </Text>
                </Box>
                {!m.stacked &&
                  view.command !== null &&
                  side(
                    "frame:cmd",
                    <>
                      <Text mono wrap="truncate-end">
                        {expandTabs(`$ ${view.command}`)}
                      </Text>
                      {view.commandWhere !== undefined && (
                        <Text dimColor wrap="truncate-end">{`  ${view.commandWhere} で`}</Text>
                      )}
                    </>,
                  )}
                {shown.map((line, i) => {
                  const style = logStyle(line.kind);
                  return side(
                    `out:${start + i}`,
                    <>
                      <Text
                        mono
                        wrap="truncate-end"
                        color={style.color}
                        dimColor={style.dim === true}
                        weight={style.bold === true ? "bold" : undefined}
                      >
                        {expandTabs(line.text)}
                      </Text>
                      {line.where !== undefined && (
                        <Text dimColor wrap="truncate-end">{`  ${line.where} で`}</Text>
                      )}
                    </>,
                  );
                })}
                {isEmptyNote && side("frame:empty", <Text dimColor>まだ出力はありません。</Text>)}
                {Array.from({ length: padRows }, (_, i) => side(`pad:${i}`, <Text> </Text>))}
                <Text key="frame-bottom" color={frameColor}>
                  {`╰${"─".repeat(innerW)}╯`}
                </Text>
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
