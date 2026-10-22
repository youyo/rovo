/** コンソールの画面の末尾への追従。純関数（DOM の寸法を渡す）。 */

/** 一番下からこの px 以内なら「末尾にいる」とみなす（小数の丸めと、慣性スクロールの揺れを許す） */
export const FOLLOW_THRESHOLD = 24;

export type ScrollBox = { scrollHeight: number; clientHeight: number; scrollTop: number };

/** 末尾にいるか。新しい行が来たとき、末尾にいるなら追従し、上へ読みに行っているなら動かさない。 */
export function isNearBottom(box: ScrollBox, threshold: number = FOLLOW_THRESHOLD): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= threshold;
}
