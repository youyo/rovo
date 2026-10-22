import type { EngineInterface, McpToolResult, Register, ThemeKey, Timer } from "claude-code";
import { atom, read, update } from "claude-code";

import type { RovoConsole, RovoTask } from "../types";
import type { ParsedConsole, PrLink } from "./lib";
import {
  CONSOLE_RETRY_MS,
  cleanTitle,
  coerceTasks,
  formatElapsed,
  glyph,
  httpsOnly,
  isTerminal,
  matchTaskStart,
  parseConsole,
  parseStartResult,
  parseStatus,
  pruneTasks,
  slideShift,
  statusColor,
  statusLabel,
  tailLines,
  taskKey,
  toastText,
} from "./lib";

type Dollar = EngineInterface;

const PANE_ID = "rovo";
const POLL_MS = 4000;
const STORE_KEY = "tasks";

// 読み取り専用: 呼ぶ MCP ツールはこの 2 つだけ（task_start は model が呼んだ結果を見るだけ）。
const TOOL_CONSOLE = "task_console";
const TOOL_STATUS = "task_status";

const tasksAtom = atom({ plugin: "rovo", key: "tasks" } as const, []);
const consolesAtom = atom({ plugin: "rovo", key: "consoles" } as const, {});
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

// ヘッダーに出すタスク一覧の最大行数（ペインが狭いことがある）。選んでいるタスクは必ず入れる。
const LIST_MAX = 4;

const PHASES = [
  ["prepare", "準備"],
  ["run", "実行"],
  ["verify", "検証"],
  ["done", "完了"],
] as const;

const stoppedLabel = (phase: string): string =>
  PHASES.find(([name]) => name === phase && name !== "done")?.[1] ?? "不明";

const textOf = (result: McpToolResult): string =>
  result.content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");

/** 段階の各ステップ。子の文字列は入らない（サーバーが決めた段階名だけを見る）。 */
const phaseSteps = (
  phase: string | null,
): { mark: string; label: string; color: ThemeKey }[] | null => {
  const at = PHASES.findIndex(([name]) => name === phase);
  if (at < 0) return null;
  return PHASES.map(([, label], i) => {
    if (i < at || (i === at && phase === "done"))
      return { mark: "✓", label, color: "success" as const };
    return i === at
      ? { mark: "●", label, color: "suggestion" as const }
      : { mark: "○", label, color: "subtle" as const };
  });
};

let timer: Timer | null = null;
let isPolling = false;

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

const stopIfIdle = async ($: Dollar): Promise<void> => {
  const list = await read($, tasksAtom);
  if (timer !== null && !list.some((t) => !isTerminal(t.status))) {
    timer.cancel();
    timer = null;
  }
};

const pollOne = async ($: Dollar, t: RovoTask): Promise<void> => {
  let parsed: ParsedConsole | null = null;
  const startedAt = await $.clock.now();
  // task_console が使えないタスクも、60 秒に 1 回は試し直す（同時 1 本は tick の isPolling が守る）。
  const isRetry = t.noConsole === true && startedAt >= (t.consoleRetryAt ?? 0);
  let isConsoleMissing = t.noConsole === true && !isRetry;
  if (!isConsoleMissing) {
    try {
      const res = await $.mcp.call(t.server, t.prefix + TOOL_CONSOLE, { task_id: t.taskId });
      parsed = res.isError ? null : parseConsole(textOf(res));
    } catch {
      parsed = null;
    }
    if (parsed === null) isConsoleMissing = true;
  }

  let status: string;
  let dashboardUrl: string | undefined;
  let pr: PrLink | undefined;
  let view: Omit<RovoConsole, "fetchedAt">;
  if (parsed !== null) {
    status = parsed.status;
    dashboardUrl = parsed.dashboardUrl;
    pr = parsed.pr;
    view = {
      phase: parsed.phase,
      stoppedPhase: parsed.stoppedPhase,
      nowText: parsed.nowText,
      command: parsed.command,
      tail: parsed.tail,
      isRunning: parsed.isRunning,
      hasOutput: true,
      ...(pr !== undefined ? { pr } : {}),
    };
  } else {
    let one: { status: string; dashboardUrl?: string; pr?: PrLink } | null = null;
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
  const key = taskKey(t);
  await mutate($, (list) =>
    list.map((x) =>
      taskKey(x) !== key
        ? x
        : {
            ...x,
            status,
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
  if (old?.tail != null && view.tail !== null) {
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
};

/** 前の呼び出しが終わるまで次を出さない。1 回の中でも 1 本ずつ。 */
const tick = async ($: Dollar): Promise<void> => {
  if (isPolling) return;
  isPolling = true;
  try {
    await mutate($, (list) => list);
    for (const t of await read($, tasksAtom)) {
      if (!isTerminal(t.status)) await pollOne($, t);
    }
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
 * consolesAtom に中身が無いタスクを 1 回ずつ取る（終端でも取る。取れたら二度と取らない）。
 * tick と同じ isPolling で同時 1 本を守り、pollOne をそのまま使う。失敗しても他の表示には触れない。
 */
const fetchMissing = async ($: Dollar, only?: string): Promise<void> => {
  if (isPolling) return;
  isPolling = true;
  try {
    for (const t of await read($, tasksAtom)) {
      if (only !== undefined && taskKey(t) !== only) continue;
      // 実行中のタスクはタイマーが取る。
      if (!isTerminal(t.status)) continue;
      if ((await read($, consolesAtom))[taskKey(t)] !== undefined) continue;
      try {
        await pollOne($, t);
      } catch {
        // このタスクは今回あきらめる。次の機会にやり直す。
      }
    }
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

const ensureTimer = async ($: Dollar): Promise<void> => {
  if (timer !== null) return;
  const list = await read($, tasksAtom);
  if (timer !== null || !list.some((t) => !isTerminal(t.status))) return;
  timer = $.clock.every(POLL_MS, () => {
    void tick($);
  });
};

const track = async (
  $: Dollar,
  hit: { server: string; prefix: string },
  started: { taskId: string; status?: string; dashboardUrl?: string },
  title: unknown,
): Promise<void> => {
  const now = await $.clock.now();
  const status = started.status ?? "RUNNING";
  const added: RovoTask = {
    taskId: started.taskId,
    title: cleanTitle(title, started.taskId),
    server: hit.server,
    prefix: hit.prefix,
    startedAt: now,
    status,
    ...(started.dashboardUrl !== undefined ? { dashboardUrl: started.dashboardUrl } : {}),
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
  /** 一覧に出すタスク（新しい順）と、出さなかった件数。 */
  listed: RovoTask[];
  hidden: number;
  link: string | undefined;
  prLink: RovoConsole["pr"];
  /** ヘッダーの行数（枠の外）。 */
  headerRows: number;
  /** 出力の全行（TAIL_LINES まで）と、窓の高さ（枠の行を除く）・先頭行の範囲。 */
  lines: string[];
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
  const prLink =
    view?.pr !== undefined && httpsOnly(view.pr.url) !== undefined ? view.pr : undefined;

  const newest = [...tasks].reverse();
  let listed = newest.slice(0, LIST_MAX);
  if (selected !== undefined && !listed.includes(selected)) {
    listed = [...newest.slice(0, LIST_MAX - 1), selected];
  }
  const hidden = newest.length - listed.length;

  // 数える行: 一覧 + 「他 n 件」 + タイトル + 状態 + 段階など + リンク
  let headerRows = listed.length + (hidden > 0 ? 1 : 0);
  if (selected !== undefined) {
    headerRows += 2;
    if (view === undefined || !view.hasOutput) headerRows += 1;
    else {
      headerRows += 2; // 段階・いま
      if (view.stoppedPhase !== null) headerRows += 1;
    }
    if (link !== undefined || prLink !== undefined) headerRows += 1;
  }
  const lines =
    view !== undefined && view.hasOutput && view.tail !== null
      ? tailLines(view.tail).split("\n")
      : [];
  // 出力は枠で囲む: 上下の辺で 2 行、`$ コマンド` は枠の中の 1 行目に固定して 1 行。
  const frameRows = view !== undefined && view.hasOutput ? 2 + (view.command !== null ? 1 : 0) : 0;
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
      await ensureTimer($);
    } catch {
      // 読めなければ空から始める。
    }
    // 起動を待たせない。終端だけのときタイマーは動かないので、ここで 1 回取る。
    void fetchMissing($).catch(() => undefined);

    return next(e);
  });

  // open-console / close-console は skill（中身なし）の実行を拾い、next を呼ばずに自分で答える。
  // create-task は next で本来の処理（モデルへ手順を渡す）に続ける。mod は task_start を呼ばない。
  on("command.run", async ($, e, next) => {
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
      void fetchMissing($).catch(() => undefined);

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
          await track($, hit, started, (e as Record<string, unknown>).title);
        }
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
    const steps = view !== undefined && view.hasOutput ? phaseSteps(view.phase) : null;
    const start = startOf(m, await read($, scrollAtom));
    const shown = m.lines.slice(start, start + m.windowRows);

    // 上から: 一覧・タイトル・状態・段階・いま・コマンド・リンク（ヘッダー、出力の量に関わらず常に出す）、
    // 残りの行が出力の窓。ツリー全体を bodyRows に収めるので、エンジンはスクロールしない。
    return (
      <Box flexDirection="column">
        {listed.map((t) => {
          const key = taskKey(t);
          const mark = selected !== undefined && taskKey(selected) === key ? "▶" : " ";
          return (
            <Button
              key={`task:${key}`}
              plain
              onPress={async () => {
                await update($, selectedAtom, () => key);
                await update($, shownAtom, () => key);
                await update($, scrollAtom, () => ({ follow: true, offset: 0 }));
                void fetchMissing($, key).catch(() => undefined);
              }}
            >
              {mark === "▶" ? <Text color="claude">▶</Text> : " "}{" "}
              <Text color={statusColor(t.status)}>{glyph(t.status)}</Text>
              {` ${t.title} `}
              <Text dimColor>{elapsedOf(t)}</Text>
            </Button>
          );
        })}
        {m.hidden > 0 && <Text dimColor>{`他 ${m.hidden} 件`}</Text>}
        {selected !== undefined && (
          <Box flexDirection="column">
            <Text weight="bold" wrap="truncate-end">
              {selected.title}
            </Text>
            <Text dimColor wrap="truncate-end">
              {`${statusLabel(selected.status)} / 経過 ${elapsedOf(selected)}`}
            </Text>
            {view === undefined && <Text dimColor>まだ取得していません。</Text>}
            {view !== undefined && view.hasOutput && (
              <Box flexDirection="column">
                {steps === null ? (
                  <Text wrap="truncate-end">段階: 不明</Text>
                ) : (
                  <Text wrap="truncate-end">
                    {"段階: "}
                    {steps.flatMap((step, i) => [
                      i > 0 ? " → " : "",
                      <Text key={`phase:${i}`} color={step.color}>
                        {step.mark}
                      </Text>,
                      step.label,
                    ])}
                  </Text>
                )}
                {view.stoppedPhase !== null && (
                  <Text wrap="truncate-end">{`停止した段階: ${stoppedLabel(view.stoppedPhase)}`}</Text>
                )}
                <Text wrap="truncate-end">
                  {view.nowText !== null ? `いま: ${view.nowText}` : "いま: （なし）"}
                </Text>
              </Box>
            )}
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
              >
                {view.command !== null && (
                  <Text mono wrap="truncate-end">{`$ ${view.command}`}</Text>
                )}
                {shown.map((line, i) => (
                  <Text key={`out:${start + i}`} mono wrap="truncate-end">
                    {line}
                  </Text>
                ))}
                {m.lines.length === 0 && view.command === null && (
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
