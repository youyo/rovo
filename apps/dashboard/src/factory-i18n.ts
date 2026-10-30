import type { Key, Lang, Params } from "./i18n";
import { useLang } from "./lang";

/**
 * 工場の断面図（遅延読み込みのチャンク）だけが使う文言。帯の名前・部屋の名前など本体でも使う文言は i18n.ts にある。
 * 本体の容量を増やさないよう、断面図の中の文言はチャンクに置く。i18n.ts と同じく en が正で、ja は同じキー集合を型で強制する。
 */
const en = {
  "factory.collapse": "Collapse",
  "factory.expand": "Expand",
  "factory.toggleTitle": "Collapse the factory to one line of head counts per room",
  "factory.hidden": "{n} hidden",
  "factory.hiddenTitle": "Tasks in repositories you can't see this month are counted, not shown",
  "factory.legend": "Antenna light = person, badge = initial",
  "factory.summaryAria": "Robots per room",
  "factory.prep": "Prep",
  "factory.code": "Coding",
  "factory.verify": "Verify",
  "factory.review": "Review",
  "factory.ready": "Ready",
  "factory.wait": "Waiting",
  "factory.research": "Research",
  "factory.shipped": "Shipped",
  "factory.sceneAria": "Factory floor. Each robot is a task",
  "factory.bot": "{title} ({login}, {room})",
  "factory.more": "+{n}",
  "factory.to": "→ {room}",
  "factory.prepSub": "clone",
  "factory.codeSub": "edit, commit",
  "factory.verifySub": "tests",
  "factory.reviewSub": "diff",
  "factory.readySub": "for you",
  "factory.waitSub": "questions, budget",
  "factory.researchSub": "web, safety",
  "factory.control": "Control",
  "factory.controlSub": "monitor",
  "factory.shippedN": "{n} shipped",
  "factory.mapPrep": "Prep",
  "factory.mapCode": "Code",
  "factory.mapVerify": "Test",
  "factory.mapReview": "Revw",
  "factory.mapReady": "Ready",
  "factory.mapWait": "Ask",
  "factory.mapResearch": "Web",
  "factory.mapShipped": "Ship",
  "factory.budget": "Monthly budget",
  "factory.safety": "SAFETY FIRST",
  "factory.dock": "GitHub dock",
  "factory.call": "Calling",
  "factory.inspect": "Inspect",
};
export type FactoryKey = keyof typeof en;

const ja: Record<FactoryKey, string> = {
  "factory.collapse": "たたむ",
  "factory.expand": "広げる",
  "factory.toggleTitle": "工場をたたんで、部屋ごとの人数の 1 行にする",
  "factory.hidden": "見えない {n} 件",
  "factory.hiddenTitle": "今月の、権限の無いリポジトリのタスクは工場に入れず、件数だけ出します",
  "factory.legend": "アンテナの光が人の色、バッジが頭文字",
  "factory.summaryAria": "部屋ごとの Rovo の数",
  "factory.prep": "準備",
  "factory.code": "コーディング",
  "factory.verify": "検証",
  "factory.review": "レビュー",
  "factory.ready": "Ready",
  "factory.wait": "返事待ち",
  "factory.research": "調査室",
  "factory.shipped": "出荷",
  "factory.sceneAria": "工場の断面図。Rovo 1 体が 1 タスク",
  "factory.bot": "{title}（{login}・{room}）",
  "factory.more": "+{n}",
  "factory.to": "{room}へ",
  "factory.prepSub": "clone",
  "factory.codeSub": "編集・commit",
  "factory.verifySub": "テスト",
  "factory.reviewSub": "差分",
  "factory.readySub": "確認待ち",
  "factory.waitSub": "質問・予算の延長",
  "factory.researchSub": "web と安全判定",
  "factory.control": "管制室",
  "factory.controlSub": "工場の監視",
  "factory.shippedN": "{n} 件",
  "factory.mapPrep": "準備",
  "factory.mapCode": "実装",
  "factory.mapVerify": "検証",
  "factory.mapReview": "レビュー",
  "factory.mapReady": "Ready",
  "factory.mapWait": "返事",
  "factory.mapResearch": "調査",
  "factory.mapShipped": "出荷",
  "factory.budget": "今月の予算",
  "factory.safety": "安全第一",
  "factory.dock": "GitHub 出荷口",
  "factory.call": "お呼び出し",
  "factory.inspect": "検品待ち",
};

export const FACTORY_DICTS: Record<Lang, Record<FactoryKey, string>> = { en, ja };

/** 断面図の t。工場の文言はこの辞書、それ以外（部屋の名前など）は本体の t。差し込みは本体の t と同じく 1 回だけ */
export type FT = (key: Key | FactoryKey, params?: Params) => string;

export function useFactoryT(): FT {
  const { lang, t } = useLang();
  const dict = FACTORY_DICTS[lang];
  return (key, params) => {
    if (!Object.hasOwn(dict, key)) return t(key as Key, params);
    const template = dict[key as FactoryKey];
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (m, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : m,
    );
  };
}
