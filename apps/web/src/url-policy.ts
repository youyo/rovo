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

function reject(reason: UrlRejection, message: string): UrlCheck {
  return { ok: false, reason, message };
}

/** hostname 単体の判定。`[::1]` の角括弧付きでも、`::1` の素の IPv6 でも受ける。 */
export function isForbiddenHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  host = host.replace(/\.$/, "");
  if (isPrivateOrLocalHost(host)) return true;
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
