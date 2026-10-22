import type { TaskDetailDto, TaskEventDto } from "@rovo/dashboard-contract";

/**
 * 開いたことのあるタスクの「最後の詳細」を、画面のメモリに少しだけ持つ（切り替えた瞬間に描くため）。
 * localStorage などには保存しない（ページを読み直すと空）。件数に上限があり、使われていないものから捨てる。
 * 描くための控えで、権限の根拠ではない: 取り直しが 401 / 404 なら捨てる。ログアウト・期限切れでは全部捨てる。
 */

export type CachedDetail = {
  detail: TaskDetailDto;
  /** seq の昇順・重複なし。新しい側の CACHED_EVENTS_MAX 件まで */
  events: TaskEventDto[];
  /** これより古いイベントが残っているか */
  hasOlder: boolean;
};

/** 残すタスクの数 */
export const DETAIL_CACHE_MAX = 8;
/** 1 タスクで残す events の数（events の 1 ページ分。「さらに読む」で増えた分は残さない） */
export const CACHED_EVENTS_MAX = 200;

export type DetailCache = {
  get(id: string): CachedDetail | undefined;
  set(id: string, value: CachedDetail): void;
  delete(id: string): void;
  clear(): void;
  readonly size: number;
};

export function createDetailCache(max: number = DETAIL_CACHE_MAX): DetailCache {
  // Map は挿入順を持つので、先頭がいちばん使われていないもの
  const map = new Map<string, CachedDetail>();
  return {
    get(id) {
      const hit = map.get(id);
      if (hit === undefined) return undefined;
      map.delete(id);
      map.set(id, hit);
      return hit;
    },
    set(id, value) {
      const cut = value.events.length - CACHED_EVENTS_MAX;
      const stored: CachedDetail =
        cut > 0
          ? { ...value, events: value.events.slice(cut), hasOlder: true }
          : { ...value, events: [...value.events] };
      map.delete(id);
      map.set(id, stored);
      while (map.size > max) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
    delete(id) {
      map.delete(id);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
