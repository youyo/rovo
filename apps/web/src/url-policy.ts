import { isPrivateOrLocalHost } from "agents/webfetch";

/**
 * Web Research の URL ポリシー（純粋関数）。web_search の結果の URL、web_fetch の取得先、
 * redirect の行き先のすべてに同じものを使う。
 *
 * `agents/webfetch` の `isPrivateOrLocalHost`（private / loopback / link-local / CGNAT / 予約・IPv6 の各形式・
 * IP の表記ゆれ・localhost・.localhost・.internal）に、`.local` を足している。
 * スキーム・userinfo・ポート（80 / 443 のみ）はここで検査する（webfetch は検査しない）。
 */

export type UrlRejection =
  | "invalid_url"
  | "too_long"
  | "scheme"
  | "userinfo"
  | "port"
  | "private_host";

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: UrlRejection; message: string };

export const MAX_URL_LENGTH = 2000;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const EXTRA_LOCAL_SUFFIXES = [".local"];

/** IPv4 の dotted-quad を 4 つの数値にする（それ以外の表記は null。表記ゆれは URL パーサと webfetch 側が扱う）。 */
function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** IPv6 を 16 ビット × 8 の配列にする（末尾の dotted-quad、`::` の省略に対応。不正なら null）。 */
function parseIPv6(host: string): number[] | null {
  let h = host.replace(/^\[|\]$/g, "");
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (tail) {
    const v4 = parseIPv4(tail[1] as string);
    if (!v4) return null;
    const hi = (((v4[0] as number) << 8) | (v4[1] as number)).toString(16);
    const lo = (((v4[2] as number) << 8) | (v4[3] as number)).toString(16);
    h = `${h.slice(0, h.length - (tail[1] as string).length)}${hi}:${lo}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] as string);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] as string);
  if (!rest || head.length + rest.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

/** IPv4 の拒否範囲（webfetch が持たないもの）: ドキュメント用 3 つ（TEST-NET-1/2/3）とベンチマーク。 */
function isExtraForbiddenIPv4(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  return a === 198 && (b === 18 || b === 19); // 198.18.0.0/15
}

/** IPv6 の拒否範囲（webfetch が持たないもの）。 */
function isExtraForbiddenIPv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5] = g as [number, number, number, number, number, number];
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo 2001:0::/32
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // ドキュメント用 2001:db8::/32
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return true; // IPv4-mapped ::ffff:0:0/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // ローカル NAT64 64:ff9b:1::/48
  return g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0; // discard 100::/64
}

function isExtraForbiddenAddress(host: string): boolean {
  if (host.includes(":")) {
    const g = parseIPv6(host);
    return g !== null && isExtraForbiddenIPv6(g);
  }
  const v4 = parseIPv4(host);
  return v4 !== null && isExtraForbiddenIPv4(v4);
}

function reject(reason: UrlRejection, message: string): UrlCheck {
  return { ok: false, reason, message };
}

/** hostname 単体の判定。`[::1]` の角括弧付きでも、`::1` の素の IPv6 でも受ける。 */
export function isForbiddenHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  host = host.replace(/\.$/, "");
  if (isPrivateOrLocalHost(host)) return true;
  if (isExtraForbiddenAddress(host)) return true;
  return EXTRA_LOCAL_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
}

export function checkUrl(input: string): UrlCheck {
  if (typeof input !== "string") return reject("invalid_url", "URL must be a string.");
  const trimmed = input.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    return reject(
      "too_long",
      `URL is ${trimmed.length} characters; the limit is ${MAX_URL_LENGTH}.`,
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject("invalid_url", "Not a valid absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return reject(
      "scheme",
      `Only http and https are allowed, not ${url.protocol.replace(/:$/, "")}.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    return reject("userinfo", "URLs with a username or password are not allowed.");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return reject("port", `Port ${url.port} is not allowed; only 80 and 443 are.`);
  }
  if (isForbiddenHost(url.hostname)) {
    return reject("private_host", `The host ${url.hostname} is a private or local address.`);
  }
  url.hash = "";
  return { ok: true, url };
}
