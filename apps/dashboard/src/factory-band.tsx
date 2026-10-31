import type { OverviewDto } from "@rovo/dashboard-contract";
import { lazy, Suspense } from "react";
import { initialCollapsed } from "./factory-size";
import { useT } from "./lang";
import { useNarrow } from "./use-narrow";

/** 帯の中身（人数の 1 行・断面図）は遅延読み込みの別チャンク（factory-panel-*.js / .css。dist の容量の上限は別枠） */
const FactoryPanel = lazy(() => import("./factory-panel"));

/**
 * 今日の一覧の上部の帯「Rovo の工場」の枠。中身はチャンクと一覧が届いてから描く。
 * それまでは、中身が描かれたときと同じ高さ（たたむ既定なら見出しの 1 行、広げる既定なら + 断面図）の空の枠を出し、
 * 読み込みの前後で帯の下（レールとコンソール）を動かさない。data が null（一覧がまだ）でも枠は出す
 */
export function FactoryBand(props: { data: OverviewDto | null; onSelect?: (id: string) => void }) {
  const t = useT();
  const narrow = useNarrow();
  const wait = (
    <div
      className={narrow || initialCollapsed() ? "fxband-wait" : "fxband-wait fxband-wait--open"}
    />
  );
  return (
    <section className="fxband" data-factory="" aria-label={t("factory.title")}>
      {props.data === null ? (
        wait
      ) : (
        <Suspense fallback={wait}>
          <FactoryPanel data={props.data} onSelect={props.onSelect} />
        </Suspense>
      )}
    </section>
  );
}
