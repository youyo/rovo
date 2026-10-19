/**
 * 認可の許可ルール（ログインとツール呼び出しで共通）。
 *
 * ルールは 2 つあり、どちらも任意。少なくとも 1 つが完全に設定されている必要があり、どちらかを満たせば許可（OR）。
 * - org/team: ALLOWED_ORG と ALLOWED_TEAM は対。片方だけなら設定の誤り（null。fail closed）
 * - user ID: ALLOWED_USER_IDS はカンマ区切りの正の整数。1 つでも不正な要素があれば設定全体が不正（null）
 * 設定が不正・不足なら null を返し、呼び出し側は必ず拒否する。
 */

export interface AllowRules {
  /** org/team のルール。無ければ null */
  team: { org: string; team: string } | null;
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
  // 片方だけは設定の誤り。user ID のルールに切り替えない
  if ((org === "") !== (team === "")) return null;
  const userIds = parseUserIds(env.ALLOWED_USER_IDS);
  if (userIds === "invalid") return null;
  const teamRule = org !== "" ? { org, team } : null;
  if (!teamRule && !userIds) return null;
  return { team: teamRule, userIds };
}

/** user ID のルールで許可されるか（ルールが無ければ false）。呼び出し側は GET /user で得た id を渡す。 */
export function isUserIdAllowed(rules: AllowRules, userId: number): boolean {
  return rules.userIds?.has(userId) ?? false;
}
