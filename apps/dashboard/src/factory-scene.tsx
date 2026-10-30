import type { OverviewDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { isPlainLeftClick } from "./click";
import {
  BOT_GAP,
  BOT_H,
  BOT_W,
  CONTROL_ROOM,
  FACTORY_ROOMS,
  floorMap,
  floorOf,
  groupFactory,
  initialOf,
  layoutRoom,
  type MoreShare,
  moveOf,
  type Place,
  perRow,
  personIndex,
  type RoomGeom,
  type RoomId,
  roomCapacity,
} from "./factory";
import "./factory-scene.css";
import { type FT, useFactoryT } from "./factory-i18n";
import { singleLine } from "./format";
import { budgetLimit } from "./rail";
import { taskPath } from "./route";

/**
 * 工場の断面図（docs/specs/dashboard-factory.md。見本 Factory2 の案 A v5 を写したもの）。遅延読み込みの別チャンク。
 * 見本は位置と色をインラインの style で組んでいたが、ここでは位置を SVG の属性、色を factory-scene.css のクラス（トークン）で渡す
 * （CSP の style-src 'self'。style 属性と <style> 要素は作らない）。座標は見本の 1440 × 1000 の座標系のまま。
 * 待機の動作と背景の部品は CSS のアニメーション、工程が変わった Rovo の移動は Web Animations API（element.animate）。
 */

/** 断面図の見せる範囲（看板の上から地面まで） */
const VIEW = { x: 0, y: 36, w: 1440, h: 754 } as const;
/** 歩く通路の高さ（Rovo の枠の上端）。1 階と 2 階 */
const CORRIDOR: Record<1 | 2, number> = { 1: 654, 2: 312 };
/** エレベーターのかごの中の Rovo の左端 */
const LIFT_X = 1138;
/** 歩く速さ（座標 / ミリ秒） */
const SPEED = 0.22;

type Pose = "carry" | "type" | "press" | "scan" | "ask" | "rest";
const POSE: Record<RoomId, Pose> = {
  prep: "carry",
  code: "type",
  verify: "press",
  review: "scan",
  ready: "rest",
  wait: "ask",
  research: "scan",
};

const NAME_KEY = {
  prep: "factory.prep",
  code: "factory.code",
  verify: "factory.verify",
  review: "factory.review",
  ready: "factory.ready",
  wait: "factory.wait",
  research: "factory.research",
  shipped: "factory.shipped",
} as const;
const SUB_KEY = {
  prep: "factory.prepSub",
  code: "factory.codeSub",
  verify: "factory.verifySub",
  review: "factory.reviewSub",
  ready: "factory.readySub",
  wait: "factory.waitSub",
  research: "factory.researchSub",
} as const;
const MAP_KEY = {
  prep: "factory.mapPrep",
  code: "factory.mapCode",
  verify: "factory.mapVerify",
  review: "factory.mapReview",
  ready: "factory.mapReady",
  wait: "factory.mapWait",
  research: "factory.mapResearch",
  shipped: "factory.mapShipped",
} as const;

export const placeName = (p: Place, t: FT): string => t(NAME_KEY[p]);

/** 文字の幅の見積もり（SVG の文字は測らずに札の幅を決める。和文は 1 字 1em、英数字は 0.6em） */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? size : size * 0.6;
  return w;
}

type Spot = { x: number; y: number };
type Placed = { task: VisibleTaskDto; place: Place; at: Spot; pose: Pose | null; i: number };
type Tile = { room: RoomId; at: Spot; more: number; shares: MoreShare[]; rest: VisibleTaskDto[] };

/** 部屋の床に Rovo を並べる（下の段から詰め、各段は中央寄せ。見本の flex-wrap + align-content: flex-end と同じ） */
function floorSpots(r: RoomGeom, count: number): Spot[] {
  const n = perRow(r.id);
  const lines = Math.ceil(count / n);
  const bottom = r.y + r.h - 9;
  const inner = r.w - 16;
  const out: Spot[] = [];
  for (let i = 0; i < count; i++) {
    const line = Math.floor(i / n);
    const inLine = Math.min(n, count - line * n);
    const width = inLine * BOT_W + (inLine - 1) * BOT_GAP;
    const col = i % n;
    out.push({
      x: r.x + 8 + (inner - width) / 2 + col * (BOT_W + BOT_GAP),
      y: bottom - (lines - line) * BOT_H,
    });
  }
  return out;
}

/** 出荷口の箱の位置（トラックの荷台に 5 個ずつ 2 段） */
const SHIP_MAX = 10;
function shipSpot(i: number): Spot {
  return { x: 1262 + (i % 5) * 18, y: 646 + Math.floor(i / 5) * 18 };
}

export function placeFactory(tasks: readonly VisibleTaskDto[]): { bots: Placed[]; tiles: Tile[] } {
  const g = groupFactory(tasks);
  const bots: Placed[] = [];
  const tiles: Tile[] = [];
  for (const r of FACTORY_ROOMS) {
    const l = layoutRoom(g.rooms[r.id], roomCapacity(r.id));
    const spots = floorSpots(r, l.shown.length + (l.more > 0 ? 1 : 0));
    l.shown.forEach((task, i) => {
      bots.push({ task, place: r.id, at: spots[i] as Spot, pose: POSE[r.id], i });
    });
    if (l.more > 0) {
      const at = spots[l.shown.length] as Spot;
      tiles.push({ room: r.id, at, more: l.more, shares: l.moreShares, rest: l.rest });
      // +n にまとめた Rovo も、移動の起点・終点はタイルの位置
      for (const task of l.rest) bots.push({ task, place: r.id, at, pose: null, i: -1 });
    }
  }
  g.shipped.forEach((task, i) => {
    bots.push({ task, place: "shipped", at: shipSpot(Math.min(i, SHIP_MAX - 1)), pose: null, i });
  });
  return { bots, tiles };
}

/** 前の位置 → 今の位置の歩き方（今の位置からのずれの列）。階をまたぐときはエレベーターに乗る */
export function walkPath(from: Spot, to: Spot, fromPlace: Place, toPlace: Place): Spot[] {
  const a = floorOf(fromPlace);
  const b = floorOf(toPlace);
  const pts: Spot[] = [from, { x: from.x, y: CORRIDOR[a] }];
  if (a !== b) pts.push({ x: LIFT_X, y: CORRIDOR[a] }, { x: LIFT_X, y: CORRIDOR[b] });
  pts.push({ x: to.x, y: CORRIDOR[b] }, to);
  return pts;
}

function walk(el: Element, pts: Spot[], to: Spot): void {
  let total = 0;
  const dist = [0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] as Spot;
    const q = pts[i - 1] as Spot;
    total += Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
    dist.push(total);
  }
  if (total === 0) return;
  const frames = pts.map((p, i) => ({
    transform: `translate(${p.x - to.x}px, ${p.y - to.y}px)`,
    offset: (dist[i] as number) / total,
  }));
  el.classList.add("fx-walking");
  const anim = el.animate(frames, {
    duration: Math.min(9000, Math.max(1500, total / SPEED)),
    easing: "linear",
  });
  anim.onfinish = () => el.classList.remove("fx-walking");
  anim.oncancel = anim.onfinish;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 前回の場所を覚えて、場所が変わった Rovo だけ歩かせる（FLIP） */
function useWalks(bots: Placed[]) {
  const prev = useRef(new Map<string, { place: Place; at: Spot }>());
  const nodes = useRef(new Map<string, Element>());
  useLayoutEffect(() => {
    const motion = !reducedMotion();
    const next = new Map<string, { place: Place; at: Spot }>();
    for (const b of bots) {
      const id = b.task.task_id;
      next.set(id, { place: b.place, at: b.at });
      const old = prev.current.get(id);
      const move = moveOf(old?.place, b.place);
      const el = nodes.current.get(id);
      if (!motion || old === undefined || move === null || el === undefined) continue;
      if (typeof el.animate !== "function") continue;
      walk(el, walkPath(old.at, b.at, move.from, move.to), b.at);
    }
    prev.current = next;
  });
  return (id: string) => (el: Element | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  };
}

function botLabel(task: VisibleTaskDto, place: Place, t: FT): string {
  return t("factory.bot", {
    title: singleLine(task.title),
    login: singleLine(task.owner_login),
    room: placeName(place, t),
  });
}

/** 見本の Rovo（rvBody の symbol + 腕 + 工程ごとの道具）。色は人の色のクラス（.p0〜.p5 の .fx-pc） */
function Bot(props: { pose: Pose; login: string; dest: string }) {
  const { pose } = props;
  return (
    <>
      <svg
        className={`fx-bot fx-${pose}`}
        width={BOT_W}
        height={64}
        viewBox="-28 -34 156 166"
        overflow="visible"
        y={4}
        aria-hidden="true"
      >
        <ellipse className="fxa-halo fx-pc" cx={50} cy={118} rx={44} ry={9} />
        <g className="fxa-smoke">
          <circle className="f-m12" cx={88} cy={16} r={6} />
          <circle className="f-m13" cx={92} cy={12} r={5} />
        </g>
        <rect className="fx-foot fx-footL fxp f-m2" x={18} y={98} width={26} height={12} rx={5} />
        <rect className="fx-foot fx-footR fxp f-m2" x={58} y={98} width={26} height={12} rx={5} />
        {pose === "rest" ? (
          <rect
            className="fx-prop f-box s-olv"
            x={10}
            y={96}
            width={80}
            height={26}
            rx={3}
            strokeWidth="3"
          />
        ) : null}
        <g className="fx-body fxp">
          <use href="#fx-rvBody" x={-5} y={-10} width={110} height={110} />
          <circle className="fxa-halo fx-pc" cx={50} cy={-5} r={13} opacity=".35" />
          <circle className="fx-pc s-ol" cx={50} cy={-5} r={6.5} strokeWidth="3" />
          <circle className="f-wh" cx={48} cy={-7} r={2} opacity=".8" />
        </g>
        <g className="fx-armL fxp">
          <path className="s-ol" d="M20 62 L2 80" strokeWidth="8" strokeLinecap="round" />
          <path className="s-o1" d="M20 62 L2 80" strokeWidth="4" strokeLinecap="round" />
        </g>
        <g className="fx-armR fxp">
          <path className="s-ol" d="M80 60 L98 78" strokeWidth="8" strokeLinecap="round" />
          <path className="s-o1" d="M80 60 L98 78" strokeWidth="4" strokeLinecap="round" />
        </g>
        {pose === "type" ? (
          <g className="fx-prop">
            <rect className="f-m2" x={-16} y={84} width={132} height={8} rx={2} />
            <rect className="f-m6" x={-10} y={86} width={120} height={3} />
            <rect className="f-wood" x={-20} y={92} width={140} height={6} rx={2} />
            <rect className="f-wood2" x={-14} y={98} width={6} height={22} />
            <rect className="f-wood2" x={108} y={98} width={6} height={22} />
          </g>
        ) : null}
        {pose === "carry" ? (
          <g className="fx-prop fxa-load">
            <rect
              className="f-box s-olv"
              x={-6}
              y={70}
              width={44}
              height={30}
              rx={2}
              strokeWidth="3"
            />
            <path className="s-boxl" d="M-6 80 H38" strokeWidth="2" />
          </g>
        ) : null}
        {pose === "scan" ? (
          <g className="fx-prop fx-tool fxp">
            <path className="s-m5" d="M98 78 L112 56" strokeWidth="6" strokeLinecap="round" />
            <circle
              className="f-pale s-m2"
              cx={118}
              cy={46}
              r={14}
              fillOpacity=".7"
              strokeWidth="5"
            />
          </g>
        ) : null}
        {pose === "press" ? (
          <g className="fx-prop">
            <rect className="f-m5" x={90} y={88} width={26} height={30} rx={3} />
            <circle className="fxa-lamp f-ok s-ol" cx={103} cy={84} r={8} strokeWidth="3" />
          </g>
        ) : null}
        {pose === "ask" ? (
          <g className="fx-prop fx-sign fxp">
            <path className="s-wood2" d="M98 78 L104 30" strokeWidth="5" />
            <rect
              className="f-wh s-ol"
              x={84}
              y={-6}
              width={40}
              height={38}
              rx={5}
              strokeWidth="4"
            />
            <text
              className="fx-mono f-tk"
              x={104}
              y={25}
              textAnchor="middle"
              fontSize={30}
              fontWeight={700}
            >
              ?
            </text>
          </g>
        ) : null}
      </svg>
      <g className="fx-badge">
        <circle className="fx-pc s-wh" cx={9} cy={59} r={10} strokeWidth="2.5" />
        <text
          className="fx-mono fx-pi"
          x={9}
          y={63.5}
          textAnchor="middle"
          fontSize={12}
          fontWeight={700}
        >
          {initialOf(props.login)}
        </text>
      </g>
      <g className="fx-tag">
        <rect
          className="f-wh fx-ps"
          x={30 - (textWidth(props.dest, 13) + 14) / 2}
          y={-14}
          width={textWidth(props.dest, 13) + 14}
          height={18}
          rx={9}
          strokeWidth="2"
        />
        <text
          className="fx-sans f-tk"
          x={30}
          y={0}
          textAnchor="middle"
          fontSize={13}
          fontWeight={700}
        >
          {props.dest}
        </text>
      </g>
    </>
  );
}

/** 部屋の名前の札（名前・補足・人数） */
function Plate(props: { cx: number; y: number; name: string; sub: string; n: string }) {
  const nameW = textWidth(props.name, 20);
  const subW = textWidth(props.sub, 14);
  const nW = Math.max(26, textWidth(props.n, 16) + 14);
  const w = 16 + nameW + 10 + subW + 10 + nW + 12;
  const x = props.cx - w / 2;
  return (
    <g className="fx-plate">
      <rect className="f-m2" x={x} y={props.y} width={w} height={32} rx={6} />
      <rect className="f-ol" x={x} y={props.y + 32} width={w} height={3} rx={1.5} />
      <text className="fx-sans f-tw" x={x + 16} y={props.y + 23} fontSize={20} fontWeight={700}>
        {props.name}
      </text>
      <text className="fx-sans f-tl" x={x + 16 + nameW + 10} y={props.y + 22} fontSize={14}>
        {props.sub}
      </text>
      <rect className="f-y1" x={x + w - 12 - nW} y={props.y + 6} width={nW} height={20} rx={10} />
      <text
        className="fx-mono f-tk"
        x={x + w - 12 - nW / 2}
        y={props.y + 22}
        textAnchor="middle"
        fontSize={16}
        fontWeight={700}
      >
        {props.n}
      </text>
    </g>
  );
}

const ART: Record<RoomId, { w: number; h: number; el: ReactNode }> = {
  prep: {
    w: 170,
    h: 70,
    el: (
      <svg width={170} height={70} viewBox="0 0 170 70" aria-hidden="true" focusable="false">
        <rect className="f-hz s-olv" x={8} y={0} width={7} height={70} />
        <rect className="f-hz s-olv" x={8} y={0} width={150} height={7} />
        <path className="s-olv" d="M15 7 L40 7 L15 30" fill="none" strokeWidth="2" />
        <g className="fxa-trolley">
          <rect className="f-m5" x={96} y={7} width={16} height={8} />
          <g className="fxa-hook">
            <path className="s-m2" d="M104 15 V34" strokeWidth="2" />
            <path className="s-m2" d="M98 34 Q104 42 110 34" fill="none" strokeWidth="3" />
          </g>
        </g>
        <rect
          className="f-box s-olv"
          x={120}
          y={42}
          width={40}
          height={26}
          rx={2}
          strokeWidth="2"
        />
        <text className="fx-mono f-oink" x={140} y={59} textAnchor="middle" fontSize={10}>
          clone
        </text>
      </svg>
    ),
  },
  code: {
    w: 320,
    h: 70,
    el: (
      <svg width={320} height={70} viewBox="0 0 320 70" aria-hidden="true" focusable="false">
        <rect className="f-m2" x={0} y={0} width={74} height={70} rx={3} />
        <g className="f-led">
          <circle className="fxa-led" cx={10} cy={10} r={2.5} />
          <circle cx={10} cy={26} r={2.5} />
          <circle className="fxa-halo" cx={10} cy={42} r={2.5} />
          <circle className="fxa-led fxa-l2" cx={10} cy={58} r={2.5} />
        </g>
        <path className="s-m5" d="M20 10 H66 M20 26 H66 M20 42 H66 M20 58 H66" strokeWidth="5" />
        <text className="fx-mono f-tl" x={37} y={68} textAnchor="middle" fontSize={8}>
          AI Gateway
        </text>
        <path
          className="s-cop2"
          d="M74 30 C120 30 110 60 160 60 L320 60"
          fill="none"
          strokeWidth="3"
          strokeDasharray="6 5"
        />
        <rect className="f-m1 s-m5" x={96} y={4} width={96} height={40} rx={3} strokeWidth="2" />
        <path
          className="s-blue"
          d="M104 14 H150 M104 22 H172 M104 30 H136 M104 38 H164"
          strokeWidth="2.5"
        />
        <rect className="f-m1 s-m5" x={206} y={4} width={96} height={40} rx={3} strokeWidth="2" />
        <path
          className="s-led"
          d="M214 14 H260 M214 22 H240 M214 30 H286 M214 38 H250"
          strokeWidth="2.5"
        />
        <rect className="fxa-cur f-blue" x={168} y={35} width={5} height={6} />
        <rect className="fxa-cur f-led fxdm_5" x={254} y={35} width={5} height={6} />
      </svg>
    ),
  },
  verify: {
    w: 200,
    h: 70,
    el: (
      <svg width={200} height={70} viewBox="0 0 200 70" aria-hidden="true" focusable="false">
        <rect className="f-m13 s-m5" x={10} y={0} width={180} height={58} rx={8} strokeWidth="2" />
        <rect
          className="f-pale s-m8"
          x={22}
          y={10}
          width={110}
          height={38}
          rx={4}
          strokeWidth="2"
        />
        <path className="s-m5" d="M32 20 H60 M32 29 H88 M32 38 H70" strokeWidth="2.5" />
        <path className="s-ok" d="M100 22 L108 30 L122 16" fill="none" strokeWidth="3" />
        <rect className="f-m8" x={32} y={42} width={84} height={3} />
        <rect className="fxa-prog f-ok" x={32} y={42} width={84} height={3} />
        <g className="fxa-gear">
          <circle
            className="f-m8 s-m6"
            cx={70}
            cy={64}
            r={5}
            strokeWidth="4"
            strokeDasharray="2.5 2.5"
          />
        </g>
        <g className="fxa-gear fxa-rev">
          <circle
            className="f-m9 s-m6"
            cx={84}
            cy={64}
            r={4}
            strokeWidth="3.5"
            strokeDasharray="2.2 2.2"
          />
        </g>
        <circle className="f-ok" cx={152} cy={16} r={7} />
        <circle className="f-red fxa-halo" cx={172} cy={16} r={7} />
        <rect className="f-m2" x={144} y={32} width={36} height={16} rx={3} />
        <text className="fx-mono f-tw" x={162} y={44} textAnchor="middle" fontSize={9}>
          TEST
        </text>
        <rect className="f-m5" x={20} y={58} width={10} height={12} />
        <rect className="f-m5" x={170} y={58} width={10} height={12} />
      </svg>
    ),
  },
  review: {
    w: 140,
    h: 70,
    el: (
      <svg width={140} height={70} viewBox="0 0 140 70" aria-hidden="true" focusable="false">
        <path
          className="s-m6"
          d="M14 70 L14 18 Q14 4 28 4 L112 4 Q126 4 126 18 L126 70"
          fill="none"
          strokeWidth="8"
        />
        <path
          className="s-m9"
          d="M14 70 L14 18 Q14 4 28 4 L112 4 Q126 4 126 18 L126 70"
          fill="none"
          strokeWidth="3"
        />
        <rect className="f-wh s-m8" x={44} y={14} width={52} height={30} rx={3} strokeWidth="2" />
        <path className="s-ok" d="M50 22 H70 M50 29 H90 M50 36 H64" strokeWidth="2" />
        <path className="s-red" d="M74 22 H88" strokeWidth="2" />
        <rect className="fxa-beam f-blue" x={30} y={8} width={8} height={62} opacity=".22" />
      </svg>
    ),
  },
  ready: { w: 160, h: 70, el: null },
  wait: { w: 340, h: 46, el: null },
  research: {
    w: 340,
    h: 46,
    el: (
      <svg width={340} height={46} viewBox="0 0 340 46" aria-hidden="true" focusable="false">
        <rect className="f-m13 s-m8" x={0} y={0} width={110} height={46} rx={3} strokeWidth="2" />
        <g>
          <rect className="f-blue2" x={6} y={6} width={8} height={16} />
          <rect className="f-amb" x={16} y={8} width={8} height={14} />
          <rect className="f-teal" x={26} y={6} width={8} height={16} />
          <rect className="f-vio" x={36} y={9} width={8} height={13} />
          <rect className="f-m8" x={46} y={6} width={8} height={16} />
          <rect className="f-pink" x={56} y={7} width={8} height={15} />
          <rect className="f-m8" x={6} y={26} width={8} height={15} />
          <rect className="f-blue2" x={16} y={26} width={8} height={15} />
          <rect className="f-amb" x={26} y={28} width={8} height={13} />
          <rect className="f-teal" x={36} y={26} width={8} height={15} />
          <rect className="f-m1" x={70} y={10} width={34} height={28} rx={2} />
          <path className="s-blue" d="M74 18 H96 M74 24 H90 M74 30 H98" strokeWidth="2" />
        </g>
        <rect className="f-wh s-m8" x={150} y={6} width={120} height={34} rx={4} strokeWidth="2" />
        <circle className="fxa-seq f-ok" cx={166} cy={23} r={6} />
        <circle className="fxa-seq fxa-s2 f-gold" cx={184} cy={23} r={6} />
        <circle className="fxa-seq fxa-s3 f-red" cx={202} cy={23} r={6} />
        <text
          className="fx-mono f-tg"
          x={236}
          y={27}
          textAnchor="middle"
          fontSize={11}
          fontWeight={700}
        >
          Clef
        </text>
        <path className="f-m6" d="M300 46 L316 46 L308 30 Z" />
        <path className="f-m12 s-m5" d="M290 30 A22 22 0 0 1 330 14" strokeWidth="3" />
        <circle className="f-flame fxa-halo" cx={322} cy={8} r={3} />
      </svg>
    ),
  },
};

function RoomArt(props: { id: RoomId; t: FT }) {
  const { id, t } = props;
  if (id === "wait")
    return (
      <svg width={340} height={46} viewBox="0 0 340 46" aria-hidden="true" focusable="false">
        <rect className="f-m14 s-m5" x={298} y={0} width={38} height={46} rx={3} strokeWidth="2" />
        <rect className="f-red" x={300} y={2} width={34} height={8} />
        <g>
          <rect className="f-blue2" x={303} y={14} width={5} height={9} />
          <rect className="f-amb" x={310} y={14} width={5} height={9} />
          <rect className="f-teal" x={317} y={14} width={5} height={9} />
          <rect className="f-pink" x={324} y={14} width={5} height={9} />
          <rect className="f-vio" x={303} y={26} width={5} height={9} />
          <rect className="f-flame" x={310} y={26} width={5} height={9} />
          <rect className="f-m8" x={317} y={26} width={5} height={9} />
          <rect className="f-blue2" x={324} y={26} width={5} height={9} />
        </g>
        <rect className="f-m2" x={306} y={38} width={22} height={5} />
        <rect className="f-clay" x={86} y={30} width={12} height={14} />
        <circle className="f-g3" cx={92} cy={24} r={8} />
        <circle className="f-g4" cx={86} cy={20} r={5} />
        <rect className="f-wh s-m8" x={10} y={4} width={70} height={30} rx={3} strokeWidth="2" />
        <text className="fx-sans f-tg" x={45} y={24} textAnchor="middle" fontSize={11}>
          {t("factory.call")}
        </text>
        <rect className="f-wood" x={100} y={30} width={190} height={7} rx={3} />
        <rect className="f-wood2" x={108} y={37} width={5} height={9} />
        <rect className="f-wood2" x={276} y={37} width={5} height={9} />
        <circle className="f-amb s-olv" cx={250} cy={20} r={8} strokeWidth="2" />
        <rect className="f-olv" x={246} y={27} width={8} height={3} />
        <rect className="f-pale s-m8" x={150} y={12} width={40} height={18} rx={2} />
        <path className="s-m8" d="M170 12 V30" />
      </svg>
    );
  if (id === "ready")
    return (
      <svg width={160} height={70} viewBox="0 0 160 70" aria-hidden="true" focusable="false">
        <rect className="f-wood" x={0} y={62} width={160} height={8} />
        <rect className="f-box s-olv" x={4} y={34} width={40} height={28} rx={2} strokeWidth="2" />
        <path className="s-boxl" d="M4 44 H44" />
        <rect className="f-box s-olv" x={48} y={34} width={40} height={28} rx={2} strokeWidth="2" />
        <rect className="f-box s-olv" x={26} y={6} width={40} height={28} rx={2} strokeWidth="2" />
        <text
          className="fx-mono f-oink"
          x={46}
          y={24}
          textAnchor="middle"
          fontSize={10}
          fontWeight={700}
        >
          PR
        </text>
        <rect className="f-wh s-m8" x={100} y={20} width={54} height={40} rx={3} strokeWidth="2" />
        <text className="fx-sans f-tg" x={127} y={38} textAnchor="middle" fontSize={10}>
          {t("factory.inspect")}
        </text>
        <path className="s-ok" d="M110 48 H144" strokeWidth="2" />
      </svg>
    );
  return <>{ART[id].el}</>;
}

/** 背景（空・山・街・屋根・レンガ・床・配管・クレーン・エレベーターの竪穴・出荷口・看板）。見本の静的な SVG */
function Backdrop(props: { t: FT }) {
  const { t } = props;
  return (
    <>
      <rect x={0} y={0} width={1440} height={1000} fill="url(#fx-skyG)" />
      <g className="fxa-cloud f-cloud" opacity=".8">
        <ellipse cx={180} cy={104} rx={70} ry={16} />
        <ellipse cx={225} cy={94} rx={40} ry={14} />
        <ellipse cx={1290} cy={150} rx={80} ry={18} />
        <ellipse cx={1335} cy={138} rx={44} ry={15} />
        <ellipse cx={870} cy={84} rx={54} ry={12} />
      </g>
      <path
        className="f-hill"
        d="M0 230 L80 196 L170 222 L260 180 L360 214 L470 186 L560 210 L700 176 L820 206 L940 182 L1060 210 L1180 186 L1290 214 L1380 192 L1440 206 L1440 330 L0 330 Z"
      />
      <g className="f-city">
        <rect x={1236} y={400} width={34} height={120} />
        <rect x={1274} y={370} width={26} height={150} />
        <rect x={1304} y={420} width={40} height={100} />
        <rect x={1348} y={390} width={22} height={130} />
        <rect x={1374} y={430} width={44} height={90} />
      </g>
      <g className="f-cwin">
        <rect x={1282} y={384} width={4} height={4} />
        <rect x={1290} y={384} width={4} height={4} />
        <rect x={1282} y={396} width={4} height={4} />
        <rect x={1352} y={404} width={4} height={4} />
        <rect x={1360} y={404} width={4} height={4} />
        <rect x={1244} y={414} width={4} height={4} />
      </g>
      <g>
        <circle className="f-tree" cx={1262} cy={560} r={26} />
        <circle className="f-tree2" cx={1288} cy={548} r={30} />
        <rect className="f-trunk" x={1282} y={570} width={6} height={40} />
        <circle className="f-tree" cx={1400} cy={556} r={28} />
        <rect className="f-trunk" x={1397} y={574} width={6} height={36} />
      </g>

      <rect className="f-m11" x={0} y={776} width={1440} height={224} />
      <rect className="f-m9" x={0} y={776} width={1440} height={8} />
      <rect className="f-m7" x={1220} y={790} width={220} height={30} />
      <path
        className="s-m14"
        d="M1230 805 H1260 M1280 805 H1310 M1330 805 H1360 M1380 805 H1410"
        strokeWidth="3"
      />

      <g>
        <rect className="f-m6" x={104} y={20} width={10} height={70} />
        <rect className="f-m6" x={150} y={20} width={10} height={70} />
        <path className="s-m6" d="M104 60 L160 40 M160 60 L104 40" strokeWidth="3" />
        <rect className="f-m8 s-m5" x={92} y={-6} width={80} height={34} rx={6} strokeWidth="2" />
        <path className="s-m7" d="M92 4 H172 M92 14 H172" strokeWidth="2" />
        <text
          className="fx-mono f-tw"
          x={132}
          y={18}
          textAnchor="middle"
          fontSize={10}
          fontWeight={700}
        >
          H2O
        </text>
      </g>
      <g>
        <rect
          className="s-bredge"
          x={1044}
          y={10}
          width={26}
          height={96}
          fill="url(#fx-brick)"
          strokeWidth="2"
        />
        <rect className="f-m13" x={1044} y={18} width={26} height={8} />
        <rect
          className="s-bredge"
          x={1088}
          y={34}
          width={22}
          height={72}
          fill="url(#fx-brick)"
          strokeWidth="2"
        />
        <rect className="f-m13" x={1088} y={40} width={22} height={7} />
        <circle className="fxa-stack f-m12" cx={1060} cy={0} r={10} />
        <circle className="fxa-stack fxa-s2 f-m13" cx={1052} cy={2} r={8} />
        <circle className="fxa-stack f-m12" cx={1102} cy={24} r={8} />
        <circle className="fxa-stack fxa-s2 f-m13" cx={1096} cy={26} r={6} />
      </g>

      <g>
        <path
          className="s-m4"
          d="M24 164 L24 120 L124 92 L124 120 L224 92 L224 120 L324 92 L324 120 L424 92 L424 120 L524 92 L524 120 L624 92 L624 120 L724 92 L724 120 L824 92 L824 120 L924 92 L924 120 L1024 92 L1024 120 L1124 92 L1124 120 L1224 92 L1224 164 Z"
          fill="url(#fx-roofG)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <g className="s-m4" fill="url(#fx-glassG)" strokeWidth="1.5">
          <rect x={116} y={94} width={8} height={26} />
          <rect x={216} y={94} width={8} height={26} />
          <rect x={316} y={94} width={8} height={26} />
          <rect x={416} y={94} width={8} height={26} />
          <rect x={516} y={94} width={8} height={26} />
          <rect x={616} y={94} width={8} height={26} />
          <rect x={716} y={94} width={8} height={26} />
          <rect x={816} y={94} width={8} height={26} />
          <rect x={916} y={94} width={8} height={26} />
          <rect x={1016} y={94} width={8} height={26} />
          <rect x={1116} y={94} width={8} height={26} />
          <rect x={1216} y={94} width={8} height={26} />
        </g>
        <g className="s-m7" strokeWidth="1">
          <path d="M40 116 L110 97 M60 118 L114 104 M140 116 L210 97 M160 118 L214 104 M240 116 L310 97 M340 116 L410 97 M440 116 L510 97 M540 116 L610 97 M640 116 L710 97 M740 116 L810 97 M840 116 L910 97 M940 116 L1010 97 M1040 116 L1110 97 M1140 116 L1210 97" />
        </g>
        <rect className="f-wh s-m4" x={18} y={120} width={1212} height={44} strokeWidth="2" />
        <rect className="f-m11" x={18} y={156} width={1212} height={8} />
      </g>
      <g>
        <circle className="f-m8 s-m5" cx={300} cy={86} r={10} strokeWidth="2" />
        <rect className="f-m5" x={296} y={94} width={8} height={10} />
        <g className="fxa-fan">
          <path
            className="f-m5"
            d="M300 78 L302 86 L300 94 L298 86 Z M292 86 L300 84 L308 86 L300 88 Z"
          />
        </g>
        <circle className="f-m8 s-m5" cx={900} cy={86} r={10} strokeWidth="2" />
        <rect className="f-m5" x={896} y={94} width={8} height={10} />
        <g className="fxa-fan">
          <path
            className="f-m5"
            d="M900 78 L902 86 L900 94 L898 86 Z M892 86 L900 84 L908 86 L900 88 Z"
          />
        </g>
      </g>

      <rect
        className="s-bredge"
        x={24}
        y={164}
        width={1200}
        height={612}
        fill="url(#fx-brick)"
        strokeWidth="2"
      />
      <rect x={38} y={172} width={1172} height={226} fill="url(#fx-panel)" />
      <rect x={38} y={414} width={1172} height={346} fill="url(#fx-panel)" />
      <g fill="url(#fx-beamG)">
        <path d="M118 172 L150 172 L250 398 L190 398 Z" />
        <path d="M418 172 L450 172 L550 398 L490 398 Z" />
        <path d="M718 172 L750 172 L850 398 L790 398 Z" />
        <path d="M1018 172 L1050 172 L1150 398 L1090 398 Z" />
      </g>
      <rect x={24} y={398} width={1200} height={16} fill="url(#fx-rivet)" />
      <rect className="f-m2" x={24} y={398} width={1200} height={3} />
      <g>
        <rect className="f-pblue" x={38} y={178} width={1172} height={7} rx={3} />
        <rect className="f-m9" x={38} y={190} width={1172} height={5} rx={2} />
        <g className="f-m6">
          <rect x={200} y={176} width={8} height={11} />
          <rect x={520} y={176} width={8} height={11} />
          <rect x={840} y={176} width={8} height={11} />
          <rect x={1100} y={176} width={8} height={11} />
        </g>
        <rect className="f-cop" x={38} y={420} width={1172} height={7} rx={3} />
        <rect className="f-m9" x={38} y={432} width={1172} height={5} rx={2} />
        <g className="f-m6">
          <rect x={160} y={418} width={8} height={11} />
          <rect x={440} y={418} width={8} height={11} />
          <rect x={760} y={418} width={8} height={11} />
          <rect x={1080} y={418} width={8} height={11} />
        </g>
        <g>
          <path
            className="s-m5"
            d="M150 437 V462 M420 437 V462 M660 437 V462 M870 437 V462 M1040 437 V462"
            strokeWidth="2"
          />
          <g className="f-m3">
            <path d="M138 474 L162 474 L156 462 L144 462 Z" />
            <path d="M408 474 L432 474 L426 462 L414 462 Z" />
            <path d="M648 474 L672 474 L666 462 L654 462 Z" />
            <path d="M858 474 L882 474 L876 462 L864 462 Z" />
            <path d="M1028 474 L1052 474 L1046 462 L1034 462 Z" />
          </g>
          <g fill="url(#fx-coneG)">
            <path d="M140 474 L160 474 L210 700 L90 700 Z" />
            <path d="M410 474 L430 474 L520 700 L320 700 Z" />
            <path d="M650 474 L670 474 L740 700 L580 700 Z" />
            <path d="M860 474 L880 474 L930 700 L810 700 Z" />
            <path d="M1030 474 L1050 474 L1100 700 L980 700 Z" />
          </g>
        </g>
      </g>
      <rect className="f-g3" x={38} y={736} width={1172} height={24} />
      <path className="s-hz" d="M44 758 H1206" strokeWidth="2" />
      <g className="f-m6">
        <rect x={405} y={172} width={8} height={226} />
        <rect x={815} y={172} width={8} height={226} />
        <rect x={241} y={414} width={8} height={346} />
        <rect x={541} y={414} width={8} height={346} />
        <rect x={781} y={414} width={8} height={346} />
        <rect x={951} y={414} width={8} height={346} />
      </g>
      <g className="f-m4">
        <rect x={403} y={172} width={12} height={4} />
        <rect x={813} y={172} width={12} height={4} />
        <rect x={239} y={414} width={12} height={4} />
        <rect x={539} y={414} width={12} height={4} />
        <rect x={779} y={414} width={12} height={4} />
        <rect x={949} y={414} width={12} height={4} />
      </g>
      <g fill="url(#fx-hazard)">
        <rect x={239} y={722} width={12} height={38} />
        <rect x={539} y={722} width={12} height={38} />
        <rect x={779} y={722} width={12} height={38} />
        <rect x={949} y={722} width={12} height={38} />
      </g>
      <g className="f-red">
        <circle cx={100} cy={198} r={2.5} />
        <circle cx={260} cy={198} r={2.5} />
        <circle cx={460} cy={198} r={2.5} />
        <circle cx={640} cy={198} r={2.5} />
        <circle cx={900} cy={198} r={2.5} />
        <circle cx={1060} cy={198} r={2.5} />
        <circle cx={300} cy={440} r={2.5} />
        <circle cx={560} cy={440} r={2.5} />
        <circle cx={880} cy={440} r={2.5} />
      </g>
      <g className="s-red" fill="none" strokeWidth="2.5">
        <circle cx={340} cy={181} r={6} />
        <path d="M334 181 H346 M340 175 V187" />
        <circle cx={990} cy={423} r={6} />
        <path d="M984 423 H996 M990 417 V429" />
      </g>
      <g className="fx-mono f-wh" fontSize={7}>
        <text x={560} y={184}>
          AIR →
        </text>
        <text x={660} y={426}>
          WATER →
        </text>
      </g>
      <g
        className="fxa-flow s-wh"
        fill="none"
        strokeOpacity=".45"
        strokeWidth="2"
        strokeDasharray="4 16"
      >
        <path d="M40 181.5 H1208" />
        <path d="M40 423.5 H1208" />
      </g>
      <g>
        <path className="s-m5" d="M760 185 V190" strokeWidth="2" />
        <circle className="f-wh s-m2" cx={760} cy={196} r={7} strokeWidth="2" />
        <path className="fxa-needle s-red" d="M760 196 V191" strokeWidth="1.5" />
        <path className="s-m5" d="M380 427 V432" strokeWidth="2" />
        <circle className="f-wh s-m2" cx={380} cy={438} r={7} strokeWidth="2" />
        <path className="fxa-needle s-red fxdm2" d="M380 438 V433" strokeWidth="1.5" />
      </g>
      <g>
        <circle className="fxa-stack f-m10" cx={1236} cy={706} r={5} />
        <circle className="fxa-stack fxa-s2 f-m12" cx={1234} cy={708} r={4} />
      </g>
      <g className="fxa-crane">
        <rect
          className="f-hz s-olv"
          x={60}
          y={414}
          width={46}
          height={12}
          rx={2}
          strokeWidth="1.5"
        />
        <text
          className="fx-mono f-oink"
          x={83}
          y={423}
          textAnchor="middle"
          fontSize={7}
          fontWeight={700}
        >
          2t
        </text>
        <path className="s-m2" d="M83 426 V486" strokeWidth="1.5" />
        <rect className="f-m2" x={78} y={486} width={10} height={6} />
        <path className="s-m2" d="M77 494 Q83 504 89 494" fill="none" strokeWidth="3" />
      </g>
      <g>
        <rect
          className="f-wh s-ok"
          x={556}
          y={398}
          width={176}
          height={24}
          rx={2}
          strokeWidth="2"
        />
        <path className="s-ok" d="M568 410 H584 M576 402 V418" strokeWidth="5" />
        <text
          className="fx-sans f-ok"
          x={656}
          y={416}
          textAnchor="middle"
          fontSize={15}
          fontWeight={700}
          letterSpacing={6}
        >
          {t("factory.safety")}
        </text>
      </g>
      <g>
        <rect className="f-red" x={230} y={702} width={9} height={20} rx={3} />
        <rect className="f-m2" x={232} y={698} width={5} height={5} />
        <rect className="f-red" x={770} y={702} width={9} height={20} rx={3} />
        <rect className="f-m2" x={772} y={698} width={5} height={5} />
        <rect className="f-red" x={396} y={370} width={8} height={18} rx={3} />
        <rect className="f-m2" x={398} y={366} width={4} height={5} />
      </g>
      <g>
        <rect className="f-sand" x={44} y={374} width={360} height={20} opacity=".6" />
        <rect className="f-strip" x={414} y={374} width={400} height={20} opacity=".55" />
        <rect className="f-m10" x={824} y={374} width={296} height={20} opacity=".6" />
      </g>
      <rect className="f-m7" x={18} y={158} width={1212} height={6} rx={2} />
      <rect className="f-m8" x={14} y={164} width={7} height={612} />
      <rect className="f-m6" x={12} y={300} width={11} height={4} />
      <rect className="f-m6" x={12} y={520} width={11} height={4} />
      <rect className="f-m8" x={1226} y={164} width={7} height={440} />
      <rect className="f-m6" x={1224} y={300} width={11} height={4} />
      <g className="s-sol" strokeWidth="11" strokeLinecap="butt">
        <path d="M232 117 L316 95" />
        <path d="M332 117 L416 95" />
        <path d="M432 117 L516 95" />
      </g>
      <g className="s-sol2" strokeWidth="1">
        <path d="M250 116 L253 102 M270 111 L273 97 M290 106 L293 92 M350 116 L353 102 M370 111 L373 97 M390 106 L393 92 M450 116 L453 102 M470 111 L473 97 M490 106 L493 92" />
        <path
          className="s-sol3"
          d="M232 112 L316 90 M332 112 L416 90 M432 112 L516 90"
          opacity=".6"
        />
      </g>
      <g>
        <rect className="f-m10 s-m5" x={944} y={62} width={64} height={40} rx={3} strokeWidth="2" />
        <path className="s-m8" d="M950 70 H1002 M950 76 H1002 M950 82 H1002" />
        <circle className="f-m5" cx={992} cy={90} r={9} />
        <g className="fxa-fan">
          <path
            className="f-m10"
            d="M992 82 L994 90 L992 98 L990 90 Z M984 90 L992 88 L1000 90 L992 92 Z"
          />
        </g>
        <rect className="f-m5" x={952} y={102} width={6} height={8} />
        <rect className="f-m5" x={994} y={102} width={6} height={8} />
      </g>
      <path className="s-m5" d="M640 40 V14" strokeWidth="2" />
      <circle className="f-m5" cx={640} cy={13} r={2.5} />
      <g className="f-m3">
        <path d="M700 40 q4 -8 8 0 l6 -3 l-5 5 z" />
        <path d="M716 40 q4 -8 8 0 l6 -3 l-5 5 z" />
      </g>
      <g>
        <rect className="f-tower" x={1300} y={250} width={5} height={290} />
        <rect className="f-tower" x={1286} y={262} width={34} height={4} />
        <rect className="f-tower" x={1290} y={276} width={26} height={3} />
        <path
          className="s-m5"
          d="M1233 300 Q1266 318 1288 264 M1318 264 Q1380 296 1440 270 M1233 312 Q1270 330 1290 278 M1316 278 Q1380 306 1440 284"
          fill="none"
          strokeWidth="1"
        />
        <g className="f-m3">
          <path d="M1356 288 q3 -6 6 0 l4 -2 l-4 4 z" />
          <path d="M1370 290 q3 -6 6 0 l4 -2 l-4 4 z" />
        </g>
      </g>
      <g>
        <rect className="f-m8b" x={1320} y={300} width={14} height={80} />
        <rect className="f-m12" x={1320} y={306} width={14} height={5} />
        <circle className="fxa-stack f-m13" cx={1327} cy={292} r={8} />
        <circle className="fxa-stack fxa-s2 f-m14" cx={1324} cy={294} r={6} />
      </g>
      <use href="#fx-rvBody" x={1334} y={648} width={30} height={30} />
      <g>
        <path className="f-flame" d="M1236 776 L1242 760 L1248 776 Z" />
        <rect className="f-wh" x={1239} y={767} width={6} height={2} />
        <rect className="f-hz s-olv" x={1410} y={752} width={8} height={24} rx={3} />
      </g>
      <g>
        <rect className="f-m2" x={1224} y={712} width={10} height={20} />
      </g>
      <rect x={24} y={760} width={1200} height={16} fill="url(#fx-hazard)" />
      <g>
        <rect className="f-m11" x={1126} y={172} width={84} height={588} />
        <path
          className="s-m10"
          d="M1126 172 L1210 260 M1210 172 L1126 260 M1126 470 L1210 560 M1210 470 L1126 560 M1126 600 L1210 690 M1210 600 L1126 690"
          strokeWidth="2"
        />
        <rect className="f-m6" x={1126} y={172} width={5} height={588} />
        <rect className="f-m6" x={1205} y={172} width={5} height={588} />
        <rect x={1126} y={394} width={84} height={4} fill="url(#fx-hazard)" />
        <rect x={1126} y={736} width={84} height={4} fill="url(#fx-hazard)" />
        <g className="fx-mono" fontSize={9} fontWeight={700}>
          <rect className="f-m1" x={1134} y={206} width={22} height={13} rx={2} />
          <text className="f-y1" x={1145} y={216} textAnchor="middle">
            2F
          </text>
          <rect className="f-m1" x={1134} y={448} width={22} height={13} rx={2} />
          <text className="f-y1" x={1145} y={458} textAnchor="middle">
            1F
          </text>
        </g>
        <rect className="f-m8 s-m4" x={1140} y={96} width={56} height={24} rx={3} strokeWidth="2" />
        <g className="fxa-fan">
          <circle className="f-m5" cx={1168} cy={108} r={8} />
          <path className="s-m10" d="M1168 100 V116 M1160 108 H1176" strokeWidth="2" />
        </g>
        <text
          className="fx-mono f-tg"
          x={1168}
          y={92}
          textAnchor="middle"
          fontSize={8}
          fontWeight={700}
        >
          LIFT
        </text>
      </g>
      <rect x={1210} y={630} width={14} height={130} fill="url(#fx-panel)" />
      <g>
        <rect className="f-m6" x={1206} y={616} width={22} height={14} />
        <path className="s-m8" d="M1206 620 H1228 M1206 625 H1228" />
      </g>

      <rect className="f-m9" x={1224} y={700} width={200} height={76} />
      <rect className="f-hz" x={1224} y={700} width={200} height={6} />
      <g>
        <rect
          className="f-m14 s-m5"
          x={1244}
          y={618}
          width={128}
          height={78}
          rx={4}
          strokeWidth="2.5"
        />
        <rect className="f-m2" x={1246} y={620} width={10} height={74} />
        <path
          className="f-m12 s-m5"
          d="M1372 640 L1398 640 L1420 664 L1420 696 L1372 696 Z"
          strokeWidth="2.5"
        />
        <rect className="f-pale s-m5" x={1380} y={646} width={18} height={16} strokeWidth="1.5" />
        <circle className="f-m1" cx={1280} cy={700} r={12} />
        <circle className="f-m8" cx={1280} cy={700} r={5} />
        <circle className="f-m1" cx={1396} cy={700} r={12} />
        <circle className="f-m8" cx={1396} cy={700} r={5} />
        <text
          className="fx-mono f-tg"
          x={1316}
          y={638}
          textAnchor="middle"
          fontSize={11}
          fontWeight={700}
        >
          merge
        </text>
      </g>
      <g>
        <rect className="f-m1" x={1240} y={540} width={170} height={40} rx={6} />
        <text
          className="fx-sans f-tw"
          x={1325}
          y={566}
          textAnchor="middle"
          fontSize={15}
          fontWeight={700}
        >
          {t("factory.dock")}
        </text>
        <rect className="f-m5" x={1262} y={580} width={4} height={38} />
        <rect className="f-m5" x={1384} y={580} width={4} height={38} />
      </g>
      <g>
        <rect className="f-m5" x={1428} y={560} width={4} height={216} />
        <path className="s-m5" d="M1430 562 Q1430 552 1418 552" strokeWidth="4" fill="none" />
        <rect className="f-m2" x={1406} y={550} width={14} height={6} rx={2} />
      </g>

      <g>
        <rect className="f-m1 s-ol" x={470} y={40} width={300} height={50} rx={6} strokeWidth="2" />
        <rect className="f-m5" x={490} y={90} width={6} height={30} />
        <rect className="f-m5" x={744} y={90} width={6} height={30} />
        <text
          className="fx-mono f-y1"
          x={640}
          y={74}
          textAnchor="middle"
          fontSize={22}
          fontWeight={700}
          letterSpacing={4}
        >
          ROVO WORKS
        </text>
        <g className="f-sdot">
          <circle cx={480} cy={48} r={2.5} />
          <circle cx={500} cy={48} r={2.5} />
          <circle cx={520} cy={48} r={2.5} />
          <circle cx={760} cy={48} r={2.5} />
          <circle cx={740} cy={48} r={2.5} />
          <circle cx={720} cy={48} r={2.5} />
          <circle cx={480} cy={82} r={2.5} />
          <circle cx={760} cy={82} r={2.5} />
        </g>
      </g>
    </>
  );
}

const ROLLERS = Array.from({ length: 34 }, (_, i) => i);

const MAP_ORDER: Place[] = [
  "prep",
  "code",
  "verify",
  "review",
  "ready",
  "wait",
  "research",
  "shipped",
];

/** 管制室（フロアマップ・Sandbox の枠・今月の予算・確認待ちと返事待ちの件数） */
function Control(props: { data: OverviewDto; t: FT }) {
  const { data, t } = props;
  const counts = floorMap(data.tasks);
  const { x, y } = CONTROL_ROOM;
  const running = data.budget.running_slots;
  const limit = data.budget.concurrency_limit;
  const slots = Math.min(limit, 12);
  const cap = budgetLimit(data.budget);
  const spent = data.budget.spent_usd + data.budget.reserved_usd;
  const ratio = cap === null || cap <= 0 ? 0 : Math.min(1, spent / cap);
  const readyN = counts.ready;
  return (
    <g data-factory-control="">
      <g transform={`translate(${x + 8} ${y + 40})`}>
        <rect className="f-s0 s-m2" x={0} y={0} width={186} height={98} rx={6} strokeWidth="3" />
        <text className="fx-mono f-blue" x={8} y={13} fontSize={9}>
          FLOOR MAP
        </text>
        <text className="fx-mono f-led fxa-cur" x={178} y={13} fontSize={9} textAnchor="end">
          ● LIVE
        </text>
        {MAP_ORDER.map((p, i) => {
          const n = counts[p];
          const hot = p === "wait" || p === "ready";
          const tone =
            p === "shipped"
              ? "f-navy"
              : n === 0
                ? "f-s2"
                : hot
                  ? "f-ambd"
                  : n >= 3
                    ? "f-g2"
                    : "f-g1";
          const cx = 6 + (i % 4) * 44;
          const cy = 20 + Math.floor(i / 4) * 22;
          return (
            <g key={p} data-map={p} data-n={n}>
              <rect className={tone} x={cx} y={cy} width={42} height={19} rx={2} />
              <text className="fx-mono f-sfg" x={cx + 3} y={cy + 13} fontSize={9}>
                {t(MAP_KEY[p])}
              </text>
              <text
                className="fx-mono f-sfg"
                x={cx + 39}
                y={cy + 13}
                fontSize={10}
                fontWeight={700}
                textAnchor="end"
              >
                {n}
              </text>
            </g>
          );
        })}
        <text className="fx-mono f-td" x={8} y={86} fontSize={8}>
          SANDBOX
        </text>
        {Array.from({ length: slots }, (_, i) => i).map((i) => (
          <rect
            key={i}
            className={i < running ? "f-led fx-glow" : "f-s3"}
            x={52 + i * 9}
            y={79}
            width={7}
            height={7}
            rx={1.5}
          />
        ))}
        <text
          className="fx-mono f-sfg"
          x={180}
          y={87}
          fontSize={11}
          fontWeight={700}
          textAnchor="end"
          data-factory-slots=""
        >
          {`${running}/${limit}`}
        </text>
      </g>
      <g transform={`translate(${x + 200} ${y + 40})`}>
        <rect className="f-s1 s-m2" x={0} y={0} width={88} height={98} rx={6} strokeWidth="3" />
        <svg
          x={4}
          y={6}
          width={80}
          height={48}
          viewBox="0 0 80 48"
          aria-hidden="true"
          focusable="false"
        >
          <path className="s-s3" d="M8 44 A32 32 0 0 1 72 44" fill="none" strokeWidth="8" />
          <path className="s-g2" d="M8 44 A32 32 0 0 1 49.9 13.6" fill="none" strokeWidth="5" />
          <path
            className="s-gold"
            d="M49.9 13.6 A32 32 0 0 1 65.9 25.2"
            fill="none"
            strokeWidth="5"
          />
          <path className="s-red" d="M65.9 25.2 A32 32 0 0 1 72 44" fill="none" strokeWidth="5" />
          <path
            className="s-m7"
            d="M14 44 H18 M40 18 V22 M62 44 H66 M21.6 25.6 L24.4 28.4 M58.4 25.6 L55.6 28.4"
            strokeWidth="1.2"
          />
          <g transform={`rotate(${((ratio - 0.5) * 180).toFixed(1)} 40 44)`}>
            <g className="fxa-wob2">
              <path className="s-red2" d="M40 44 L40 16" strokeWidth="2" strokeLinecap="round" />
            </g>
          </g>
          <circle className="f-m10 s-s3" cx={40} cy={44} r={4} strokeWidth="1.5" />
        </svg>
        <text
          className="fx-mono f-sfg"
          x={44}
          y={70}
          fontSize={11}
          fontWeight={700}
          textAnchor="middle"
        >
          {cap === null ? `$${Math.round(spent)}` : `$${Math.round(spent)}/$${Math.round(cap)}`}
        </text>
        <text className="fx-sans f-td" x={44} y={86} fontSize={10} textAnchor="middle">
          {t("factory.budget")}
        </text>
      </g>
      <g transform={`translate(${x + 8} ${y + 140})`}>
        <svg width={280} height={52} viewBox="0 0 280 52" aria-hidden="true" focusable="false">
          <rect className="f-m1 s-m5" x={18} y={0} width={54} height={22} rx={2} strokeWidth="2" />
          <text className="fx-mono f-td" x={45} y={9} textAnchor="middle" fontSize={6}>
            {t("factory.readySub")}
          </text>
          <text
            className="fx-mono f-gold"
            x={45}
            y={19}
            textAnchor="middle"
            fontSize={9}
            fontWeight={700}
          >
            {readyN}
          </text>
          <rect className="f-m1 s-m5" x={76} y={0} width={54} height={22} rx={2} strokeWidth="2" />
          <text className="fx-mono f-td" x={103} y={9} textAnchor="middle" fontSize={6}>
            {t("factory.wait")}
          </text>
          <text
            className="fx-mono f-red2"
            x={103}
            y={19}
            textAnchor="middle"
            fontSize={9}
            fontWeight={700}
          >
            {counts.wait}
          </text>
          <rect className="f-m5" x={42} y={22} width={6} height={4} />
          <rect className="f-m5" x={100} y={22} width={6} height={4} />
          <path className="f-m6 s-m4" d="M0 26 L280 26 L272 36 L8 36 Z" strokeWidth="1.5" />
          <rect className="f-m3" x={8} y={36} width={264} height={16} />
          <path className="s-m5" d="M20 44 H60 M220 44 H260" strokeWidth="2" />
          <rect className="f-m2" x={118} y={28} width={52} height={6} rx={1} />
          <path className="s-m5" d="M121 31 H167" strokeWidth="2" strokeDasharray="2 1.5" />
          <g>
            <circle className="fxa-led f-led" cx={186} cy={31} r={2.2} />
            <circle className="f-led" cx={194} cy={31} r={2.2} />
            <circle className="fxa-led fxa-l2 f-gold" cx={202} cy={31} r={2.2} />
            <circle className="f-s3" cx={210} cy={31} r={2.2} />
            <rect className="f-red" x={216} y={28.5} width={10} height={5} rx={1} />
          </g>
          <g>
            <rect
              className="f-red s-red3"
              x={232}
              y={27}
              width={16}
              height={7}
              rx={2}
              strokeWidth="1"
            />
            <path className="s-red3" d="M234 27 Q240 20 246 27" fill="none" strokeWidth="2.5" />
          </g>
          <g>
            <rect className="f-m5" x={258} y={18} width={12} height={8} rx={1} />
            <path className="f-amb s-olv" d="M259 18 Q264 6 269 18 Z" strokeWidth="1" />
            <circle className="fxa-halo f-y1" cx={264} cy={13} r={9} opacity=".4" />
          </g>
          <path className="f-m2" d="M132 52 L132 40 Q144 34 156 40 L156 52" />
        </svg>
      </g>
    </g>
  );
}

function MoreTile(props: { tile: Tile; t: FT }) {
  const { tile, t } = props;
  const total = tile.shares.reduce((n, s) => n + s.n, 0);
  let off = 0;
  return (
    <g transform={`translate(${tile.at.x + 2} ${tile.at.y})`} data-factory-more={tile.more}>
      <title>
        {tile.rest
          .map((task) => `${singleLine(task.owner_login)}: ${singleLine(task.title)}`)
          .join("\n")}
      </title>
      <rect
        className="f-wh s-m6 fx-tile"
        x={0}
        y={0}
        width={56}
        height={68}
        rx={8}
        strokeWidth="2"
        strokeDasharray="5 4"
      />
      <text
        className="fx-mono f-tk"
        x={28}
        y={32}
        textAnchor="middle"
        fontSize={15}
        fontWeight={700}
      >
        {t("factory.more", { n: tile.more })}
      </text>
      {tile.shares.map((s) => {
        const w = (38 * s.n) / total;
        const el = (
          <rect
            key={s.login}
            className={`p${s.person} fx-pc`}
            x={9 + off}
            y={44}
            width={w}
            height={7}
          />
        );
        off += w;
        return el;
      })}
    </g>
  );
}

export default function FactoryScene(props: {
  data: OverviewDto;
  onSelect?: (id: string) => void;
}) {
  const { data, onSelect } = props;
  const t = useFactoryT();
  const { bots, tiles } = placeFactory(data.tasks);
  const ref = useWalks(bots);
  const shipped = bots.filter((b) => b.place === "shipped");
  const select = (id: string) => (e: React.MouseEvent) => {
    if (onSelect === undefined || !isPlainLeftClick(e)) return;
    e.preventDefault();
    onSelect(id);
  };
  return (
    <div className="fx-stage">
      {/* biome-ignore lint/a11y/useSemanticElements: SVG にはグループを表す要素が無い */}
      <svg
        className="fx fx-svg"
        viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
        role="group"
        aria-label={t("factory.sceneAria")}
      >
        <defs>
          <linearGradient id="fx-rvY" x1={0} y1={0} x2={0} y2={1}>
            <stop className="c-y1" offset="0" />
            <stop className="c-y2" offset=".55" />
            <stop className="c-y3" offset="1" />
          </linearGradient>
          <linearGradient id="fx-rvO" x1={0} y1={0} x2={0} y2={1}>
            <stop className="c-o1" offset="0" />
            <stop className="c-o2" offset="1" />
          </linearGradient>
          <linearGradient id="fx-rvPipe" x1={0} y1={0} x2={1} y2={0}>
            <stop className="c-pp1" offset="0" />
            <stop className="c-pp2" offset=".45" />
            <stop className="c-pp3" offset="1" />
          </linearGradient>
          <radialGradient id="fx-rvLens" cx={0.4} cy={0.36} r={0.75}>
            <stop className="c-l1" offset="0" />
            <stop className="c-l2" offset=".22" />
            <stop className="c-l3" offset=".6" />
            <stop className="c-l4" offset="1" />
          </radialGradient>
          <radialGradient id="fx-rvRing" cx={0.4} cy={0.35} r={0.8}>
            <stop className="c-rg1" offset="0" />
            <stop className="c-rg2" offset=".6" />
            <stop className="c-rg3" offset="1" />
          </radialGradient>
          <linearGradient id="fx-skyG" x1={0} y1={0} x2={0} y2={1}>
            <stop className="c-sky1" offset="0" />
            <stop className="c-sky2" offset="1" />
          </linearGradient>
          <linearGradient id="fx-roofG" x1={0} y1={0} x2={1} y2={0}>
            <stop className="c-rg2" offset="0" />
            <stop className="c-roof2" offset="1" />
          </linearGradient>
          <linearGradient id="fx-glassG" x1={0} y1={0} x2={1} y2={1}>
            <stop className="c-gl1" offset="0" />
            <stop className="c-gl2" offset="1" />
          </linearGradient>
          <linearGradient id="fx-beamG" x1={0} y1={0} x2={0} y2={1}>
            <stop className="c-beam" offset="0" stopOpacity=".75" />
            <stop className="c-beam" offset="1" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="fx-coneG" x1={0} y1={0} x2={0} y2={1}>
            <stop className="c-cone" offset="0" stopOpacity=".7" />
            <stop className="c-cone" offset="1" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="fx-floorG" x1={0} y1={0} x2={0} y2={1}>
            <stop className="c-m14" offset="0" />
            <stop className="c-m13" offset="1" />
          </linearGradient>
          <pattern id="fx-brick" width={28} height={14} patternUnits="userSpaceOnUse">
            <rect className="f-brick" width={28} height={14} />
            <path
              className="s-mortar"
              d="M0 0.5 H28 M0 7.5 H28 M0.5 0 V7 M14.5 7 V14"
              strokeWidth="1.2"
            />
          </pattern>
          <pattern
            id="fx-hazard"
            width={16}
            height={16}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect className="f-hz" width={16} height={16} />
            <rect className="f-m2" width={8} height={16} />
          </pattern>
          <pattern id="fx-panel" width={96} height={48} patternUnits="userSpaceOnUse">
            <rect width={96} height={48} fill="url(#fx-floorG)" />
            <path className="s-m11" d="M0 0.5 H96 M0.5 0 V48" strokeWidth="1" />
          </pattern>
          <pattern id="fx-rivet" width={24} height={16} patternUnits="userSpaceOnUse">
            <rect className="f-m4" width={24} height={16} />
            <circle className="f-rg2" cx={12} cy={8} r={2} />
          </pattern>
          <symbol id="fx-rvBody" viewBox="-5 -10 110 110">
            <g className="s-ol" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round">
              <path d="M78 44 H86 V26" fill="none" strokeWidth="9" />
              <path d="M78 44 H86 V26" fill="none" stroke="url(#fx-rvPipe)" strokeWidth="4.5" />
              <rect
                x={81.5}
                y={20}
                width={9}
                height={6}
                rx={1.5}
                fill="url(#fx-rvPipe)"
                strokeWidth="2.5"
              />
              <rect
                x={74}
                y={40}
                width={12}
                height={18}
                rx={4}
                fill="url(#fx-rvO)"
                strokeWidth="3"
              />
              <path d="M50 15 V-2" strokeWidth="6" />
              <path className="s-o1" d="M50 15 V-2" strokeWidth="2.4" />
              <path
                d="M20 92 V46 Q20 14 50 14 Q80 14 80 46 Q80 64 64 70 L82 92 H60 L46 75 H40 V92 Z"
                fill="url(#fx-rvY)"
              />
            </g>
            <path className="f-o3" d="M64 70 L82 92 H60 L46 75 Z" opacity=".55" />
            <path className="f-o3" d="M20 70 H40 V92 H20 Z" opacity=".35" />
            <path className="s-ol" d="M22 47 H78" strokeWidth="2.6" />
            <circle
              className="s-ol"
              cx={50}
              cy={45}
              r={14}
              fill="url(#fx-rvRing)"
              strokeWidth="3.5"
            />
            <circle
              className="s-ol"
              cx={50}
              cy={45}
              r={9.5}
              fill="url(#fx-rvLens)"
              strokeWidth="2"
            />
            <ellipse
              className="f-wh"
              cx={46.5}
              cy={41.5}
              rx={3.6}
              ry={2.6}
              transform="rotate(-30 46.5 41.5)"
            />
            <path
              className="s-shine"
              d="M26 40 Q27 24 40 19"
              fill="none"
              strokeWidth="3.2"
              strokeLinecap="round"
              opacity=".85"
            />
          </symbol>
        </defs>
        <clipPath id="fx-shaftClip">
          <rect x={1126} y={172} width={84} height={588} />
        </clipPath>
        <svg width={1440} height={1000} overflow="visible" aria-hidden="true" focusable="false">
          <Backdrop t={t} />
          {FACTORY_ROOMS.map((r) => {
            const art = ART[r.id];
            return (
              <g key={r.id} data-room={r.id}>
                <path
                  className="s-hz2 fx-wall"
                  d={`M${r.x} ${r.y} V${r.y + r.h} M${r.x + r.w} ${r.y} V${r.y + r.h}`}
                  strokeWidth="1"
                  strokeDasharray="4 3"
                />
                <path
                  className="s-hz"
                  d={`M${r.x} ${r.y + r.h - 1.5} H${r.x + r.w}`}
                  strokeWidth="3"
                />
                <g
                  className="fx-art"
                  transform={`translate(${r.x + (r.w - art.w) / 2} ${r.y + 40 + (r.art - art.h)})`}
                >
                  <RoomArt id={r.id} t={t} />
                </g>
                <Plate
                  cx={r.x + r.w / 2}
                  y={r.y}
                  name={t(NAME_KEY[r.id])}
                  sub={t(SUB_KEY[r.id])}
                  n={String(bots.filter((b) => b.place === r.id).length)}
                />
              </g>
            );
          })}
          <g data-room="control">
            <path
              className="s-hz2 fx-wall"
              d={`M${CONTROL_ROOM.x} ${CONTROL_ROOM.y} V${CONTROL_ROOM.y + CONTROL_ROOM.h} M${CONTROL_ROOM.x + CONTROL_ROOM.w} ${CONTROL_ROOM.y} V${CONTROL_ROOM.y + CONTROL_ROOM.h}`}
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <path
              className="s-hz"
              d={`M${CONTROL_ROOM.x} ${CONTROL_ROOM.y + CONTROL_ROOM.h - 1.5} H${CONTROL_ROOM.x + CONTROL_ROOM.w}`}
              strokeWidth="3"
            />
            <Control data={data} t={t} />
            <Plate
              cx={CONTROL_ROOM.x + CONTROL_ROOM.w / 2}
              y={CONTROL_ROOM.y}
              name={t("factory.control")}
              sub={t("factory.controlSub")}
              n="—"
            />
          </g>
          <g clipPath="url(#fx-shaftClip)">
            <g className="fxa-lift">
              <path className="s-m2" d="M1168 550 V-200" strokeWidth="2" />
              <rect className="f-m5" x={1129} y={638} width={78} height={8} rx={2} />
              <rect
                className="f-wh fx-car s-hz"
                x={1132}
                y={646}
                width={72}
                height={90}
                rx={3}
                strokeWidth="3"
              />
              <path
                className="s-m5 fx-car-bars"
                d="M1144 646 V736 M1156 646 V736 M1168 646 V736 M1180 646 V736 M1192 646 V736"
                strokeWidth="2"
              />
              <rect className="f-m5" x={1132} y={731} width={72} height={5} />
            </g>
          </g>
          <rect className="f-m3" x={44} y={738} width={1340} height={14} rx={7} />
          <path
            className="s-m5 fxa-belt"
            d="M50 745 H1378"
            strokeWidth="10"
            strokeDasharray="16 16"
          />
          {ROLLERS.map((i) => (
            <g key={i} transform={`translate(${48 + i * 40} 753)`}>
              <g className="fxa-roll fxp">
                <circle className="f-m8 s-m5" cx={4.5} cy={4.5} r={4.5} />
                <path className="s-m5" d="M4.5 0.5 V8.5 M0.5 4.5 H8.5" />
              </g>
            </g>
          ))}
          <text
            className="fx-mono f-tg"
            x={1262}
            y={712}
            fontSize={16}
            fontWeight={700}
            data-factory-shipped={shipped.length}
          >
            {t("factory.shippedN", { n: shipped.length })}
          </text>
          {tiles.map((tile) => (
            <MoreTile key={tile.room} tile={tile} t={t} />
          ))}
        </svg>
        {bots.map((b) => {
          if (b.pose === null && b.place !== "shipped") return null;
          const id = b.task.task_id;
          const p = personIndex(b.task.owner_login);
          const label = botLabel(b.task, b.place, t);
          if (b.place === "shipped" && b.i >= SHIP_MAX) return null;
          return (
            <a
              key={id}
              href={taskPath(id)}
              onClick={select(id)}
              aria-label={label}
              data-task={id}
              data-room={b.place}
              data-person={p}
              className="fx-link"
            >
              <title>{label}</title>
              <g transform={`translate(${b.at.x} ${b.at.y})`}>
                <g ref={ref(id)} className={`fx-mover p${p} fxd${b.i % 3}`}>
                  {b.place === "shipped" ? (
                    <rect
                      className="fx-pc fx-glow fx-ship"
                      x={0}
                      y={0}
                      width={14}
                      height={14}
                      rx={3}
                    />
                  ) : (
                    <Bot
                      pose={b.pose as Pose}
                      login={b.task.owner_login}
                      dest={t("factory.to", { room: placeName(b.place, t) })}
                    />
                  )}
                </g>
                {/* 押す場所（上に重ねた動かない当たり判定。Rovo は待機の動作で動き続ける） */}
                <rect
                  className="fx-hit"
                  width={b.place === "shipped" ? 14 : BOT_W}
                  height={b.place === "shipped" ? 14 : BOT_H}
                />
              </g>
            </a>
          );
        })}
      </svg>
    </div>
  );
}
