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
