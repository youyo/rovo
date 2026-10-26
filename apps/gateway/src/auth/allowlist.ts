/**
 * 認可の許可ルール（ログインとツール呼び出しで共通）。
 *
 * ルールは 2 つあり、どちらも任意。少なくとも 1 つが完全に設定されている必要があり、どちらかを満たせば許可（OR）。
 * - org/team: ALLOWED_ORG と ALLOWED_TEAM があれば team の active メンバーを許可。ALLOWED_ORG だけなら org の active メンバー全員を許可。
 *   ALLOWED_TEAM だけ（org なし）は設定の誤り（null。fail closed。org の全員の許可には切り替えない）
 * - user ID: ALLOWED_USER_IDS はカンマ区切りの正の整数。1 つでも不正な要素があれば設定全体が不正（null）
 * 設定が不正・不足なら null を返し、呼び出し側は必ず拒否する。
 */

export interface AllowRules {
  /** org/team のルール。team が null なら org の active メンバー全員。ルールが無ければ null */
  membership: { org: string; team: string | null } | null;
  /** user ID のルール。無ければ null */
  userIds: ReadonlySet<number> | null;
}

export interface AllowEnv {
  ALLOWED_ORG?: string;
  ALLOWED_TEAM?: string;
  ALLOWED_USER_IDS?: string;
}

const DIGITS = /^\d+$/;

/** 不正が 1 つでもあれば "invalid"。未設定・空文字は null（ルールなし）。 */
function parseUserIds(raw: string | undefined): ReadonlySet<number> | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  const ids = new Set<number>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!DIGITS.test(s)) return "invalid"; // 空要素・符号・小数・英字
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) return "invalid";
    if (ids.has(n)) return "invalid"; // 重複
    ids.add(n);
  }
  return ids;
}

export function loadAllowRules(env: AllowEnv): AllowRules | null {
  const org = env.ALLOWED_ORG ?? "";
  const team = env.ALLOWED_TEAM ?? "";
  // team だけ（org なし）は設定の誤り。org の確認にも user ID のルールにも切り替えない
  if (org === "" && team !== "") return null;
  const userIds = parseUserIds(env.ALLOWED_USER_IDS);
  if (userIds === "invalid") return null;
  const membership = org !== "" ? { org, team: team === "" ? null : team } : null;
  if (!membership && !userIds) return null;
  return { membership, userIds };
}

/** user ID のルールで許可されるか（ルールが無ければ false）。呼び出し側は GET /user で得た id を渡す。 */
export function isUserIdAllowed(rules: AllowRules, userId: number): boolean {
  return rules.userIds?.has(userId) ?? false;
}
