import {
  CATEGORIES,
  type Category,
  type ModelEvaluation,
  type Safety,
  type Verdict,
} from "./types";

export type { ModelEvaluation } from "./types";

/**
 * Policy Engine: 決定論ルールと、モデル（Clef）の確率を組み合わせて verdict を出す（設計 8.6）。
 * モデルの判定は誘導され得るので、モデルの allow を安全の保証とは扱わない。
 * モデルのスコアと Policy Engine の判定は、結果の中で別々に持つ。
 */

export type PolicyThresholds = { block: number; caution: number };
export const DEFAULT_THRESHOLDS: PolicyThresholds = { block: 0.8, caution: 0.4 };

export type Finding = {
  rule: string;
  verdict: "caution" | "block";
  category: Category;
};

// ---- 決定論ルール ----

type PhraseRule = {
  rule: string;
  re: RegExp;
  verdict: "caution" | "block";
  category: Category;
};

// 照合は NFKC 正規化・隠し文字除去・小文字化・空白の圧縮をかけた文字列に対して行う
const PHRASE_RULES: PhraseRule[] = [
  {
    rule: "known_injection_phrase",
    re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|these|those|system)\b[^.\n]{0,30}\b(?:instructions?|prompts?|directives?)\b/,
    verdict: "block",
    category: "instruction_override",
  },
  {
    rule: "known_injection_phrase",
    re: /\bforget (?:everything|all of that|all that)\b[^.\n]{0,30}\b(?:you|i|we)\b/,
    verdict: "block",
    category: "instruction_override",
  },
  {
    rule: "known_injection_phrase",
    re: /\bfrom now on,? you (?:are|will|must|shall|should)\b/,
    verdict: "block",
    category: "prompt_injection",
  },
  {
    rule: "known_injection_phrase",
    re: /\bnew (?:instructions?|system prompt|task)\s*:/,
    verdict: "block",
    category: "instruction_override",
  },
  {
    rule: "system_prompt_disclosure",
    re: /\b(?:reveal|show|print|output|repeat|leak|disclose)\b[^.\n]{0,30}\b(?:system|initial|hidden|original)\s+(?:prompt|instructions?|message)\b/,
    verdict: "block",
    category: "prompt_injection",
  },
  {
    rule: "chat_template_token",
    re: /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?inst\]|<<\s*\/?sys\s*>>/,
    verdict: "block",
    category: "role_spoofing",
  },
  {
    rule: "known_injection_phrase_ja",
    re: /(?:以前|これまで|上記|前|先)の(?:指示|命令|プロンプト|ルール)を?(?:すべて|全て|全部)?(?:無視|忘れ|破棄)/,
    verdict: "block",
    category: "instruction_override",
  },
  {
    // 日本語の資格情報の外部送信。「送信します」のような説明文を拾わないよう、依頼・命令の形に限る
    rule: "credential_exfiltration",
    re: /(?:api ?キー|シークレット|トークン|認証情報|資格情報|パスワード|秘密鍵|秘密情報|クッキー|環境変数|\.env)(?:(?!入力|設定|発行|保存|作成|登録|生成|取得|更新|変更)[^。、\n]){0,60}?(?:https?:\/\/|外部|サーバー|メール|[へに])(?:(?!入力|設定|発行|保存|作成|登録|生成|取得|更新|変更)[^。、\n]){0,30}?(?:(?:送信|転送|アップロード|投稿|送付)(?:して|しろ|せよ|すること|しなさい|する事)|送(?:って|れ|りなさい)|メールして)/,
    verdict: "block",
    category: "credential_exfiltration",
  },
  {
    // 英語の資格情報の外部送信。日本語版と同様に宛先（URL・メールアドレス・webhook などの語）を条件にする。
    // 宛先がなければ「correctly send API key」のような changelog や API の使い方の文を拾うため（2026-10-22 の実機で誤検知）。
    rule: "credential_exfiltration",
    re: /\b(?:send|post|upload|email|e-mail|exfiltrate|transmit|forward|leak|submit)\b[^.\n]{0,60}\b(?:api[ _-]?keys?|secrets?|access tokens?|auth tokens?|credentials?|passwords?|private keys?|ssh keys?|\.env|cookies?|environment variables)\b(?:[^.\n]|\.(?=env\b)){0,80}(?:https?:\/\/|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b|\b(?:to|at|into)\b[^.\n]{0,25}\b(?:webhooks?|endpoints?|external|remote|attacker|third[- ]party|server)\b)/,
    verdict: "block",
    category: "credential_exfiltration",
  },
  {
    rule: "remote_script_execution",
    re: /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/,
    verdict: "caution",
    category: "tool_execution_inducement",
  },
  {
    rule: "role_spoofing_line",
    re: /(?:^|\n)\s*(?:system|assistant|developer)\s*:/,
    verdict: "caution",
    category: "role_spoofing",
  },
  {
    rule: "role_reassignment",
    re: /\byou are now\b/,
    verdict: "caution",
    category: "role_spoofing",
  },
  {
    rule: "concealment_from_user",
    re: /\b(?:do not|don't|never|without)\b[^.\n]{0,20}\b(?:tell|inform|mention|notify|alert|show)\b[^.\n]{0,20}\b(?:the )?user\b/,
    verdict: "caution",
    category: "prompt_injection",
  },
];

const HTML_COMMENT = /<!--([\s\S]*?)-->/g;
const AI_ADDRESSEE = /\b(?:ai|llm|assistant|agent|model|claude|gpt|chatgpt|chatbot|copilot)s?\b/;
const IMPERATIVE =
  /\b(?:must|should|need to|ignore|send|post|execute|run|reveal|tell|instruction|prompt|override|disregard|do not|don't|important)\b/;

// 「ロボット」の「ボット」に当たらないよう、ボットは前が片仮名でないときだけ
const AI_ADDRESSEE_JA =
  /\bai\b|エージェント|アシスタント|\bllm\b|言語モデル|チャットボット|(?<![ァ-ヶー])ボット/;
// 「AI 生成の画像を出力」のような名詞の使い方を拾わないよう、動詞は命令・依頼の形に限る
const IMPERATIVE_JA =
  /(?:実行|無視|送信|転送|アップロード|開示|出力)(?:して|しろ|せよ|すること|しなさい|する事)|伝えない|知らせない|言わない|従って|従え|してください|しなさい|せよ/;

// ゼロ幅（ZWSP・ZWNJ・Word Joiner・BOM）。LRM / RLM は右から左の文字の組版で正当に使われるので対象にしない。
const ZERO_WIDTH = /[\u200B\u200C\u2060\uFEFF]/gu;
// ZWJ は絵文字の連結で正当に使われる。前後が絵文字のときは対象にしない。
const ZWJ = /\u200D/gu;
// 双方向の上書き・isolate、Tag 文字（不可視のテキストを埋め込める）
const BIDI_OR_TAG = /[\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

function flatten(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu, "")
    .toLowerCase()
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n+/g, "\n");
}

function hasNonEmojiZwj(text: string): boolean {
  for (const m of text.matchAll(ZWJ)) {
    const i = m.index ?? 0;
    const before = Array.from(text.slice(Math.max(0, i - 2), i)).pop() ?? "";
    const after = Array.from(text.slice(i + 1, i + 3))[0] ?? "";
    const pict = /\p{Extended_Pictographic}|️/u;
    if (!(pict.test(before) && pict.test(after))) return true;
  }
  return false;
}

function hiddenCharacterFindings(raw: string): Finding[] {
  const out: Finding[] = [];
  if (BIDI_OR_TAG.test(raw)) {
    out.push({ rule: "hidden_characters", verdict: "block", category: "prompt_injection" });
    return out;
  }
  const withoutLeadingBom = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  if (
    ZERO_WIDTH.test(withoutLeadingBom) ||
    CONTROL.test(withoutLeadingBom) ||
    hasNonEmojiZwj(withoutLeadingBom)
  ) {
    out.push({ rule: "hidden_characters", verdict: "caution", category: "prompt_injection" });
  }
  ZERO_WIDTH.lastIndex = 0;
  return out;
}

function htmlCommentFindings(raw: string): Finding[] {
  const out: Finding[] = [];
  for (const m of raw.matchAll(HTML_COMMENT)) {
    const body = flatten(m[1] ?? "");
    if (
      (AI_ADDRESSEE.test(body) && IMPERATIVE.test(body)) ||
      (AI_ADDRESSEE_JA.test(body) && IMPERATIVE_JA.test(body))
    ) {
      out.push({
        rule: "html_comment_instruction",
        verdict: "block",
        category: "prompt_injection",
      });
      break;
    }
  }
  return out;
}

/** 本文（正規化前の生のテキストでよい）に決定論ルールをかける。重複する rule は verdict が強いほうを残す。 */
export function runDeterministicRules(raw: string): Finding[] {
  const findings: Finding[] = [...hiddenCharacterFindings(raw), ...htmlCommentFindings(raw)];
  const flat = flatten(raw);
  // 改行で表現を割られても検出できるよう、行頭を見るルール以外は改行を空白として扱う
  const spaced = flat.replace(/\n/g, " ");
  for (const r of PHRASE_RULES) {
    const target = r.rule === "role_spoofing_line" ? flat : spaced;
    if (r.re.test(target))
      findings.push({ rule: r.rule, verdict: r.verdict, category: r.category });
  }
  return dedupe(findings);
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.rule}|${f.verdict}|${f.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ---- 判定 ----

export type PolicyDecision = {
  verdict: Verdict;
  categories: Category[];
  reason: string;
  evaluated: boolean;
  model: { verdict: Verdict; scores: Partial<Record<Category, number>> | null };
  policy: { verdict: "allow" | "caution" | "block"; rules: string[] };
};

function maxScore(scores: Partial<Record<Category, number>>): number {
  let m = 0;
  for (const v of Object.values(scores)) if (typeof v === "number" && v > m) m = v;
  return m;
}

/**
 * - どちらかが block なら block（モデルが一部しか評価できていなくても、評価できた範囲で閾値を超えていれば block）
 * - そうでなく、モデルが評価を完了していない（失敗・未評価の部分あり・呼んでいない）なら unknown
 * - そうでなく、どちらかが caution なら caution
 * - どちらも問題なければ allow
 */
export function decide(
  input: { findings: Finding[]; model: ModelEvaluation | null },
  thresholds: PolicyThresholds,
): PolicyDecision {
  const { findings, model } = input;

  const policyVerdict: "allow" | "caution" | "block" = findings.some((f) => f.verdict === "block")
    ? "block"
    : findings.length > 0
      ? "caution"
      : "allow";

  let modelVerdict: Verdict;
  let scores: Partial<Record<Category, number>> | null = null;
  if (model === null) {
    modelVerdict = "unknown";
  } else {
    scores = model.scores;
    const top = maxScore(model.scores);
    if (top >= thresholds.block) modelVerdict = "block";
    else if (!model.complete) modelVerdict = "unknown";
    else if (top >= thresholds.caution) modelVerdict = "caution";
    else modelVerdict = "allow";
  }

  let verdict: Verdict;
  if (policyVerdict === "block" || modelVerdict === "block") verdict = "block";
  else if (modelVerdict === "unknown") verdict = "unknown";
  else if (policyVerdict === "caution" || modelVerdict === "caution") verdict = "caution";
  else verdict = "allow";

  const flagged = new Set<Category>(findings.map((f) => f.category));
  if (scores) {
    for (const c of CATEGORIES) {
      const s = scores[c];
      if (typeof s === "number" && s >= thresholds.caution) flagged.add(c);
    }
  }
  const categories = CATEGORIES.filter((c) => flagged.has(c));

  // reason は固定の理由コードとルール名だけから作る（取得先由来の文字列は入れない）。
  // 親と子のモデルまで届くので、failure などの自由文は載せない。
  const parts: string[] = [];
  for (const rule of new Set(findings.map((f) => f.rule))) parts.push(`injection_rule:${rule}`);
  if (scores) {
    for (const c of CATEGORIES) {
      if ((scores[c] ?? 0) >= thresholds.caution) parts.push(`model_score:${c}`);
    }
  }
  if (model && !model.complete) {
    parts.push(model.failure === "state_truncated" ? "state_truncated" : "evaluator_failed");
  }
  if (model === null && modelVerdict === "unknown" && verdict !== "block") {
    parts.push("model_not_performed");
  }
  const reason = parts.length > 0 ? parts.join("; ") : "no_issues";

  return {
    verdict,
    categories,
    reason,
    evaluated: model?.complete === true,
    model: { verdict: modelVerdict, scores },
    policy: { verdict: policyVerdict, rules: [...new Set(findings.map((f) => f.rule))] },
  };
}

/** 判定を 8.7 の safety の形にする。 */
export function toSafety(
  decision: PolicyDecision,
  info: { evaluator: string; modelVersion: string },
): Safety {
  return {
    evaluator: info.evaluator,
    model_version: info.modelVersion,
    verdict: decision.verdict,
    categories: decision.categories,
    reason: decision.reason,
    evaluated: decision.evaluated,
    model: decision.model,
    policy: decision.policy,
  };
}
