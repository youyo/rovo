import { useSyncExternalStore } from "react";

/**
 * コンソールを左右半分ずつに並べる幅（CI のペインをログの隣に出す）。ビューポートの幅で判定する。
 * これより狭いとき（720px 未満のモバイルを含む）は「コンソール / CI」のタブで切り替える。
 */
export const WIDE_QUERY = "(min-width: 1280px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(WIDE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(WIDE_QUERY).matches;
}

/** 左右に並べられる幅か。matchMedia が無い環境（SSR・古いテスト環境）はタブにする */
export function useWide(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
