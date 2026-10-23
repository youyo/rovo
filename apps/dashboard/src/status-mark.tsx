import type { ReactNode } from "react";
import { MARKS, type Mark, type MarkKind, type MarkShape } from "./status";

/** 状態の印の矩形（SVG の中で使う）。色は CSS のクラスで決め、形（塗り・縁）と文字で色なしでも区別できる。 */
export function MarkRect(props: {
  kind: MarkKind;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const m = MARKS[props.kind];
  // 縁は内側に 2px 描く（見本: border 2px）
  return (
    <rect
      className={`mk mk--${m.tone} mk--${m.fill} mk--${m.edge}`}
      data-mark={props.kind}
      x={props.x + 1}
      y={props.y + 1}
      width={Math.max(0, props.width - 2)}
      height={Math.max(0, props.height - 2)}
      rx={1}
    />
  );
}

/**
 * 記号ごとの図形（16 x 16。色は CSS の color = currentColor。丸の塗りは .mark-fill、中の記号は .mark-glyph、輪は .mark-ring）。
 * GitHub Actions の見た目: 緑の丸に ✓、赤の丸に ✕、黄の回る輪、青の丸に ●、灰の丸に –、点線の輪。
 * どの 2 つも違う形にして、色が分からなくても（白黒でも）見分けられるようにする。MarkShape が増えるとコンパイルエラー。
 */
const SHAPES = {
  // 成功: 塗りの丸に ✓
  check: (
    <>
      <circle className="mark-fill" cx={8} cy={8} r={7} />
      <path className="mark-glyph" d="M4.7 8.3l2.2 2.2 4.4-4.6" />
    </>
  ),
  // 失敗: 塗りの丸に ✕
  cross: (
    <>
      <circle className="mark-fill" cx={8} cy={8} r={7} />
      <path className="mark-glyph" d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" />
    </>
  ),
  // 動いている: 回る輪（4 分の 3 だけの輪。reduced-motion では止めて破線の輪）
  spinner: <circle className="mark-ring mark-ring--arc" cx={8} cy={8} r={5.5} />,
  // レビュー待ち: 塗りの丸に ●
  dot: (
    <>
      <circle className="mark-fill" cx={8} cy={8} r={7} />
      <circle className="mark-glyph" cx={8} cy={8} r={2.2} />
    </>
  ),
  // 閉じた・キャンセル: 塗りの丸に –
  dash: (
    <>
      <circle className="mark-fill" cx={8} cy={8} r={7} />
      <path className="mark-glyph" d="M4.9 8h6.2" />
    </>
  ),
  // 未着手・準備中: 点線の輪
  queued: <circle className="mark-ring mark-ring--dotted" cx={8} cy={8} r={5.5} />,
  // 入力待ち: 塗りの丸に ！
  bang: (
    <>
      <circle className="mark-fill" cx={8} cy={8} r={7} />
      <path className="mark-glyph" d="M8 4.4v4.1" />
      <circle className="mark-glyph" cx={8} cy={11.2} r={0.9} />
    </>
  ),
} as const satisfies Record<MarkShape, ReactNode>;

/**
 * 形と色だけの印（段階の箱・ステップの行など、状態の種類（MarkKind）ではなく形で決める場所）。
 * 状態の種類の印は MarkSymbol。大きさは周りの文字に合わせる（CSS の .mark-sym の em）。
 * label があれば aria-label と <title> に付ける。無ければ装飾（隣に文字がある）。
 */
export function ShapeSymbol(props: {
  shape: MarkShape;
  tone: Mark["tone"];
  /** 回る輪か */
  live?: boolean;
  /** MarkKind の印のときの種類（テストや CSS の手がかり） */
  kind?: MarkKind;
  label?: string;
}) {
  const common = {
    className: `mark-sym mark-sym--${props.tone}${props.live ? " spin" : ""}`,
    viewBox: "0 0 16 16",
    focusable: "false",
    "data-shape": props.shape,
    ...(props.kind === undefined ? {} : { "data-mark": props.kind }),
  } as const;
  if (props.label === undefined) {
    return (
      <svg {...common} aria-hidden="true">
        {SHAPES[props.shape]}
      </svg>
    );
  }
  return (
    <svg {...common} role="img" aria-label={props.label}>
      <title>{props.label}</title>
      {SHAPES[props.shape]}
    </svg>
  );
}

/**
 * 状態の印（記号 + 色）。レール・コンソールの見出し・凡例で同じものを使う。
 * 大きさは周りの文字に合わせる（CSS の .mark-sym の em）。色は tone のクラス（トークンだけ）。動いている状態は回る。
 * decorative: 隣に状態の文字がある場所（凡例・見出し・バッジ）では装飾にして、読み上げを二重にしない。
 * そうでない場所（レール）では label を aria-label と <title>（マウスを乗せると出る）に付ける。
 */
export function MarkSymbol(props: { kind: MarkKind; decorative?: boolean }) {
  const m: Mark = MARKS[props.kind];
  return (
    <ShapeSymbol
      shape={m.shape}
      tone={m.tone}
      live={m.live}
      kind={props.kind}
      {...(props.decorative ? {} : { label: m.label })}
    />
  );
}
