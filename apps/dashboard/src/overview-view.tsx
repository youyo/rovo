import type { OverviewDto } from "@rovo/dashboard-contract";
import type { ReactNode } from "react";
import { TaskRail } from "./rail-view";
import { StatusBar } from "./status-bar";
import { buildLanes, HOUR, taskTime, timelineDomain } from "./timeline";
import { TimelineView } from "./timeline-view";
import type { CloudflareState } from "./use-cloudflare";

/**
 * 骨格の本体（純粋な表示。データ取得は use-overview）。
 * 細いタイムライン帯 → 左のレール + 中央のコンソール（console は呼び出し側が渡す）→ 下のステータスバー。
 * data が null（一覧をまだ取れていない）のときは、帯とステータスバーを出さず、レールに railNote を出す。
 * 要素の並びは data の有無で変えない（中央のコンソールを作り直さない）。
 */
export function OverviewView(props: {
  data: OverviewDto | null;
  autoRefresh: boolean;
  onAutoRefreshChange: (on: boolean) => void;
  onRefresh: () => void;
  /** 直近の更新に失敗した（前のデータを出している） */
  stale: boolean;
  /** Cloudflare の枠の状態（無ければ枠を出さない） */
  cloudflare?: CloudflareState;
  /** レールで選択中のタスク（コンソールに出しているタスク） */
  selectedId: string | null;
  /** 中央のコンソール */
  console: ReactNode;
  /** data が無いとき、レールに出す案内 */
  railNote?: string;
  /** 自動更新の操作を引き出しに出すか（コンソールが自分の下に持っているときは false） */
  showRefreshControls?: boolean;
}) {
  const { data } = props;
  let band: ReactNode = null;
  let nowMs = 0;
  if (data) {
    const dayStart = Date.parse(data.range.from);
    nowMs = Date.parse(data.generated_at);
    const domain = timelineDomain({
      starts: [...data.tasks.map(taskTime), ...data.consults.map((c) => Date.parse(c.at))],
      nowMs,
      dayStart,
      dayEnd: dayStart + 24 * HOUR,
    });
    const empty = data.tasks.length === 0 && data.consults.length === 0;
    band = (
      <section className="tlband" aria-label="今日のタイムライン">
        {empty ? (
          <p className="empty">タスクを始めると、ここにタイムラインが出ます。</p>
        ) : (
          <TimelineView lanes={buildLanes(data, domain)} domain={domain} nowMs={nowMs} />
        )}
      </section>
    );
  }

  return (
    <>
      {props.stale ? (
        <p className="notice" role="status">
          更新できませんでした。前の内容を表示しています（自動で再試行します）。
        </p>
      ) : null}

      {band}

      <div className="main">
        {data ? (
          <TaskRail tasks={data.tasks} selectedId={props.selectedId} />
        ) : (
          <nav className="rail" aria-label="タスク">
            <p className="rail-empty" role="status">
              {props.railNote ?? ""}
            </p>
          </nav>
        )}
        <div className="console-col">{props.console}</div>
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
      ) : null}
    </>
  );
}
