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
 * 記号ごとの図形（16 x 16。色は CSS の color = currentColor。線は stroke、塗りは .mark-fill）。
 * どの 2 つも違う形にして、色が分からなくても（白黒でも）見分けられるようにする。MarkShape が増えるとコンパイルエラー。
 */
const SHAPES = {
  // 準備中: 3 つの点（待っている）
  dots: (
    <>
      <circle className="mark-fill" cx={3} cy={8} r={1.7} />
      <circle className="mark-fill" cx={8} cy={8} r={1.7} />
      <circle className="mark-fill" cx={13} cy={8} r={1.7} />
    </>
  ),
  // 実行中: 回る輪（4 分の 3 だけの輪）
  spinner: <path d="M8 2.5A5.5 5.5 0 1 1 2.5 8" />,
  // 入力待ち: ！
  bang: (
    <>
      <path d="M8 2.5v6.5" />
      <circle className="mark-fill" cx={8} cy={13} r={1.4} />
    </>
  ),
  // 検証中: 虫めがね
  magnifier: (
    <>
      <circle cx={7} cy={7} r={4.5} />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  // 復旧中: 戻る矢印
  return: (
    <>
      <path d="M13 13V9a3.5 3.5 0 0 0-3.5-3.5H3.5" />
      <path d="M6.5 2.5l-3 3 3 3" />
    </>
  ),
  // マージ済み: 塗りの丸
  disc: <circle className="mark-fill" cx={8} cy={8} r={6.5} />,
  // レビュー待ち: 中空の丸
  ring: <circle cx={8} cy={8} r={5.5} />,
  // 閉じた: 斜線の入った丸（マージせずに閉じた）
  slash: (
    <>
      <circle cx={8} cy={8} r={5.5} />
      <path d="M4.1 11.9L11.9 4.1" />
    </>
  ),
  // PR あり（状態が取れなかった）: 中に点のある丸
  target: (
    <>
      <circle cx={8} cy={8} r={5.5} />
      <circle className="mark-fill" cx={8} cy={8} r={1.8} />
    </>
  ),
  // 完了（PR なし）: チェック
  check: <path d="M2.5 8.5l3.8 3.8 7.2-8" />,
  // 失敗: ×
  cross: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  // 予算超過: 上限の線に向かって上がる矢印
  rise: (
    <>
      <path d="M2.5 2.5h11" />
      <path d="M8 14V6" />
      <path d="M4.8 9L8 5.8 11.2 9" />
    </>
  ),
  // キャンセル: 止める四角
  square: <rect className="mark-fill" x={3} y={3} width={10} height={10} rx={1.5} />,
} as const satisfies Record<MarkShape, ReactNode>;

/**
 * 状態の印（記号 + 色）。レール・コンソールの見出し・凡例で同じものを使う。
 * 大きさは周りの文字に合わせる（CSS の .mark-sym の em）。色は tone のクラス（トークンだけ）。動いている状態は脈動する。
 * decorative: 隣に状態の文字がある場所（凡例・見出し・バッジ）では装飾にして、読み上げを二重にしない。
 * そうでない場所（レール）では label を aria-label と <title>（マウスを乗せると出る）に付ける。
 */
export function MarkSymbol(props: { kind: MarkKind; decorative?: boolean }) {
  const m: Mark = MARKS[props.kind];
  const common = {
    className: `mark-sym mark-sym--${m.tone}${m.live ? " pulse" : ""}`,
    viewBox: "0 0 16 16",
    focusable: "false",
    "data-mark": props.kind,
    "data-shape": m.shape,
  } as const;
  if (props.decorative) {
    return (
      <svg {...common} aria-hidden="true">
        {SHAPES[m.shape]}
      </svg>
    );
  }
  return (
    <svg {...common} role="img" aria-label={m.label}>
      <title>{m.label}</title>
      {SHAPES[m.shape]}
    </svg>
  );
}
