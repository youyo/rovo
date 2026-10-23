/** 資格情報らしき文字列をマスクする。出力に混ざったトークンをモデルやログへ渡さないための最後の砦（網羅は保証しない）。 */
const MASK = "[REDACTED]";

/**
 * [正規表現, 置換, push を止めるカテゴリ]。3 つ目があるものだけが findBlockingSecrets の対象（確度の高いもの）。
 * Authorization / Bearer / cookie などのヘッダ・クエリの token=・CLI のフラグ・aws_secret_access_key= は、
 * 誤検知が多いので止める対象にしない（マスクだけ行う）。正規表現は maskSecrets と共有する。
 */
const PATTERNS: [RegExp, string, string?][] = [
  // 秘密鍵ブロック
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    MASK,
    "private-key",
  ],
  // GitHub のトークン
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK, "github-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK, "github-token"],
  // Anthropic / OpenAI 形式
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, MASK, "anthropic-key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, MASK, "openai-key"],
  // AWS
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK, "aws-access-key"],
  [/(aws_secret_access_key\s*[=:]\s*)\S+/gi, `$1${MASK}`],
  // Authorization ヘッダ / Bearer トークン
  [/(authorization\s*:\s*)(?:bearer|token|basic)?\s*[^\s'"]+(?:\s+[^\s'"]+)?/gi, `$1${MASK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  // URL に埋め込まれた認証情報
  // scheme は 32 字までで、語の先頭からだけ（ReDoS 対策: 入力長に対して線形に保つ）
  [
    /((?<![\w+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
    `$1${MASK}$2`,
    "url-credentials",
  ],
  // URL エンコードされた GitHub のトークン（ghp%5F... / github%5Fpat%5F...）
  [/\bgh[pousr]%5F[A-Za-z0-9]{20,}/gi, MASK, "github-token"],
  [/\bgithub%5Fpat%5F(?:[A-Za-z0-9]|%5F){20,}/gi, MASK, "github-token"],
  // Slack / Stripe / Google
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK, "slack-token"],
  [/\b[sr]k_live_[A-Za-z0-9]{10,}/g, MASK, "stripe-key"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, MASK, "google-api-key"],
  // JWT（ヘッダ.ペイロード.署名）
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK, "jwt"],
  // 秘密を運ぶヘッダ（行末まで）
  [/\b((?:x-auth-key|x-api-key|set-cookie|cookie)[ \t]*:[ \t]*)[^\n]+/gi, `$1${MASK}`],
  // クエリの access_token= / token= / api_key=
  [/([?&](?:access_token|token|api_key|apikey)=)[^&\s"'#]+/gi, `$1${MASK}`],
  // CLI フラグの値（--token v / --token=v / --password / --api-key / --secret など。--token-limit のような別の名前は対象外）
  [
    /((?<![\w-])--(?:token|access-token|password|passwd|api-?key|secret|client-secret)(?:=|[ \t]+))(?:"[^"\n]*"|'[^'\n]*'|(?!-)[^\s"']+)/gi,
    `$1${MASK}`,
  ],
];

/** 値が秘密らしくない（空・8 文字未満・数字だけ・true/false/null）か。クォートは外して見る */
function isPlainValue(value: string): boolean {
  const inner = /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value;
  return inner.length < 8 || /^\d+$/.test(inner) || /^(?:true|false|null)$/i.test(inner);
}

/**
 * JSON / YAML 風の `"token": "..."` / `password: ...`（キー名は token・password・secret・api_key で終わるもの。大文字小文字を問わない）。
 * 値が秘密らしくないもの（"max_tokens": 4096 など。キーが token で終わらないものも）は残す。クォートの形は保つ。
 */
// ReDoS 対策: 開始位置は語の先頭だけ（(?<![\w.-])）、キー名は 64 字までの上限つき。入力長に対して線形に保つ
const KEY_VALUE =
  /(?<![\w.-])(["']?[\w.-]{0,64}?(?:token|password|passwd|secret|api[_-]?key)["']?[ \t]*:[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,}\]"']+)/gi;

function maskKeyValue(text: string): string {
  return text.replace(KEY_VALUE, (match: string, prefix: string, value: string) => {
    if (isPlainValue(value)) return match;
    const q = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
    return `${prefix}${q}${MASK}${q}`;
  });
}

/**
 * 環境変数の代入（FOO_TOKEN=... / API_KEY="..." / export DB_PASSWORD=...）。名前が大文字の env 形式で、秘密らしい語を含むものだけ。
 * 値が空・数字だけ・true/false・8 文字未満のものは秘密らしくない（MAX_TOKENS=4096 など）ので残す。
 * 名前は 2 通り: 大文字の env 形式（GITHUB_TOKEN。語の途中でも可）と、`_` 区切りの語のうち 1 つが秘密らしい語そのものの形
 * （token=... / export db_password=... / DB_password=...。mytokens・tokenizer は対象外）。どちらも長さに上限を持つ（ReDoS 対策）。
 */
const ENV_ASSIGN_UPPER =
  /(\b[A-Z0-9_]{0,64}?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Z0-9_]{0,64}=)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g;
const ENV_ASSIGN_WORDS =
  /((?<!\w)(?:[A-Za-z0-9]{1,32}_){0,6}(?:token|secret|password|passwd|api_?key|private_?key|credentials?)(?:_[A-Za-z0-9]{1,32}){0,6}=)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi;

function maskEnvAssign(text: string): string {
  // 伏せ済みの値（先に他のパターンが処理したもの）は触らない
  const replacer = (match: string, prefix: string, value: string) =>
    isPlainValue(value) || value.startsWith(MASK) ? match : `${prefix}${MASK}`;
  return text.replace(ENV_ASSIGN_UPPER, replacer).replace(ENV_ASSIGN_WORDS, replacer);
}

export function maskSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return maskEnvAssign(maskKeyValue(out));
}

export interface BlockingFinding {
  /** 見つけた種類（固定の名前。一致した値は含めない） */
  category: string;
  /** 一致が始まる行（text の中で 1 始まり） */
  line: number;
}

/**
 * push を止めるべき、確度の高い秘密（秘密鍵・GitHub / Anthropic / OpenAI / AWS / Slack / Stripe / Google のトークン・JWT・
 * URL に埋め込まれた資格）を探す。カテゴリごとに最初の一致だけを、現れる順に返す。一致した値そのものは返さない。
 * ヘッダ・クエリ・CLI フラグ・env の推測系は対象外（maskSecrets がマスクするだけ）。
 */
export function findBlockingSecrets(text: string): BlockingFinding[] {
  const found: (BlockingFinding & { index: number })[] = [];
  for (const [re, , category] of PATTERNS) {
    if (!category) continue;
    // g フラグの正規表現は lastIndex を持つので、毎回先頭から探す
    re.lastIndex = 0;
    const m = re.exec(text);
    re.lastIndex = 0;
    if (!m) continue;
    const line = text.slice(0, m.index).split("\n").length;
    const prev = found.find((f) => f.category === category);
    if (!prev) found.push({ category, line, index: m.index });
    else if (m.index < prev.index) Object.assign(prev, { line, index: m.index });
  }
  return found.sort((a, b) => a.index - b.index).map(({ category, line }) => ({ category, line }));
}
