/** 資格情報らしき文字列をマスクする。出力に混ざったトークンをモデルやログへ渡さないための最後の砦（網羅は保証しない）。 */
const MASK = "[REDACTED]";

const PATTERNS: [RegExp, string][] = [
  // 秘密鍵ブロック
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // GitHub のトークン
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  // Anthropic / OpenAI 形式
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, MASK],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, MASK],
  // AWS
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/(aws_secret_access_key\s*[=:]\s*)\S+/gi, `$1${MASK}`],
  // Authorization ヘッダ / Bearer トークン
  [/(authorization\s*:\s*)(?:bearer|token|basic)?\s*[^\s'"]+(?:\s+[^\s'"]+)?/gi, `$1${MASK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  // URL に埋め込まれた認証情報
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, `$1${MASK}$2`],
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
