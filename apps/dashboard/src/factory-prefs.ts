/**
 * 工場の帯の好み（たたむ / 広げる）。遅延読み込みのチャンクだけが使う（本体の容量を増やさない）。
 * 保存が無いときは null（画面の高さで決める。factory.ts の expandsByDefault）。localStorage が無くても動く。
 */
export const FACTORY_PREF_KEY = "rovo.dashboard.factoryCollapsed";
export type FactoryPref = "collapsed" | "expanded";

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadFactoryPref(
  storage: Storage | undefined = defaultStorage(),
): FactoryPref | null {
  try {
    const v = storage?.getItem(FACTORY_PREF_KEY);
    return v === "1" ? "collapsed" : v === "0" ? "expanded" : null;
  } catch {
    return null;
  }
}

export function saveFactoryPref(
  pref: FactoryPref,
  storage: Storage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(FACTORY_PREF_KEY, pref === "collapsed" ? "1" : "0");
  } catch {
    // 保存できなくても動く
  }
}
