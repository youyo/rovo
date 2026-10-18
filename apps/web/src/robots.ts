/**
 * robots.txt の確認（RFC 9309 の範囲）。web_fetch は、取得の前に robots.txt を確かめ、Disallow なら取得しない。
 * User-Agent の製品トークンは rovo 固有の名前を使う。
 */

export const ROBOTS_TOKEN = "rovo-web";
export const USER_AGENT = `${ROBOTS_TOKEN}/1.0`;

const MAX_ROBOTS_BYTES = 512 * 1024;
/** isolate のメモリに置く期間（web は永続の状態を持たない） */
export const ROBOTS_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ROBOTS_REDIRECTS = 5;
const ROBOTS_TIMEOUT_MS = 5_000;

export type RobotsRule = { allow: boolean; pattern: string };
export type RobotsRules = RobotsRule[];

type Group = { agents: string[]; rules: RobotsRule[] };

export function parseRobots(text: string, token: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (!current) continue;
      // 空の Disallow は何も禁止しない。空の Allow も意味がない
      if (value === "") continue;
      current.rules.push({ allow: field === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = token.toLowerCase();
  const specific = groups.filter((g) => g.agents.includes(mine));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/** path は `pathname + search`。最も長く一致したルールが勝ち、同じ長さなら Allow。 */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!patternToRegExp(r.pattern).test(path)) continue;
    if (
      !best ||
      r.pattern.length > best.pattern.length ||
      (r.pattern.length === best.pattern.length && r.allow && !best.allow)
    ) {
      best = r;
    }
  }
  return best ? best.allow : true;
}

export type RobotsCheck = {
  allowed: boolean;
  reason?: "robots_disallowed" | "robots_unreachable";
};

/** origin → 取得済みのルール。取得できたものだけを置く（fail-closed の結果は置かない） */
export type RobotsCache = Map<string, { rules: RobotsRules; expiresAt: number }>;
const sharedRobotsCache: RobotsCache = new Map();

export type RobotsCheckerOptions = {
  fetch: typeof fetch;
  /** robots.txt の redirect 先を検査する（許可外なら throw する）。URL ポリシーを渡す */
  assertUrl?: (url: URL) => void;
  token?: string;
  userAgent?: string;
  /** 省略すると isolate 共有のキャッシュ（10 分）。テストでは新しい Map を渡す */
  cache?: RobotsCache;
  now?: () => number;
};

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.byteLength - off);
    all.set(c.subarray(0, take), off);
    off += take;
    if (off >= all.byteLength) break;
  }
  return new TextDecoder().decode(all);
}

/** origin ごとに robots.txt を1回だけ取得してキャッシュする。1回の取得リクエストの間だけ生きる想定。 */
export function createRobotsChecker(options: RobotsCheckerOptions) {
  const token = options.token ?? ROBOTS_TOKEN;
  const userAgent = options.userAgent ?? USER_AGENT;
  const cache = options.cache ?? sharedRobotsCache;
  const now = options.now ?? Date.now;
  const inflight = new Map<string, Promise<RobotsRules | "unreachable">>();

  async function load(origin: string, signal?: AbortSignal): Promise<RobotsRules | "unreachable"> {
    try {
      let current = new URL("/robots.txt", origin);
      const timeout = AbortSignal.timeout(ROBOTS_TIMEOUT_MS);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      for (let hop = 0; hop <= MAX_ROBOTS_REDIRECTS; hop++) {
        const res = await options.fetch(current.href, {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": userAgent, accept: "text/plain, */*;q=0.1" },
          signal: sig,
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          const next = new URL(res.headers.get("location") as string, current);
          await res.body?.cancel().catch(() => {});
          options.assertUrl?.(next);
          current = next;
          continue;
        }
        if (res.status >= 200 && res.status < 300) {
          return parseRobots(await readCapped(res, MAX_ROBOTS_BYTES), token);
        }
        await res.body?.cancel().catch(() => {});
        // 4xx: robots.txt なし（すべて許可）。5xx など: 取得できない（RFC 9309 ではすべて不許可として扱う）
        return res.status >= 400 && res.status < 500 ? [] : "unreachable";
      }
      return "unreachable";
    } catch {
      return "unreachable";
    }
  }

  return {
    async check(url: URL, signal?: AbortSignal): Promise<RobotsCheck> {
      // robots.txt 自体は取得できる（循環しない）
      if (url.pathname === "/robots.txt") return { allowed: true };
      const hit = cache.get(url.origin);
      let rules: RobotsRules | "unreachable";
      if (hit && hit.expiresAt > now()) {
        rules = hit.rules;
      } else {
        let entry = inflight.get(url.origin);
        if (!entry) {
          entry = load(url.origin, signal);
          inflight.set(url.origin, entry);
        }
        rules = await entry;
        if (rules !== "unreachable") {
          cache.set(url.origin, { rules, expiresAt: now() + ROBOTS_CACHE_TTL_MS });
        }
      }
      if (rules === "unreachable") return { allowed: false, reason: "robots_unreachable" };
      return isPathAllowed(rules, url.pathname + url.search)
        ? { allowed: true }
        : { allowed: false, reason: "robots_disallowed" };
    },
  };
}
