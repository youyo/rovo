import type { OverviewDto } from "@rovo/dashboard-contract";
import { lazy, Suspense } from "react";
import { useT } from "./lang";

/** 帯の中身（人数の 1 行・断面図）は遅延読み込みの別チャンク（factory-panel-*.js / .css。dist の容量の上限は別枠） */
const FactoryPanel = lazy(() => import("./factory-panel"));

/** 今日の一覧の上部の帯「Rovo の工場」の枠。中身はチャンクが届いてから描く（それまでは見出しの高さの空の枠） */
export function FactoryBand(props: { data: OverviewDto; onSelect?: (id: string) => void }) {
  const t = useT();
  return (
    <section className="fxband" data-factory="" aria-label={t("factory.title")}>
      <Suspense fallback={<div className="fxband-wait" />}>
        <FactoryPanel data={props.data} onSelect={props.onSelect} />
      </Suspense>
    </section>
  );
}
