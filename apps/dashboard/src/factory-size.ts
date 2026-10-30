import { loadFactoryPref } from "./factory-prefs";

/**
 * 工場の帯の大きさ（本体と工場のチャンクの両方が使う。本体は読み込み中の枠の高さを、既定の状態と同じだけ確保する）。
 */

/** 断面図の座標系（横長の 2 階建て。1440px の幅で 1:1） */
export const SCENE = { w: 1440, h: 280 } as const;
/** 断面図の最大の幅（とても広い画面では、これ以上は拡大せず中央に置く） */
export const SCENE_MAX_W = 1540;

/** 帯の幅のときの断面図の高さ（幅に合わせて縮み、SCENE_MAX_W より広くはしない） */
export function stageHeight(width: number): number {
  return (Math.min(width, SCENE_MAX_W) * SCENE.h) / SCENE.w;
}

/**
 * 保存した好みが無いとき、最初から広げるか。広げてもレールとコンソール（.main）に 700px が残る画面だけ広げる
 * （ヘッダ 51 + 帯の見出し 34 + ステータスバー 42 + .main 700 = 827）。それより低い画面は最初は人数の 1 行
 */
export function expandsByDefault(width: number, height: number): boolean {
  return height - stageHeight(width) >= 827;
}

/** 帯を最初にたたむか（保存した好みが優先。無ければ画面の大きさ） */
export function initialCollapsed(): boolean {
  const pref = loadFactoryPref();
  if (pref !== null) return pref === "collapsed";
  if (typeof window === "undefined") return true;
  return !expandsByDefault(window.innerWidth, window.innerHeight);
}
