import type { OverviewDto, VisibleTaskDto, WaitingDto } from "@rovo/dashboard-contract";
import { isAllowedPrUrl } from "./format";
import { isTerminal, markKindOf } from "./status";
import { taskTime } from "./timeline";

/**
 * チームボードの集計（純関数。React に依存しない）。
 * 使うのは overview.tasks（閲覧者に見える分だけ）と waiting.tasks（同じく見える分だけ）。
 * それ以外（権限の無いタスクの件数・費用・月の集計）は使わない（D7）。
 * review（kind が "review"）はコード変更のタスクではないので、件数・走行・質問待ち・リポジトリの数から除く。
 * 費用だけは実費なので含める。kind の無い古い応答の行は task として扱う。
 */

/** 人ごとの行の下に出す走行中・質問待ちのタスクの最大数（残りは more） */
export const BOARD_ACTIVE_MAX = 3;

export type TeamPerson = {
  login: string;
  isViewer: boolean;
  /** 走行中（終端でなく、質問待ちでもない）。過去の日は 0 */
  running: number;
  /** 質問待ち（INPUT_REQUIRED。/waiting の日をまたいだ分を含む）。過去の日は 0 */
  asking: number;
  /** 見ている日に完了したタスク */
  done: number;
  /** 見ている日に失敗した（失敗・予算超過）タスク */
  failed: number;
  /** 見ている日の一覧にあるタスクの費用の合計（USD） */
  costUsd: number;
  /** 質問待ち → 走行中の順、それぞれ新しい順。最大 BOARD_ACTIVE_MAX 件。過去の日は空 */
  active: VisibleTaskDto[];
  /** active に入りきらなかった件数 */
  more: number;
};

export type TeamPr = { number: number; url: string; taskId: string };

export type TeamRepo = {
  repository: string;
  /** 見ている日の一覧にあるタスクの数 */
  count: number;
  /** 走行中（質問待ちを除く）の数。過去の日は 0 */
  running: number;
  /** 待ちの PR（状態の印がレビュー待ちのもの）。番号順 */
  prs: TeamPr[];
};

export type TeamBoard = { isToday: boolean; people: TeamPerson[]; repos: TeamRepo[] };

const isReview = (t: VisibleTaskDto): boolean => t.kind === "review";
const byNewest = (a: VisibleTaskDto, b: VisibleTaskDto): number => taskTime(b) - taskTime(a);

/**
 * 人ごと・リポジトリごとの集計。人の並びは帯（buildLanes）と同じ（閲覧者が先頭、ほかは login 順）。
 * waiting は日をまたいだ待ち（今日のときだけ使う。overview と scope が違うものは使わない）。
 */
export function buildTeamBoard(
  data: OverviewDto,
  waiting: WaitingDto | null,
  isToday: boolean,
): TeamBoard {
  const from = Date.parse(data.range.from);
  const to = Date.parse(data.range.to);
  const own = data.tasks.filter((t) => !isReview(t));
  const waited =
    isToday && waiting !== null && waiting.scope === data.scope
      ? waiting.tasks.filter((t) => !isReview(t))
      : [];

  // 走行中・質問待ちの元になるタスク（overview と waiting を task_id で重ねる）
  const liveById = new Map<string, VisibleTaskDto>();
  if (isToday) {
    for (const t of own) if (!isTerminal(t.status)) liveById.set(t.task_id, t);
    for (const t of waited) if (t.status === "INPUT_REQUIRED") liveById.set(t.task_id, t);
  }

  const viewer = data.viewer.login;
  const logins = new Set<string>([viewer]);
  for (const t of data.tasks) logins.add(t.owner_login);
  for (const t of liveById.values()) logins.add(t.owner_login);
  const ordered = [viewer, ...[...logins].filter((l) => l !== viewer).sort()];

  const people = ordered.map((login): TeamPerson => {
    const mine = own.filter((t) => t.owner_login === login);
    const live = [...liveById.values()].filter((t) => t.owner_login === login);
    const asking = live.filter((t) => t.status === "INPUT_REQUIRED").sort(byNewest);
    const running = live.filter((t) => t.status !== "INPUT_REQUIRED").sort(byNewest);
    // その日に終わったものだけ（日をまたいで翌日に終わったものは翌日の分）。今日は上限を見ない
    const endedToday = (t: VisibleTaskDto) => {
      if (t.ended_at === null) return true;
      const ended = Date.parse(t.ended_at);
      return ended >= from && (isToday || ended < to);
    };
    const finished = mine.filter((t) => isTerminal(t.status) && endedToday(t));
    const shown = [...asking, ...running];
    return {
      login,
      isViewer: login === viewer,
      running: running.length,
      asking: asking.length,
      done: finished.filter((t) => t.status === "COMPLETED").length,
      failed: finished.filter((t) => t.status === "FAILED" || t.status === "BUDGET_EXCEEDED")
        .length,
      costUsd: data.tasks
        .filter((t) => t.owner_login === login)
        .reduce((sum, t) => sum + t.cost.cost_usd, 0),
      active: shown.slice(0, BOARD_ACTIVE_MAX),
      more: Math.max(0, shown.length - BOARD_ACTIVE_MAX),
    };
  });

  return { isToday, people, repos: buildRepos(own, waited, isToday) };
}

function buildRepos(
  own: readonly VisibleTaskDto[],
  waited: readonly VisibleTaskDto[],
  isToday: boolean,
): TeamRepo[] {
  const repos = new Map<string, TeamRepo>();
  const repoOf = (name: string): TeamRepo => {
    let r = repos.get(name);
    if (r === undefined) {
      r = { repository: name, count: 0, running: 0, prs: [] };
      repos.set(name, r);
    }
    return r;
  };
  // 待ちの PR: 一覧のタスクは状態の印がレビュー待ちのもの。日をまたいだ待ち（/waiting）は、GitHub で
  // マージ・クローズと分かったもの（API が外す）以外の完了 + 開いた PR を、要対応のタブと同じくそのまま待ちとする
  const addPr = (t: VisibleTaskDto, fromWaiting: boolean) => {
    if (t.pr === null || !isAllowedPrUrl(t.pr.url)) return;
    const waitingPr =
      fromWaiting &&
      t.status === "COMPLETED" &&
      t.pr.state !== "merged" &&
      t.pr.state !== "closed" &&
      !t.pr.merged;
    if (!waitingPr && markKindOf(t) !== "review") return;
    const r = repoOf(t.repository);
    if (!r.prs.some((p) => p.url === t.pr?.url)) {
      r.prs.push({ number: t.pr.number, url: t.pr.url, taskId: t.task_id });
    }
  };
  for (const t of own) {
    const r = repoOf(t.repository);
    r.count += 1;
    if (isToday && !isTerminal(t.status) && t.status !== "INPUT_REQUIRED") r.running += 1;
    addPr(t, false);
  }
  for (const t of waited) addPr(t, true);
  for (const r of repos.values()) r.prs.sort((a, b) => a.number - b.number);
  return [...repos.values()].sort(
    (a, b) => b.count - a.count || a.repository.localeCompare(b.repository),
  );
}
