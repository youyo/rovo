import type { OverviewDto } from "@rovo/dashboard-contract";
import { useState } from "react";
import { type FACTORY_ROOMS, groupFactory, personIndex } from "./factory";
import { type FactoryKey, useFactoryT } from "./factory-i18n";
import { PipScene, pipSupported, usePip } from "./factory-pip";
import { saveFactoryPref } from "./factory-prefs";
import FactoryScene from "./factory-scene";
import { initialCollapsed } from "./factory-size";
import type { Key } from "./i18n";
import { useNarrow } from "./use-narrow";

/** 人数の 1 行の部屋の並び（1 階 → 2 階 → 出荷） */
const SUMMARY: { id: (typeof FACTORY_ROOMS)[number]["id"] | "shipped"; key: Key | FactoryKey }[] = [
  { id: "prep", key: "factory.prep" },
  { id: "code", key: "factory.code" },
  { id: "verify", key: "factory.verify" },
  { id: "review", key: "factory.review" },
  { id: "ready", key: "factory.ready" },
  { id: "wait", key: "factory.wait" },
  { id: "research", key: "factory.research" },
  { id: "shipped", key: "factory.shipped" },
];
/** 1 部屋に並べる人の色の点の上限（残りは数字で分かる） */
const DOTS = 6;

/**
 * 工場の帯の中身（docs/specs/dashboard-factory.md）。遅延読み込みのチャンク（本体は枠の section だけ）。
 * 広げると工場の断面図、たたむと部屋ごとの人数の 1 行。背の低い画面は最初はたたむ（保存した好みが優先）。
 * 狭い幅（720px 以下）は断面図を出さず、たたんだときと同じ 1 行。見えないタスクは件数だけ。
 * 「小窓で表示」（Document Picture-in-Picture があるブラウザで、狭い幅でないときだけ）を押すと断面図を小窓に出し、
 * その間の帯は「小窓で表示中」と「戻す」の 1 行（たたんだ帯と同じ高さ）。
 */
export default function FactoryPanel(props: {
  data: OverviewDto;
  onSelect?: (id: string) => void;
  /** 直近の更新に失敗した（小窓に「通信エラー」と出す） */
  stale?: boolean;
}) {
  const { data } = props;
  const t = useFactoryT();
  const narrow = useNarrow();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const pip = usePip(t("factory.title"));
  const compact = narrow || collapsed;
  const hidden = data.month.hidden_tasks.count;
  const toggle = () => {
    setCollapsed(!collapsed);
    saveFactoryPref(collapsed ? "expanded" : "collapsed");
  };
  if (pip.win !== null) {
    return (
      <>
        <div className="fxband-bar">
          <span className="fxband-title">{t("factory.title")}</span>
          <span className="fxband-pipon" data-factory-pip-on="">
            {t("factory.pipOn")}
          </span>
          <button
            type="button"
            className="fxband-toggle"
            data-factory-pip-back=""
            title={t("factory.pipBackTitle")}
            onClick={pip.close}
          >
            {t("factory.pipBack")}
          </button>
        </div>
        {pip.ready ? (
          <PipScene
            win={pip.win}
            data={data}
            stale={props.stale === true}
            onSelect={props.onSelect}
          />
        ) : null}
      </>
    );
  }
  let summary = null;
  if (compact) {
    const g = groupFactory(data.tasks);
    summary = (
      <ul className="fxs" data-factory-summary="" aria-label={t("factory.summaryAria")}>
        {SUMMARY.map((r) => {
          const list = r.id === "shipped" ? g.shipped : g.rooms[r.id];
          return (
            <li key={r.id} data-room={r.id} data-n={list.length}>
              <span className="fxs-name">{t(r.key)}</span>
              <span className="fxs-dots" aria-hidden="true">
                {list.slice(0, DOTS).map((x) => (
                  <span key={x.task_id} className={`fxs-dot p${personIndex(x.owner_login)}`} />
                ))}
              </span>
              <span className="fxs-n">{list.length}</span>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <>
      <div className="fxband-bar">
        <span className="fxband-title">{t("factory.title")}</span>
        {summary}
        {compact ? null : <span className="fxband-legend">{t("factory.legend")}</span>}
        {hidden > 0 ? (
          <span className="fxband-hidden" data-factory-hidden="" title={t("factory.hiddenTitle")}>
            {t("factory.hidden", { n: hidden })}
          </span>
        ) : null}
        {narrow || !pipSupported() ? null : (
          <button
            type="button"
            className="fxband-toggle fxband-pip"
            data-factory-pip=""
            title={t("factory.pipTitle")}
            onClick={pip.open}
          >
            {t("factory.pip")}
          </button>
        )}
        {narrow ? null : (
          <button
            type="button"
            className="fxband-toggle"
            data-factory-toggle=""
            aria-expanded={!collapsed}
            title={t("factory.toggleTitle")}
            onClick={toggle}
          >
            {collapsed ? t("factory.expand") : t("factory.collapse")}
          </button>
        )}
      </div>
      {compact ? null : <FactoryScene data={data} onSelect={props.onSelect} />}
    </>
  );
}
