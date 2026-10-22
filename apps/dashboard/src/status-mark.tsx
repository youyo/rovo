import { MARKS, type MarkKind } from "./status";

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

/** 表と凡例の小さな印（装飾。意味は隣の文字が持つ）。 */
export function MarkGlyph(props: { kind: MarkKind }) {
  return (
    <svg
      className="glyph"
      width={8}
      height={16}
      viewBox="0 0 8 16"
      aria-hidden="true"
      focusable="false"
    >
      <MarkRect kind={props.kind} x={0} y={0} width={8} height={16} />
    </svg>
  );
}
