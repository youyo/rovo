import type { BudgetMeDto, OverviewDto } from "@rovo/dashboard-contract";
import type { ReactNode } from "react";
import { FactoryBand } from "./factory-band";
import { useT } from "./lang";
import { TaskRail } from "./rail-view";
import { PendingStatusBar, StatusBar } from "./status-bar";
import { buildLanes, HOUR, taskTime, timelineDomain } from "./timeline";
import { TimelineView } from "./timeline-view";
import type { CloudflareState } from "./use-cloudflare";
import type { WaitingState } from "./use-waiting";

/** レールの表示: その日のタスク / 日をまたいだ待ち */
export type RailTab = "day" | "waiting";

/**
 * 骨格の本体（純粋な表示。データ取得は use-overview）。
 * 帯（今日は工場、過去の日はチームのときだけ細いタイムライン）→ 左のレール + 中央のコンソール（console は呼び出し側が渡す）→ 下のステータスバー。
 * data が null（一覧をまだ取れていない）のときは、帯を出さず、レールに railNote を、ステータスバーには予算と Cloudflare だけを出す。
 * 要素の並びは data の有無で変えない（中央のコンソールを作り直さない）。
 */
export function OverviewView(props: {
  data: OverviewDto | null;
  /** 表示しているのが今日か（過去の日は文言をその日向けにし、いまの線を出さない） */
  isToday: boolean;
  autoRefresh: boolean;
  onAutoRefreshChange: (on: boolean) => void;
  onRefresh: () => void;
  /** 直近の更新に失敗した（前のデータを出している） */
  stale: boolean;
  /** 最後に一覧の更新に成功した時刻（use-overview の okAt。工場の小窓の古さの表示に使う） */
  okAt?: number;
  /** Cloudflare の枠の状態（無ければ枠を出さない） */
  cloudflare?: CloudflareState;
  /** 一覧が届くまでのステータスバーに出す予算（/budget）。一覧が届いたら使わない */
  budget?: BudgetMeDto | null;
  /** レールで選択中のタスク（コンソールに出しているタスク） */
  selectedId: string | null;
  /** レール・タイムラインの行の（修飾キー無しの）左クリック。ページを読み直さず、そのタスクを選ぶ。無ければ普通のリンク */
  onSelectTask?: (id: string) => void;
  /** 中央のコンソール */
  console: ReactNode;
  /** data が無いとき、レールに出す案内 */
  railNote?: string;
  /** 自動更新の操作を引き出しに出すか（コンソールが自分の下に持っているときは false） */
  showRefreshControls?: boolean;
  /** 日をまたいだ待ち（日付に関係なく。全員 / 自分の絞り込みは日のタスクと同じ） */
  waiting?: WaitingState;
  /** レールで開いているタブ。onRailTabChange が無ければタブを出さず、日のタスクだけ */
  railTab?: RailTab;
  onRailTabChange?: (tab: RailTab) => void;
  /**
   * 表示の形。split（既定）は レール + コンソール。狭い幅の切り替えでは、list は一覧（レール）だけ、
   * detail は詳細（コンソール）だけを出す（detail は帯も出さない）。list で console が null ならコンソールの場所も作らない
   */
  mode?: "split" | "list" | "detail";
}) {
  const { data } = props;
  const t = useT();
  const mode = props.mode ?? "split";
  let band: ReactNode = null;
  // 更新時刻（引き出しの表示）。タイムラインの「いま」は今日のときだけ使う
  const nowMs = data ? Date.parse(data.generated_at) : 0;
  if (props.isToday && mode !== "detail") {
    // 今日は工場の帯（マイタスクでも。API が自分の分しか返さないので自分の Rovo だけ）。
    // 一覧がまだ（data が null）でも枠だけは出し、届いたときに帯の下を動かさない
    band = (
      <FactoryBand
        data={data}
        onSelect={props.onSelectTask}
        stale={props.stale}
        okAt={props.okAt}
      />
    );
  } else if (data && data.scope === "all" && mode !== "detail") {
    const dayStart = Date.parse(data.range.from);
    const domain = timelineDomain({
      starts: [...data.tasks.map(taskTime), ...data.consults.map((c) => Date.parse(c.at))],
      nowMs: props.isToday ? nowMs : null,
      dayStart,
      dayEnd: dayStart + 24 * HOUR,
    });
    const empty = data.tasks.length === 0 && data.consults.length === 0;
    band = (
      <section
        className="tlband"
        aria-label={props.isToday ? t("timeline.today") : t("timeline.day")}
      >
        {empty ? (
          <p className="empty">
            {props.isToday ? t("timeline.emptyToday") : t("timeline.emptyDay")}
          </p>
        ) : (
          <TimelineView
            lanes={buildLanes(data, domain)}
            domain={domain}
            nowMs={props.isToday ? nowMs : null}
            isToday={props.isToday}
            onSelect={props.onSelectTask}
          />
        )}
      </section>
    );
  }

  const dayRail = data ? (
    <TaskRail
      tasks={data.tasks}
      selectedId={props.selectedId}
      isToday={props.isToday}
      onSelect={props.onSelectTask}
      showOwner={data.scope === "all"}
      at={nowMs}
    />
  ) : (
    <nav className="rail" aria-label={t("rail.label")}>
      <p className="rail-empty" role="status">
        {props.railNote ?? ""}
      </p>
    </nav>
  );

  // 「この日 / 待ち」のタブ（onRailTabChange があるときだけ）。待ちは日付に関係なく、全員 / 自分の絞り込みだけに従う
  let railNode: ReactNode = dayRail;
  if (props.onRailTabChange) {
    const tab = props.railTab ?? "day";
    const waiting = props.waiting ?? { phase: "loading" as const };
    const count =
      waiting.phase === "ready"
        ? `${waiting.data.tasks.length}${waiting.data.truncated ? "+" : ""}`
        : null;
    const tabs: { value: RailTab; label: string }[] = [
      {
        value: "day",
        label: data ? t("rail.tabDayN", { n: data.tasks.length }) : t("rail.tabDay"),
      },
      {
        value: "waiting",
        label: count === null ? t("rail.tabWaiting") : t("rail.tabWaitingN", { n: count }),
      },
    ];
    let body: ReactNode = dayRail;
    if (tab === "waiting") {
      if (waiting.phase === "ready") {
        const hidden = waiting.data.hidden_count;
        body = (
          <TaskRail
            tasks={waiting.data.tasks}
            selectedId={props.selectedId}
            onSelect={props.onSelectTask}
            showOwner={waiting.data.scope === "all"}
            at={Date.parse(waiting.data.generated_at)}
            emptyText={t("rail.emptyWaiting")}
            footnote={
              hidden > 0
                ? { text: t("rail.waitingHidden", { n: hidden }), attr: "data-waiting-hidden" }
                : undefined
            }
          />
        );
      } else {
        const note =
          waiting.phase === "loading"
            ? t("common.loading")
            : waiting.phase === "unauthorized"
              ? t("state.expired")
              : t("rail.waitingError");
        body = (
          <nav className="rail" aria-label={t("rail.label")}>
            <p className="rail-empty" role="status">
              {note}
            </p>
          </nav>
        );
      }
    }
    railNode = (
      <div className="rail-col">
        <fieldset className="rail-tabs" aria-label={t("rail.tabsLabel")}>
          {tabs.map((x) => (
            <button
              key={x.value}
              type="button"
              data-rail-tab={x.value}
              aria-pressed={tab === x.value}
              onClick={() => props.onRailTabChange?.(x.value)}
            >
              {x.label}
            </button>
          ))}
        </fieldset>
        {body}
      </div>
    );
  }

  return (
    <>
      {props.stale ? (
        <p className="notice" role="status">
          {t("console.stale")}
        </p>
      ) : null}

      {band}

      <div className="main" {...(mode === "list" ? { "data-narrow-list": "" } : {})}>
        {mode === "detail" ? null : railNode}
        {mode === "list" && props.console === null ? null : (
          <div className="console-col">{props.console}</div>
        )}
      </div>

      {data ? (
        <StatusBar
          data={data}
          nowMs={nowMs}
          cloudflare={props.cloudflare}
          autoRefresh={props.autoRefresh}
          onAutoRefreshChange={props.onAutoRefreshChange}
          onRefresh={props.onRefresh}
          showRefreshControls={props.showRefreshControls ?? true}
        />
      ) : (
        <PendingStatusBar budget={props.budget ?? null} cloudflare={props.cloudflare} />
      )}
    </>
  );
}
