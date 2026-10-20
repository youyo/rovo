const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** ULID（48bit 時刻 + 80bit 乱数）。時刻順に辞書順で並ぶ。 */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[(bytes[i] ?? 0) & 31];
  return time + random;
}

const TASK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** task_id の形式（ULID）かどうか。クライアント入力から DO を作らないための事前チェックに使う。 */
export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID_RE.test(value);
}

/** ULID の時刻部分（epoch ms）。形が合わなければ undefined。 */
export function ulidTime(value: string): number | undefined {
  if (!TASK_ID_RE.test(value)) return undefined;
  let t = 0;
  for (const ch of value.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}

const CONSULT_ID_RE = /^consult-[0-9A-HJKMNP-TV-Z]{26}$/;

/** consult の ID（`consult-<ULID>`。AgentDO のインスタンス名と task_budget の行のキーに使う）。 */
export function newConsultId(now: number = Date.now()): string {
  return `consult-${ulid(now)}`;
}

export function isConsultId(value: unknown): value is string {
  return typeof value === "string" && CONSULT_ID_RE.test(value);
}
