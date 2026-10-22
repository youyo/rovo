/** 画面の設定（自動更新の入切）。localStorage に保存するが、無くても動く（すべて try/catch）。 */

const KEY = "rovo.dashboard.autoRefresh";

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
