/**
 * レビューのモデルの答え（JSON）の検査（docs/specs/worker-review.md「出力の検査」）。純粋な関数だけ。
 * 受け取るのは must_fix / suggestions / summary だけで、それ以外の項目（event・approve など）は捨てる
 * （投稿の event は rovo が COMMENT に固定する。モデルの出力が行動を決めない）。
 */

export const MAX_MUST_FIX = 10;
export const MAX_SUGGESTIONS = 20;
const MAX_PATH = 500;
const MAX_TEXT = 2000;
const MAX_SUMMARY = 2000;

export type Severity = "high" | "medium" | "low";
const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];

export interface ReviewFinding {
  path: string;
  /** 変更後のファイルの行（1 始まり）。suggestions で 1 行に結び付かないときだけ null */
  line: number | null;
  reason: string;
  change: string;
  severity: Severity;
}

export interface ReviewVerdict {
  summary: string;
  mustFix: ReviewFinding[];
  suggestions: ReviewFinding[];
}

export type ParsedReview =
  | {
      ok: true;
      verdict: ReviewVerdict;
      /** 差分に無いパスを指していたので捨てた件数（警告にはしない） */
      droppedUnknownPath: number;
      /** 件数の上限で切った件数 */
      cut: { mustFix: number; suggestions: number };
    }
  | { ok: false; code: "not_json" | "schema_mismatch" };

const clip = (s: string, n: number) => (s.length <= n ? s : Array.from(s).slice(0, n).join(""));

/** 答えの全体が 1 つのコードブロックなら中身を取り出す（モデルがよく付けるため）。それ以外はそのまま */
function unfence(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  return m ? (m[1] as string) : t;
}

function finding(raw: unknown, lineRequired: boolean): ReviewFinding | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || r.path.trim() === "") return undefined;
  if (typeof r.reason !== "string" || r.reason.trim() === "") return undefined;
  const lineOk =
    (typeof r.line === "number" && Number.isSafeInteger(r.line) && r.line >= 1) ||
    (!lineRequired && (r.line === null || r.line === undefined));
  if (!lineOk) return undefined;
  if (r.change !== undefined && typeof r.change !== "string") return undefined;
  if (lineRequired && (typeof r.change !== "string" || r.change.trim() === "")) return undefined;
  if (r.severity !== undefined && !SEVERITIES.includes(r.severity as Severity)) return undefined;
  return {
    path: clip(r.path.trim(), MAX_PATH),
    line: typeof r.line === "number" ? r.line : null,
    reason: clip(r.reason.trim(), MAX_TEXT),
    change: clip(typeof r.change === "string" ? r.change.trim() : "", MAX_TEXT),
    severity: (r.severity as Severity | undefined) ?? "medium",
  };
}

const rank = (s: Severity) => SEVERITIES.indexOf(s);

/** 重要度の順（同じ重要度はモデルが書いた順）に並べ、上限で切る */
function top(list: ReviewFinding[], max: number): { kept: ReviewFinding[]; cut: number } {
  const sorted = list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f.severity) - rank(b.f.severity) || a.i - b.i)
    .map(({ f }) => f);
  return { kept: sorted.slice(0, max), cut: Math.max(0, sorted.length - max) };
}

/**
 * 答えを検査する。paths は差分に現れるパス（それ以外を指す指摘は捨てる）。
 * JSON でなければ not_json、形が違えば schema_mismatch（呼び出し側が 1 回だけ再要求する）。
 */
export function parseReviewResponse(text: string, paths: readonly string[]): ParsedReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(text));
  } catch {
    return { ok: false, code: "not_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "schema_mismatch" };
  }
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.must_fix) || !Array.isArray(p.suggestions)) {
    return { ok: false, code: "schema_mismatch" };
  }
  if (p.summary !== undefined && p.summary !== null && typeof p.summary !== "string") {
    return { ok: false, code: "schema_mismatch" };
  }
  const mustFix: ReviewFinding[] = [];
  const suggestions: ReviewFinding[] = [];
  for (const [list, out, lineRequired] of [
    [p.must_fix, mustFix, true],
    [p.suggestions, suggestions, false],
  ] as const) {
    for (const raw of list) {
      const f = finding(raw, lineRequired);
      if (!f) return { ok: false, code: "schema_mismatch" };
      out.push(f);
    }
  }
  const known = new Set(paths);
  const inDiff = (f: ReviewFinding) => known.has(f.path);
  const dropped =
    mustFix.filter((f) => !inDiff(f)).length + suggestions.filter((f) => !inDiff(f)).length;
  const m = top(mustFix.filter(inDiff), MAX_MUST_FIX);
  const s = top(suggestions.filter(inDiff), MAX_SUGGESTIONS);
  return {
    ok: true,
    verdict: {
      summary: typeof p.summary === "string" ? clip(p.summary.trim(), MAX_SUMMARY) : "",
      mustFix: m.kept,
      suggestions: s.kept,
    },
    droppedUnknownPath: dropped,
    cut: { mustFix: m.cut, suggestions: s.cut },
  };
}
