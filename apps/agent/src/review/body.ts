/**
 * PR に投稿するレビューの本文の組み立て（docs/specs/worker-review.md「レビューのコメント」）。純粋な関数だけ。
 * 本文は検査済みの JSON から rovo が組み立てる（モデルの自由文をそのまま投稿しない）。モデルが書いた文は、
 * 通知（@名前）・画像やリンク（外部への読み出し）・HTML が効かない形にしてから入れ、最後に本文全体に秘密のスキャンをかける。
 * event（COMMENT）は本文の側では決めない。投稿する側（gateway）が固定する。
 */
import { maskSecrets } from "../redact";
import type { ReviewCommandResult } from "./input";
import type { ReviewFinding, ReviewVerdict } from "./output";

/** GitHub のレビューの本文の上限（65,536 文字）より余裕を持たせた上限 */
export const MAX_REVIEW_BODY_CHARS = 60_000;
/** 失敗したコマンドの出力を本文に載せる行数（末尾） */
const FAILED_OUTPUT_LINES = 15;
const FAILED_OUTPUT_CHARS = 2_000;

/**
 * `@名前`（ユーザー・`@org/team`）をバッククォートで囲み、通知が飛ばない形にする。
 * 直前が英数字（メールアドレス）・バッククォートのものは触らない。
 */
export function neutralizeMentions(text: string): string {
  return text.replace(
    /(?<![\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]+)?)(?![\w`])/g,
    "`@$1`",
  );
}

/**
 * モデルが書いた文を、本文に入れられる形にする: バッククォート（コードの囲みを壊す）を ' に、
 * Markdown の [ ] を無効化（画像・リンクで外部に読み出させない）、< > を実体参照に（HTML を効かせない）。
 */
function plain(text: string): string {
  return text
    .replaceAll("`", "'")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 出力を囲むコードフェンス（出力の中のどのバッククォートの並びより長くする） */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const tailLines = (text: string) => {
  const lines = text.replace(/\s+$/, "").split("\n");
  const kept = lines.slice(-FAILED_OUTPUT_LINES).join("\n");
  return kept.length <= FAILED_OUTPUT_CHARS ? kept : kept.slice(-FAILED_OUTPUT_CHARS);
};

function findingLines(list: ReviewFinding[]): string[] {
  return list.map((f, i) => {
    const where = `\`${f.path.replaceAll("`", "'")}${f.line !== null ? `:${f.line}` : ""}\``;
    const change = f.change !== "" ? `\n   - 求める変更: ${plain(f.change)}` : "";
    return `${i + 1}. ${where}（${f.severity}）\n   - 理由: ${plain(f.reason)}${change}`;
  });
}

const status = (r: ReviewCommandResult) =>
  r.skipped
    ? "未実行（時間の上限）"
    : r.timedOut
      ? "タイムアウト"
      : r.exitCode === 0
        ? "成功"
        : `失敗（exit ${r.exitCode}）`;

export interface ReviewBodyArgs {
  /** レビューを書いたモデル */
  model: string;
  /** レビューした head の SHA */
  headSha: string;
  verdict: ReviewVerdict;
  /** review_commands の結果（伏せ字・切り詰め済みのもの） */
  commands: ReviewCommandResult[];
  commandsUnavailable: boolean;
  /** 差分の一部をモデルに渡していない */
  diffPartial: boolean;
  /** レビューの段の時間の上限に達して、残りのコマンドを飛ばした */
  timedOut: boolean;
}

/** 本文を組み立てる。redacted は、本文に秘密らしい文字列があって伏せ字にしたか */
export function buildReviewBody(args: ReviewBodyArgs): { body: string; redacted: boolean } {
  const { verdict } = args;
  const out: string[] = [];
  out.push(`## rovo のレビュー（${plain(args.model)}、${args.headSha.slice(0, 7)}）`);
  out.push(
    "このレビューは rovo がモデルに書かせたものです（コメントだけで、承認・変更の要求ではありません）。判断はレビューする人が行ってください。",
  );
  const notes: string[] = [];
  if (args.diffPartial)
    notes.push("差分の一部は未確認です（大きすぎたため、切り詰めて渡しました）。");
  if (args.commandsUnavailable)
    notes.push("全体のテストを実行できなかったため、差分だけを読んでいます。");
  if (args.timedOut)
    notes.push("レビューの時間の上限に達したため、一部のテストを実行していません。");
  if (notes.length > 0) out.push(notes.map((n) => `> ${n}`).join("\n"));
  if (verdict.summary !== "") out.push(`### 概要\n\n${plain(verdict.summary)}`);

  out.push(
    `### 直すべき点（${verdict.mustFix.length} 件）\n\n${
      verdict.mustFix.length > 0 ? findingLines(verdict.mustFix).join("\n") : "ありません。"
    }`,
  );
  out.push(
    `### 提案（${verdict.suggestions.length} 件）\n\n直さなくてよい提案です。直すかどうかは判断に任せます。\n\n${
      verdict.suggestions.length > 0 ? findingLines(verdict.suggestions).join("\n") : "ありません。"
    }`,
  );

  const tests: string[] = [];
  if (args.commandsUnavailable) {
    tests.push("テストを実行できなかったため、結果はありません。");
  } else if (args.commands.length === 0) {
    tests.push("テストのコマンドは指定されていません（差分だけのレビュー）。");
  } else {
    for (const r of args.commands) {
      tests.push(`- \`${r.argv.join(" ").replaceAll("`", "'")}\`: ${status(r)}`);
      if (!r.skipped && (r.exitCode !== 0 || r.timedOut) && r.output.trim() !== "") {
        tests.push(fenced(tailLines(r.output)));
      }
    }
  }
  out.push(`### 全体のテスト\n\n${tests.join("\n")}`);

  let body = neutralizeMentions(out.join("\n\n"));
  if (body.length > MAX_REVIEW_BODY_CHARS) {
    const note = "\n\n（本文が長すぎるため、ここで切りました）";
    body = body.slice(0, MAX_REVIEW_BODY_CHARS - note.length) + note;
  }
  const masked = maskSecrets(body);
  return { body: masked, redacted: masked !== body };
}
