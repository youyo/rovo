import { WorkerEntrypoint } from "cloudflare:workers";
import { decideOutbound } from "./outbound-policy";

export interface OutboundGatewayProps {
  repo?: { owner: string; name: string };
}

/** コンテナから上流へ渡してよいリクエストヘッダ。Authorization / Cookie / Host などは渡さない。 */
const FORWARD_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "content-encoding",
  "user-agent",
  "git-protocol",
  "if-none-match",
  "if-modified-since",
  "range",
  "cache-control",
  "pragma",
];

/** 転送用ヘッダを許可リストで組み立て直す。 */
export function buildUpstreamHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = source.get(name);
    if (v !== null) out.set(name, v);
  }
  return out;
}

/**
 * Sandbox のコンテナからの外向き通信をすべて受け、ホストごとに許可・拒否を判定する。
 * 許可判定は outbound-policy.ts の純粋関数。拒否は 403 を返し、違反として記録する。
 * 宛先は request.url のホストで決め、上流は HTTPS 固定・redirect 手動で自前に組み立てて送る。
 */
export class OutboundGateway extends WorkerEntrypoint<Env, OutboundGatewayProps> {
  override async fetch(request: Request): Promise<Response> {
    const upgrade =
      request.headers.has("upgrade") ||
      (request.headers.get("connection") ?? "").toLowerCase().includes("upgrade");
    const decision = decideOutbound(
      { method: request.method, url: request.url, upgrade },
      { repo: this.ctx.props?.repo },
    );
    const url = new URL(request.url);
    if (!decision.allow) {
      // query や body は残さない（トークンなどが含まれうる）
      console.warn(
        `outbound denied: ${request.method} ${url.protocol}//${url.host}${url.pathname}: ${decision.reason}`,
      );
      return new Response(`rovo: outbound request denied (${decision.reason})\n`, { status: 403 });
    }
    const headers = buildUpstreamHeaders(request.headers);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const init: RequestInit = {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      // 自動で追うと次の行き先が判定を通らない。3xx はそのままコンテナへ返し、再度ここを通させる。
      redirect: "manual",
    };
    // E2E 用: 許可した通信だけを偽サーバーへ向ける（判定そのものは本物のまま通す）。
    if (this.env.ENVIRONMENT === "test" && this.env.TEST_UPSTREAM) {
      headers.set("x-original-host", url.hostname);
      return fetch(new URL(url.pathname + url.search, this.env.TEST_UPSTREAM), init);
    }
    return fetch(`https://${url.hostname}${url.pathname}${url.search}`, init);
  }
}
