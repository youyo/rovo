import { DEFAULT_LANG, isLang, type Lang } from "./i18n";

/** 画面の設定（自動更新の入切・言語）。localStorage に保存するが、無くても動く（すべて try/catch）。 */

const KEY = "rovo.dashboard.autoRefresh";
/** 言語（"en" | "ja"）の保存先。ブラウザの言語は見ない */
export const LANG_KEY = "rovo.dashboard.lang";

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** 既定は入。保存された値が "0" のときだけ切。 */
export function loadAutoRefresh(storage: Storage | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveAutoRefresh(
  on: boolean,
  storage: Storage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(KEY, on ? "1" : "0");
  } catch {
    // 保存できなくても動く
  }
}

/** 保存された言語。無い・未知の値・読み出しが投げるときは英語（既定）。 */
export function loadLang(storage: Storage | undefined = defaultStorage()): Lang {
  try {
    const v = storage?.getItem(LANG_KEY);
    return isLang(v) ? v : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

export function saveLang(lang: Lang, storage: Storage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(LANG_KEY, lang);
  } catch {
    // 保存できなくても動く
  }
}
