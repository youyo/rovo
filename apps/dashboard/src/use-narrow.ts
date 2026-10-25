import { useSyncExternalStore } from "react";

/** ヘッダーを 2 行に詰める幅（style.css の @media (max-width: 720px) と同じ値） */
export const NARROW_QUERY = "(max-width: 720px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

/** 狭い画面（720px 以下）か。matchMedia が無い環境（SSR・古いテスト環境）は広い画面として扱う */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
