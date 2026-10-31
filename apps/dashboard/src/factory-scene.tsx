import type { OverviewDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
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
  personIndex,
  type RoomGeom,
  type RoomId,
  roomCapacity,
  SCENE,
} from "./factory";
import "./factory-scene.css";
import { type FT, useFactoryT } from "./factory-i18n";
import { singleLine } from "./format";
import { budgetLimit } from "./rail";
import { taskPath } from "./route";

/**
 * 工場の断面図（docs/specs/dashboard-factory.md。見本 Factory2 の案 A v5 を写したもの）。遅延読み込みの別チャンク。
 * 見本は位置と色をインラインの style で組んでいたが、ここでは位置を SVG の属性、色を factory-scene.css のクラス（トークン）で渡す
 * （CSP の style-src 'self'。style 属性と <style> 要素は作らない）。帯に合わせて横長の 2 階建て（1440 × 280）に組み直した。
 * 待機の動作と背景の部品は CSS のアニメーション、工程が変わった Rovo の移動は Web Animations API（element.animate）。
 */

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

/** 歩く通路の高さ（Rovo の枠の上端。床に立つ高さ）。1 階と 2 階 */
const CORRIDOR: Record<1 | 2, number> = { 1: 256 - 3 - BOT_H, 2: 146 - 3 - BOT_H };
/** エレベーターのかごの中の Rovo の左端 */
const LIFT_X = 1239;
/** 歩く速さ（座標 / ミリ秒） */
const SPEED = 0.12;
/** Rovo とタイルの絵（見本の 60 × 68 の枠で描いたもの）を帯の大きさに縮める倍率 */
const BOT_SCALE = 0.9;

/** 部屋の床に Rovo を 1 段で並べる（中央寄せ） */
function floorSpots(r: RoomGeom, count: number): Spot[] {
  const width = count * BOT_W + Math.max(0, count - 1) * BOT_GAP;
  const x0 = r.x + (r.w - width) / 2;
  return Array.from({ length: count }, (_, i) => ({
    x: x0 + i * (BOT_W + BOT_GAP),
    y: CORRIDOR[r.floor],
  }));
}

/** 出荷口の箱の位置（トラックの荷台に 5 個ずつ 2 段） */
const SHIP_MAX = 10;
function shipSpot(i: number): Spot {
  return { x: 1316 + (i % 5) * 15, y: 204 + Math.floor(i / 5) * 15 };
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

function walk(el: Element, pts: Spot[], to: Spot): Animation | null {
  let total = 0;
  const dist = [0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] as Spot;
    const q = pts[i - 1] as Spot;
    total += Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
    dist.push(total);
  }
  if (total === 0) return null;
  const frames = pts.map((p, i) => ({
    transform: `translate(${p.x - to.x}px, ${p.y - to.y}px)`,
    offset: (dist[i] as number) / total,
  }));
  return el.animate(frames, {
    duration: Math.min(9000, Math.max(1500, total / SPEED)),
    easing: "linear",
  });
}

/**
 * 動きを減らす設定か。描いている文書の window（PiP の窓に出しているときは PiP の window）で評価する。
 * 要素がまだ無いときだけ、グローバルの window に倒す
 */
function reducedMotion(el: Element | null): boolean {
  const view = el?.ownerDocument.defaultView ?? (typeof window === "undefined" ? null : window);
  return (
    view !== null &&
    typeof view.matchMedia === "function" &&
    view.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * 前回の場所を覚えて、場所が変わった Rovo だけ歩かせる（FLIP）。歩いている Rovo は state に持ち、
 * 歩く姿（fx-walking）は className に入れる（ポーリングで並びが変わって className が書き直されても消えない）。
 * 歩き途中にまた場所が変わったら、前の歩きを止めて今の場所から歩き直す。
 * PiP の窓への付け替えなどで作り直されたら、前回の場所は空から始め（最初は歩かない）、実行中の歩きは外すときに止める。
 */
function useWalks(bots: Placed[]) {
  const prev = useRef(new Map<string, { place: Place; at: Spot }>());
  const nodes = useRef(new Map<string, Element>());
  const anims = useRef(new Map<string, Animation>());
  const stage = useRef<HTMLDivElement | null>(null);
  const [walking, setWalking] = useState<ReadonlySet<string>>(() => new Set());
  useLayoutEffect(
    () => () => {
      for (const a of anims.current.values()) {
        a.onfinish = null;
        a.oncancel = null;
        a.cancel();
      }
      anims.current.clear();
    },
    [],
  );
  useLayoutEffect(() => {
    const motion = !reducedMotion(stage.current);
    const next = new Map<string, { place: Place; at: Spot }>();
    const started: string[] = [];
    for (const b of bots) {
      const id = b.task.task_id;
      next.set(id, { place: b.place, at: b.at });
      const old = prev.current.get(id);
      const move = moveOf(old?.place, b.place);
      const el = nodes.current.get(id);
      if (!motion || old === undefined || move === null || el === undefined) continue;
      if (typeof el.animate !== "function") continue;
      anims.current.get(id)?.cancel();
      const anim = walk(el, walkPath(old.at, b.at, move.from, move.to), b.at);
      if (anim === null) continue;
      anims.current.set(id, anim);
      const done = () => {
        if (anims.current.get(id) !== anim) return;
        anims.current.delete(id);
        setWalking((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      };
      anim.onfinish = done;
      anim.oncancel = done;
      started.push(id);
    }
    prev.current = next;
    if (started.length > 0) setWalking((s) => new Set([...s, ...started]));
  });
  const ref = (id: string) => (el: Element | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  };
  return { ref, walking, stage };
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

/** 部屋の名前の札（名前・補足・人数）。部屋の左上に置き、幅を返す */
function plateWidth(name: string, sub: string, n: string): number {
  return (
    8 + textWidth(name, 13) + 6 + textWidth(sub, 10) + 6 + Math.max(18, textWidth(n, 11) + 10) + 6
  );
}
function Plate(props: { x: number; y: number; name: string; sub: string; n: string }) {
  const { x, y } = props;
  const nameW = textWidth(props.name, 13);
  const subW = textWidth(props.sub, 10);
  const nW = Math.max(18, textWidth(props.n, 11) + 10);
  const w = plateWidth(props.name, props.sub, props.n);
  return (
    <g className="fx-plate">
      <rect className="f-m2" x={x} y={y} width={w} height={20} rx={4} />
      <text className="fx-sans f-tw" x={x + 8} y={y + 14.5} fontSize={13} fontWeight={700}>
        {props.name}
      </text>
      <text className="fx-sans f-tl" x={x + 8 + nameW + 6} y={y + 14} fontSize={10}>
        {props.sub}
      </text>
      <rect
        className="f-y1"
        x={x + 8 + nameW + 6 + subW + 6}
        y={y + 3}
        width={nW}
        height={14}
        rx={7}
      />
      <text
        className="fx-mono f-tk"
        x={x + 8 + nameW + 6 + subW + 6 + nW / 2}
        y={y + 14}
        textAnchor="middle"
        fontSize={11}
        fontWeight={700}
      >
        {props.n}
      </text>
    </g>
  );
}

/** 背景（空・山・街・のこぎり屋根と天窓・看板・煙突・レンガ・床・配管・照明・クレーン・竪穴・出荷口）。帯用に横長に描き直したもの */
const TEETH = Array.from({ length: 12 }, (_, i) => 8 + i * 102.33);
const ROLLERS = Array.from({ length: 36 }, (_, i) => 16 + i * 40);
function Backdrop(props: { t: FT }) {
  const { t } = props;
  return (
    <>
      <rect x={0} y={0} width={1440} height={280} fill="url(#fx-skyG)" />
      <g className="fxa-cloud f-cloud" opacity=".8">
        <ellipse cx={150} cy={12} rx={60} ry={8} />
        <ellipse cx={760} cy={8} rx={46} ry={6} />
        <ellipse cx={1330} cy={30} rx={56} ry={9} />
      </g>
      <path
        className="f-hill"
        d="M1236 110 L1290 86 L1336 100 L1384 80 L1420 96 L1440 108 V262 H1236 Z"
      />
      <g className="f-city">
        <rect x={1306} y={100} width={22} height={90} />
        <rect x={1332} y={82} width={18} height={108} />
        <rect x={1354} y={110} width={26} height={80} />
        <rect x={1384} y={92} width={16} height={98} />
        <rect x={1404} y={116} width={30} height={74} />
      </g>
      <g className="f-cwin">
        <rect x={1336} y={92} width={4} height={4} />
        <rect x={1342} y={92} width={4} height={4} />
        <rect x={1336} y={102} width={4} height={4} />
        <rect x={1388} y={102} width={4} height={4} />
        <rect x={1310} y={110} width={4} height={4} />
        <rect x={1410} y={124} width={4} height={4} />
      </g>
      <g>
        <circle className="f-tree" cx={1424} cy={178} r={14} />
        <rect className="f-trunk" x={1422} y={188} width={4} height={18} />
      </g>
      <rect className="f-m11" x={0} y={262} width={1440} height={18} />
      <rect className="f-m9" x={0} y={262} width={1440} height={3} />
      {/* 給水塔・看板・煙突・換気扇 */}
      <g>
        <rect className="f-m6" x={44} y={14} width={4} height={18} />
        <rect className="f-m6" x={72} y={14} width={4} height={18} />
        <rect className="f-m8 s-m5" x={36} y={0} width={48} height={16} rx={3} strokeWidth="1.5" />
        <text
          className="fx-mono f-tw"
          x={60}
          y={11}
          textAnchor="middle"
          fontSize={8}
          fontWeight={700}
        >
          H2O
        </text>
      </g>
      <g>
        <rect className="f-m5" x={590} y={16} width={4} height={16} />
        <rect className="f-m5" x={706} y={16} width={4} height={16} />
        <rect
          className="f-m1 s-ol"
          x={570}
          y={0}
          width={160}
          height={18}
          rx={3}
          strokeWidth="1.5"
        />
        <text
          className="fx-mono f-y1"
          x={650}
          y={13.5}
          textAnchor="middle"
          fontSize={12}
          fontWeight={700}
          letterSpacing={3}
        >
          ROVO WORKS
        </text>
      </g>
      <g>
        <rect
          className="s-bredge"
          x={1130}
          y={0}
          width={14}
          height={34}
          fill="url(#fx-brick)"
          strokeWidth="1.5"
        />
        <rect
          className="s-bredge"
          x={1152}
          y={8}
          width={12}
          height={26}
          fill="url(#fx-brick)"
          strokeWidth="1.5"
        />
        <circle className="fxa-stack f-m12" cx={1137} cy={0} r={6} />
        <circle className="fxa-stack fxa-s2 f-m13" cx={1158} cy={4} r={5} />
      </g>
      {/* のこぎり屋根と天窓 */}
      <path
        className="s-m4"
        fill="url(#fx-roofG)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        d={`M8 36 ${TEETH.map((x) => `L${x} 30 L${x + 102.33} 14 L${x + 102.33} 30`).join(" ")} L1236 36 Z`}
      />
      <g className="s-m4" fill="url(#fx-glassG)" strokeWidth="1">
        {TEETH.map((x) => (
          <rect key={x} x={x + 96.33} y={15} width={6} height={15} />
        ))}
      </g>
      <g>
        <circle className="f-m8 s-m5" cx={300} cy={24} r={6} strokeWidth="1.5" />
        <g className="fxa-fan">
          <path
            className="f-m5"
            d="M300 19 L301 24 L300 29 L299 24 Z M295 24 L300 23 L305 24 L300 25 Z"
          />
        </g>
        <circle className="f-m8 s-m5" cx={900} cy={24} r={6} strokeWidth="1.5" />
        <g className="fxa-fan">
          <path
            className="f-m5"
            d="M900 19 L901 24 L900 29 L899 24 Z M895 24 L900 23 L905 24 L900 25 Z"
          />
        </g>
      </g>
      <rect className="f-wh s-m4" x={4} y={34} width={1236} height={10} strokeWidth="1.5" />
      <rect className="f-m11" x={4} y={40} width={1236} height={4} />
      {/* 建物（レンガの外壁・2 階と 1 階の床・床の間の梁） */}
      <rect
        className="s-bredge"
        x={8}
        y={44}
        width={1228}
        height={218}
        fill="url(#fx-brick)"
        strokeWidth="1.5"
      />
      <rect x={14} y={48} width={1216} height={98} fill="url(#fx-panel)" />
      <rect x={14} y={156} width={1216} height={100} fill="url(#fx-panel)" />
      <rect x={8} y={146} width={1228} height={10} fill="url(#fx-rivet)" />
      <rect className="f-m2" x={8} y={146} width={1228} height={2} />
      {/* 配管（空気・水）と流れ */}
      <rect className="f-pblue" x={14} y={50} width={1216} height={4} rx={2} />
      <rect className="f-cop" x={14} y={158} width={1216} height={4} rx={2} />
      <g
        className="fxa-flow s-wh"
        fill="none"
        strokeOpacity=".45"
        strokeWidth="1.5"
        strokeDasharray="4 16"
      >
        <path d="M16 52 H1228" />
        <path d="M16 160 H1228" />
      </g>
      {/* 照明の光（2 階は天井の窓から、1 階はランプから） */}
      <g fill="url(#fx-beamG)">
        <path d="M200 54 L222 54 L262 146 L218 146 Z" />
        <path d="M612 54 L634 54 L674 146 L630 146 Z" />
        <path d="M1010 54 L1032 54 L1072 146 L1028 146 Z" />
      </g>
      <g className="f-m3">
        {[126, 396, 678, 910, 1124].map((x) => (
          <path key={x} d={`M${x - 8} 170 L${x + 8} 170 L${x + 5} 164 L${x - 5} 164 Z`} />
        ))}
      </g>
      <g fill="url(#fx-coneG)">
        {[126, 396, 678, 910, 1124].map((x) => (
          <path key={x} d={`M${x - 7} 170 L${x + 7} 170 L${x + 46} 256 L${x - 46} 256 Z`} />
        ))}
      </g>
      {/* 柱（部屋の間）と床の縞 */}
      <g className="f-m6">
        <rect x={421} y={48} width={6} height={98} />
        <rect x={833} y={48} width={6} height={98} />
        <rect x={237} y={156} width={6} height={100} />
        <rect x={549} y={156} width={6} height={100} />
        <rect x={801} y={156} width={6} height={100} />
        <rect x={1013} y={156} width={6} height={100} />
      </g>
      <rect x={8} y={256} width={1228} height={6} fill="url(#fx-hazard)" />
      {/* 消火器 */}
      <g className="f-red">
        <rect x={228} y={238} width={6} height={14} rx={2} />
        <rect x={1004} y={238} width={6} height={14} rx={2} />
        <rect x={410} y={128} width={6} height={14} rx={2} />
      </g>
      {/* 安全第一の札（梁の上） */}
      <g>
        <rect
          className="f-wh s-ok"
          x={610}
          y={143}
          width={116}
          height={16}
          rx={2}
          strokeWidth="1.5"
        />
        <path className="s-ok" d="M618 151 H628 M623 146 V156" strokeWidth="3" />
        <text
          className="fx-sans f-ok"
          x={676}
          y={155.5}
          textAnchor="middle"
          fontSize={11}
          fontWeight={700}
          letterSpacing={3}
        >
          {t("factory.safety")}
        </text>
      </g>
      {/* 1 階の天井クレーン */}
      <g className="fxa-crane">
        <rect className="f-hz s-olv" x={30} y={162} width={36} height={9} rx={2} strokeWidth="1" />
        <text
          className="fx-mono f-oink"
          x={48}
          y={169}
          textAnchor="middle"
          fontSize={6}
          fontWeight={700}
        >
          2t
        </text>
        <path className="s-m2" d="M48 171 V184" strokeWidth="1.2" />
        <path className="s-m2" d="M44 186 Q48 192 52 186" fill="none" strokeWidth="2" />
      </g>
      {/* 貨物エレベーターの竪穴 */}
      <g>
        <rect className="f-m11" x={1236} y={44} width={60} height={218} />
        <path
          className="s-m10"
          d="M1236 50 L1296 140 M1296 50 L1236 140 M1236 160 L1296 250 M1296 160 L1236 250"
          strokeWidth="1.5"
        />
        <rect className="f-m6" x={1236} y={44} width={3} height={218} />
        <rect className="f-m6" x={1293} y={44} width={3} height={218} />
        <rect x={1236} y={144} width={60} height={3} fill="url(#fx-hazard)" />
        <rect
          className="f-m8 s-m4"
          x={1246}
          y={28}
          width={40}
          height={16}
          rx={2}
          strokeWidth="1.5"
        />
        <g className="fxa-fan">
          <circle className="f-m5" cx={1266} cy={36} r={5} />
          <path className="s-m10" d="M1266 31 V41 M1261 36 H1271" strokeWidth="1.5" />
        </g>
        <g className="fx-mono" fontSize={9} fontWeight={700}>
          <rect className="f-m1" x={1240} y={52} width={20} height={12} rx={2} />
          <text className="f-y1" x={1250} y={61} textAnchor="middle">
            2F
          </text>
          <rect className="f-m1" x={1240} y={160} width={20} height={12} rx={2} />
          <text className="f-y1" x={1250} y={169} textAnchor="middle">
            1F
          </text>
        </g>
      </g>
      {/* GitHub 出荷口（看板・荷台・トラック） */}
      <g>
        <rect className="f-m9" x={1296} y={248} width={144} height={14} />
        <rect className="f-hz" x={1296} y={248} width={144} height={3} />
        <rect className="f-m5" x={1316} y={140} width={3} height={52} />
        <rect className="f-m5" x={1420} y={140} width={3} height={52} />
        <rect className="f-m1" x={1304} y={118} width={132} height={24} rx={4} />
        <text
          className="fx-sans f-tw"
          x={1370}
          y={135}
          textAnchor="middle"
          fontSize={12}
          fontWeight={700}
        >
          {t("factory.dock")}
        </text>
        <rect
          className="f-m14 s-m5"
          x={1306}
          y={196}
          width={86}
          height={50}
          rx={3}
          strokeWidth="2"
        />
        <rect className="f-m2" x={1308} y={198} width={6} height={46} />
        <path
          className="f-m12 s-m5"
          d="M1392 210 L1412 210 L1430 228 L1430 246 L1392 246 Z"
          strokeWidth="2"
        />
        <rect className="f-pale s-m5" x={1398} y={214} width={14} height={12} strokeWidth="1" />
        <circle className="f-m1" cx={1330} cy={248} r={8} />
        <circle className="f-m8" cx={1330} cy={248} r={3} />
        <circle className="f-m1" cx={1414} cy={248} r={8} />
        <circle className="f-m8" cx={1414} cy={248} r={3} />
      </g>
      {/* 手前のベルトコンベア */}
      <rect className="f-m3" x={12} y={265} width={1416} height={8} rx={4} />
      <path className="s-m5 fxa-belt" d="M16 269 H1424" strokeWidth="6" strokeDasharray="16 16" />
      {ROLLERS.map((x) => (
        <g key={x} transform={`translate(${x} 273)`}>
          <g className="fxa-roll fxp">
            <circle className="f-m8 s-m5" cx={3.5} cy={3.5} r={3.5} />
            <path className="s-m5" d="M3.5 0.5 V6.5 M0.5 3.5 H6.5" />
          </g>
        </g>
      ))}
    </>
  );
}

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

/** 管制室（フロアマップ・今月の予算のゲージ・Sandbox の枠）。読める大きさを優先し、見本の細部（机の計器など）は省いた */
function Control(props: { data: OverviewDto; t: FT }) {
  const { data, t } = props;
  const counts = floorMap(data.tasks);
  const { x, y } = CONTROL_ROOM;
  const running = data.budget.running_slots;
  const limit = data.budget.concurrency_limit;
  const slots = Array.from({ length: Math.min(limit, 10) }, (_, i) => i);
  const cap = budgetLimit(data.budget);
  const spent = data.budget.spent_usd + data.budget.reserved_usd;
  const ratio = cap === null || cap <= 0 ? 0 : Math.min(1, spent / cap);
  return (
    <g data-factory-control="">
      <g transform={`translate(${x + 6} ${y + 26})`}>
        <rect className="f-s0 s-m2" x={0} y={0} width={238} height={66} rx={4} strokeWidth="2" />
        <text className="fx-mono f-blue" x={6} y={10} fontSize={8}>
          FLOOR MAP
        </text>
        <text className="fx-mono f-led fxa-cur" x={232} y={10} fontSize={8} textAnchor="end">
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
          const cx = 4 + (i % 4) * 58;
          const cy = 15 + Math.floor(i / 4) * 25;
          return (
            <g key={p} data-map={p} data-n={n}>
              <rect className={tone} x={cx} y={cy} width={56} height={22} rx={2} />
              <text className="fx-sans f-sfg" x={cx + 4} y={cy + 15} fontSize={9}>
                {t(MAP_KEY[p])}
              </text>
              <text
                className="fx-mono f-sfg"
                x={cx + 52}
                y={cy + 16}
                fontSize={13}
                fontWeight={700}
                textAnchor="end"
              >
                {n}
              </text>
            </g>
          );
        })}
      </g>
      <g transform={`translate(${x + 250} ${y + 6})`}>
        <rect className="f-s1 s-m2" x={0} y={0} width={132} height={86} rx={4} strokeWidth="2" />
        <svg
          x={4}
          y={6}
          width={64}
          height={38}
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
          <g transform={`rotate(${((ratio - 0.5) * 180).toFixed(1)} 40 44)`}>
            <g className="fxa-wob2">
              <path className="s-red2" d="M40 44 L40 16" strokeWidth="2.5" strokeLinecap="round" />
            </g>
          </g>
          <circle className="f-m10 s-s3" cx={40} cy={44} r={4} strokeWidth="1.5" />
        </svg>
        <text className="fx-mono f-sfg" x={70} y={24} fontSize={11} fontWeight={700}>
          {cap === null ? `$${Math.round(spent)}` : `$${Math.round(spent)}/$${Math.round(cap)}`}
        </text>
        <text className="fx-sans f-td" x={70} y={38} fontSize={10}>
          {t("factory.budget")}
        </text>
        <text className="fx-mono f-td" x={6} y={60} fontSize={9}>
          SANDBOX
        </text>
        <text
          className="fx-mono f-sfg"
          x={126}
          y={62}
          fontSize={13}
          fontWeight={700}
          textAnchor="end"
          data-factory-slots=""
        >
          {`${running}/${limit}`}
        </text>
        {slots.map((i) => (
          <rect
            key={i}
            className={i < running ? "f-led fx-glow" : "f-s3"}
            x={6 + i * 11}
            y={68}
            width={8}
            height={8}
            rx={1.5}
          />
        ))}
      </g>
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

function MoreTile(props: { tile: Tile; t: FT }) {
  const { tile, t } = props;
  const total = tile.shares.reduce((n, s) => n + s.n, 0);
  let off = 0;
  return (
    <g
      transform={`translate(${tile.at.x} ${tile.at.y}) scale(${BOT_SCALE})`}
      data-factory-more={tile.more}
    >
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

/** 部屋の設備の絵を、札の右の空きに収まる大きさで右上に置く（高さは 34 まで） */
function artPlacement(r: RoomGeom, plateW: number): { x: number; y: number; s: number } {
  const art = ART[r.id];
  const room = r.w - plateW - 22;
  const s = Math.min(34 / art.h, room / art.w);
  return { x: r.x + r.w - 6 - art.w * s, y: r.y + 4 + (34 - art.h * s), s };
}

export default function FactoryScene(props: {
  data: OverviewDto;
  onSelect?: (id: string) => void;
}) {
  const { data, onSelect } = props;
  const t = useFactoryT();
  const { bots, tiles } = placeFactory(data.tasks);
  const { ref, walking, stage } = useWalks(bots);
  const shipped = bots.filter((b) => b.place === "shipped");
  const select = (id: string) => (e: React.MouseEvent) => {
    if (onSelect === undefined || !isPlainLeftClick(e)) return;
    e.preventDefault();
    onSelect(id);
  };
  return (
    <div className="fx-stage" ref={stage}>
      {/* biome-ignore lint/a11y/useSemanticElements: SVG にはグループを表す要素が無い */}
      <svg
        className="fx fx-svg"
        viewBox={`0 0 ${SCENE.w} ${SCENE.h}`}
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
          <rect x={1236} y={44} width={60} height={218} />
        </clipPath>
        <svg
          width={SCENE.w}
          height={SCENE.h}
          overflow="visible"
          aria-hidden="true"
          focusable="false"
        >
          <Backdrop t={t} />
          {FACTORY_ROOMS.map((r) => {
            const n = String(bots.filter((b) => b.place === r.id).length);
            const name = t(NAME_KEY[r.id]);
            const sub = t(SUB_KEY[r.id]);
            const at = artPlacement(r, plateWidth(name, sub, n));
            return (
              <g key={r.id} data-room={r.id}>
                <path
                  className="s-hz"
                  d={`M${r.x} ${r.y + r.h - 1} H${r.x + r.w}`}
                  strokeWidth="2"
                />
                <g className="fx-art" transform={`translate(${at.x} ${at.y}) scale(${at.s})`}>
                  <RoomArt id={r.id} t={t} />
                </g>
                <Plate x={r.x + 6} y={r.y + 4} name={name} sub={sub} n={n} />
              </g>
            );
          })}
          <g data-room="control">
            <Control data={data} t={t} />
            <Plate
              x={CONTROL_ROOM.x + 6}
              y={CONTROL_ROOM.y + 4}
              name={t("factory.control")}
              sub={t("factory.controlSub")}
              n="—"
            />
          </g>
          <g clipPath="url(#fx-shaftClip)">
            <g className="fxa-lift">
              <path className="s-m2" d="M1266 188 V-200" strokeWidth="1.5" />
              <rect className="f-m5" x={1237} y={188} width={58} height={6} rx={2} />
              <rect
                className="f-wh fx-car s-hz"
                x={1238}
                y={194}
                width={56}
                height={62}
                rx={2}
                strokeWidth="2.5"
              />
              <path
                className="s-m5"
                d="M1250 194 V256 M1262 194 V256 M1274 194 V256 M1286 194 V256"
                strokeWidth="1.5"
              />
            </g>
          </g>
          <text
            className="fx-mono f-tg"
            x={1350}
            y={242}
            textAnchor="middle"
            fontSize={11}
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
          const ship = b.place === "shipped";
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
                <g
                  ref={ref(id)}
                  className={`fx-mover p${p} fxd${b.i % 3}${walking.has(id) ? " fx-walking" : ""}`}
                >
                  {ship ? (
                    <rect
                      className="fx-pc fx-glow fx-ship"
                      x={0}
                      y={0}
                      width={12}
                      height={12}
                      rx={2}
                    />
                  ) : (
                    <g transform={`scale(${BOT_SCALE})`}>
                      <Bot
                        pose={b.pose as Pose}
                        login={b.task.owner_login}
                        dest={t("factory.to", { room: placeName(b.place, t) })}
                      />
                    </g>
                  )}
                </g>
                {/* 押す場所（上に重ねた動かない当たり判定。Rovo は待機の動作で動き続ける） */}
                <rect className="fx-hit" width={ship ? 12 : BOT_W} height={ship ? 12 : BOT_H} />
              </g>
            </a>
          );
        })}
      </svg>
    </div>
  );
}
