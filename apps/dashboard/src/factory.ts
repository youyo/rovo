import type { VisibleTaskDto } from "@rovo/dashboard-contract";

/**
 * 工場の帯（docs/specs/dashboard-factory.md）の純関数。React に依存しない。
 * 部屋の判定（stage → 部屋、stage が無いときは status と PR から）、部屋の定員と「定員 − 1 体 + +n」、
 * 人の色の番号、管制室のフロアマップの件数、工程が変わった Rovo の移動の差分。
 */

export type RoomId = "prep" | "code" | "verify" | "review" | "ready" | "wait" | "research";
/** Rovo のいる場所。shipped は外の出荷口（今日マージしたもの） */
export type Place = RoomId | "shipped";

export type RoomGeom = {
  id: RoomId;
  floor: 1 | 2;
  /** 断面図の座標（帯用の横長の座標系 SCENE。1440 × 280） */
  x: number;
  y: number;
  w: number;
  h: number;
};

export { expandsByDefault, SCENE, SCENE_MAX_W, stageHeight } from "./factory-size";

/** 部屋の並び（1 階は左から、2 階は左から）。管制室は Rovo を入れないので別 */
export const FACTORY_ROOMS: readonly RoomGeom[] = [
  { id: "prep", floor: 1, x: 16, y: 156, w: 220, h: 100 },
  { id: "code", floor: 1, x: 244, y: 156, w: 304, h: 100 },
  { id: "verify", floor: 1, x: 556, y: 156, w: 244, h: 100 },
  { id: "review", floor: 1, x: 808, y: 156, w: 204, h: 100 },
  { id: "ready", floor: 1, x: 1020, y: 156, w: 208, h: 100 },
  { id: "wait", floor: 2, x: 16, y: 50, w: 404, h: 96 },
  { id: "research", floor: 2, x: 428, y: 50, w: 404, h: 96 },
];
export const CONTROL_ROOM = { x: 840, y: 50, w: 388, h: 96 } as const;

/** Rovo 1 体の枠（幅・高さ・横の間隔） */
export const BOT_W = 54;
export const BOT_H = 62;
export const BOT_GAP = 6;

export function roomGeom(id: RoomId): RoomGeom {
  return FACTORY_ROOMS.find((r) => r.id === id) as RoomGeom;
}

/** 1 段に並ぶ数 */
export function perRow(id: RoomId): number {
  const r = roomGeom(id);
  return Math.max(1, Math.floor((r.w - 12 + BOT_GAP) / (BOT_W + BOT_GAP)));
}

/** 部屋の定員（Rovo は 1 段なので、横に並ぶ数） */
export function roomCapacity(id: RoomId): number {
  return perRow(id);
}

export function floorOf(place: Place): 1 | 2 {
  return place === "shipped" ? 1 : roomGeom(place).floor;
}

/** タスクのいる場所。工場に出さない（失敗・取り消し・閉じた PR・レビューの依頼など）ときは null */
export function roomOf(task: VisibleTaskDto): Place | null {
  if (task.kind === "review") return null;
  switch (task.stage) {
    case "merged":
      return "shipped";
    case "done":
      return null;
    case undefined:
      break;
    default:
      return task.stage;
  }
  switch (task.status) {
    case "CREATING":
      return "prep";
    case "RUNNING":
    case "RECOVERING":
      return "code";
    case "VERIFYING":
      return "verify";
    case "INPUT_REQUIRED":
      return "wait";
    case "COMPLETED": {
      const pr = task.pr;
      if (pr === null) return null;
      if (pr.merged || pr.state === "merged") return "shipped";
      if (pr.state === "closed") return null;
      return "ready";
    }
    default:
      return null;
  }
}

/** 人の色の数（トークン --person-0〜--person-5） */
export const PERSON_COLORS = 6;

/** 人の色の番号。ログイン名の FNV-1a で決める（見えた順に依存しない。7 人目以降・衝突は頭文字のバッジで区別） */
export function personIndex(login: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < login.length; i++) {
    h ^= login.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % PERSON_COLORS;
}

/** 頭文字のバッジ（大文字 1 字） */
export function initialOf(login: string): string {
  return (login[0] ?? "?").toUpperCase();
}

export type MoreShare = { login: string; person: number; n: number };
export type RoomLayout = {
  shown: VisibleTaskDto[];
  /** +n の n（0 なら出さない） */
  more: number;
  /** +n にまとめた分の、人ごとの件数（割合の帯。ログイン名の順） */
  moreShares: MoreShare[];
  /** +n にまとめたタスク（title の一覧に使う） */
  rest: VisibleTaskDto[];
};

/** 定員を超えたら 定員 − 1 体を出し、残りを +n のタイルにまとめる */
export function layoutRoom(tasks: readonly VisibleTaskDto[], capacity: number): RoomLayout {
  if (tasks.length <= capacity) return { shown: [...tasks], more: 0, moreShares: [], rest: [] };
  const keep = Math.max(0, capacity - 1);
  const rest = tasks.slice(keep);
  const tally = new Map<string, number>();
  for (const t of rest) tally.set(t.owner_login, (tally.get(t.owner_login) ?? 0) + 1);
  const moreShares = [...tally.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([login, n]) => ({ login, person: personIndex(login), n }));
  return { shown: tasks.slice(0, keep), more: rest.length, moreShares, rest };
}

export type FactoryGroups = { rooms: Record<RoomId, VisibleTaskDto[]>; shipped: VisibleTaskDto[] };

const order = (a: VisibleTaskDto, b: VisibleTaskDto): number =>
  a.owner_login < b.owner_login
    ? -1
    : a.owner_login > b.owner_login
      ? 1
      : a.created_at < b.created_at
        ? -1
        : a.created_at > b.created_at
          ? 1
          : a.task_id < b.task_id
            ? -1
            : a.task_id > b.task_id
              ? 1
              : 0;

/** 部屋ごとに分ける。並びは 人 → 作成時刻 → ID（ポーリングで入れ替わらない） */
export function groupFactory(tasks: readonly VisibleTaskDto[]): FactoryGroups {
  const rooms = Object.fromEntries(
    FACTORY_ROOMS.map((r) => [r.id, [] as VisibleTaskDto[]]),
  ) as Record<RoomId, VisibleTaskDto[]>;
  const shipped: VisibleTaskDto[] = [];
  for (const t of [...tasks].sort(order)) {
    const place = roomOf(t);
    if (place === null) continue;
    if (place === "shipped") shipped.push(t);
    else rooms[place].push(t);
  }
  return { rooms, shipped };
}

/** 管制室のフロアマップ（部屋ごとの人数 + 出荷） */
export function floorMap(tasks: readonly VisibleTaskDto[]): Record<Place, number> {
  const g = groupFactory(tasks);
  const out = Object.fromEntries(FACTORY_ROOMS.map((r) => [r.id, g.rooms[r.id].length])) as Record<
    Place,
    number
  >;
  out.shipped = g.shipped.length;
  return out;
}

export type Move = { from: Place; to: Place; crossFloor: boolean };

/** 前回の場所 → 今回の場所の移動。前回が無い・同じ場所・工場から出たときは null */
export function moveOf(prev: Place | undefined, next: Place | null): Move | null {
  if (prev === undefined || next === null || prev === next) return null;
  return { from: prev, to: next, crossFloor: floorOf(prev) !== floorOf(next) };
}
