/**
 * ダッシュボードの API（/dashboard/api/*）の入口の検査（docs/specs/dashboard.md D11・CSRF の節）。
 * CORS ヘッダは出さない（別サイトの JavaScript から読ませない）。
 */

export function jsonResponse(status: number, body: unknown, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/**
 * Sec-Fetch-Site によるクロスサイト拒否。API の呼び出しはすべてナビゲーションではなく fetch なので、
 * ブラウザが必ず付けるはずのヘッダが無い呼び出し（古いクライアント・curl・ヘッダを剥ぐ中継）は拒否する（M4 で決定）。
 *
 * - 読み取り（GET / HEAD）: same-origin と none（アドレスバーからの直接アクセス）を通す
 * - 状態を変える呼び出し（POST など）: same-origin だけ。さらに Origin ヘッダがあれば、公開 URL の origin と一致すること
 *   （Origin を公開 URL の設定で固定し、Host ヘッダの書き換えに左右されない）
 *
 * 通れば null、拒否なら 403 の応答を返す。理由は本文に出さない。
 */
export function fetchSiteGate(
  request: Request,
  env: Pick<Env, "PUBLIC_BASE_URL">,
): Response | null {
  const forbidden = () => jsonResponse(403, { error: "forbidden" });
  const site = request.headers.get("sec-fetch-site");
  const method = request.method.toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating) {
    if (site !== "same-origin") return forbidden();
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== publicOrigin(env)) return forbidden();
    return null;
  }
  if (site === "same-origin" || site === "none") return null;
  return forbidden();
}

function publicOrigin(env: Pick<Env, "PUBLIC_BASE_URL">): string | null {
  try {
    return new URL(env.PUBLIC_BASE_URL).origin;
  } catch {
    return null; // 設定が不正なら、Origin ヘッダがある状態更新は拒否される（null と一致しない）
  }
}
