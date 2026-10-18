import { isForbiddenHost } from "./url-policy";

/**
 * web_browse の事前検査（補助）: ホスト名を DNS over HTTPS（Cloudflare の 1.1.1.1。`cloudflare-dns.com/dns-query`）で
 * A / AAAA に解決し、answer の IP が url-policy の禁止範囲（private / loopback / link-local / CGNAT など）なら "private" にする。
 *
 * - 補助の層であり、保証ではない。解決後に別のアドレスへ変わる DNS rebinding は防げない。
 * - 失敗は fail-closed: A / AAAA のどちらかの問い合わせが失敗したら "failed"（検査できなかったものを通さない）。
 *   NXDOMAIN も失敗として扱う（ブラウザの解決と食い違う名前を、検査済みとして通さない）。
 */

export type Resolution = "public" | "private" | "failed";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 3_000;
const MAX_DOH_BYTES = 64 * 1024;
const TYPE_A = 1;
const TYPE_AAAA = 28;

/** IP リテラル（IPv6 の角括弧付き・IPv4 の dotted-quad）。checkUrl が判定済みなので、DoH にかけない。 */
export function isIpLiteralHost(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

type Query = { ips: string[] } | "failed";

async function query(name: string, type: "A" | "AAAA", fetchImpl: typeof fetch): Promise<Query> {
  try {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/dns-json" },
      redirect: "manual",
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return "failed";
    }
    const text = await res.text();
    if (text.length > MAX_DOH_BYTES) return "failed";
    const body = JSON.parse(text) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return "failed";
    const b = body as { Status?: unknown; Answer?: unknown };
    if (b.Status !== 0) return "failed";
    // Answer は、答えが空のとき（AAAA が無い名前など）に省略される
    if (b.Answer === undefined) return { ips: [] };
    if (!Array.isArray(b.Answer)) return "failed";
    const wanted = type === "A" ? TYPE_A : TYPE_AAAA;
    const ips: string[] = [];
    for (const a of b.Answer) {
      if (typeof a !== "object" || a === null) return "failed";
      const rec = a as { type?: unknown; data?: unknown };
      // CNAME など、アドレス以外の答えは読み飛ばす
      if (rec.type !== wanted) continue;
      if (typeof rec.data !== "string") return "failed";
      ips.push(rec.data);
    }
    return { ips };
  } catch {
    return "failed";
  }
}

export async function checkResolution(
  hostname: string,
  fetchImpl: typeof fetch,
): Promise<Resolution> {
  const [a, aaaa] = await Promise.all([
    query(hostname, "A", fetchImpl),
    query(hostname, "AAAA", fetchImpl),
  ]);
  if (a === "failed" || aaaa === "failed") return "failed";
  const ips = [...a.ips, ...aaaa.ips];
  // どのアドレスも得られない名前は検査できていない（NODATA など）。通さない
  if (ips.length === 0) return "failed";
  // 禁止範囲の判定は URL の host と同じ関数を使う（IPv4-mapped / NAT64 などの形も同じ規則で拒否する）
  if (ips.some((ip) => isForbiddenHost(ip))) return "private";
  return "public";
}
