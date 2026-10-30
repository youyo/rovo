import type { OverviewDto } from "@rovo/dashboard-contract";
import { useState } from "react";
import { expandsByDefault, type FACTORY_ROOMS, groupFactory, personIndex } from "./factory";
import { type FactoryKey, useFactoryT } from "./factory-i18n";
import { loadFactoryPref, saveFactoryPref } from "./factory-prefs";
import FactoryScene from "./factory-scene";
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

/** 保存した好みが無いときの既定（広げてもコンソールに高さが残る画面だけ広げる） */
function initialCollapsed(): boolean {
  const pref = loadFactoryPref();
  if (pref !== null) return pref === "collapsed";
  if (typeof window === "undefined") return true;
  return !expandsByDefault(window.innerWidth, window.innerHeight);
}

/**
 * 工場の帯の中身（docs/specs/dashboard-factory.md）。遅延読み込みのチャンク（本体は枠の section だけ）。
 * 広げると工場の断面図、たたむと部屋ごとの人数の 1 行。背の低い画面は最初はたたむ（保存した好みが優先）。
 * 狭い幅（720px 以下）は断面図を出さず、たたんだときと同じ 1 行。見えないタスクは件数だけ。
 */
export default function FactoryPanel(props: {
  data: OverviewDto;
  onSelect?: (id: string) => void;
}) {
  const { data } = props;
  const t = useFactoryT();
  const narrow = useNarrow();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const compact = narrow || collapsed;
  const hidden = data.month.hidden_tasks.count;
  const toggle = () => {
    setCollapsed(!collapsed);
    saveFactoryPref(collapsed ? "expanded" : "collapsed");
  };
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
