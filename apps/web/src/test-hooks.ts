/**
 * E2E 用の差し込み口。ENVIRONMENT=test で TEST_FAKE_BASE（偽サーバーの URL）があるときだけ有効。
 * production では TEST_FAKE_BASE が設定されていても何もしない（前例: apps/agent の TEST_UPSTREAM）。
 *
 * - ai: AI バインディング（run / websearch / toMarkdown）を偽サーバーへの HTTP に置き換える
 * - fetch: 取得（robots.txt を含む）を偽サーバーへ向ける。URL ポリシーの検査は元の URL に対して先に済んでいる。
 *   元のホストは x-original-host、スキームは x-original-scheme で渡す。
 */

export type TestHooks = {
  ai: Ai;
  fetch: typeof fetch;
};

type HookEnv = { ENVIRONMENT?: string; TEST_FAKE_BASE?: string };

export function testHooks(
  env: HookEnv,
  baseFetch: typeof fetch = (i, init) => fetch(i, init),
): TestHooks | undefined {
  if (env.ENVIRONMENT !== "test" || !env.TEST_FAKE_BASE) return undefined;
  const base = env.TEST_FAKE_BASE.replace(/\/+$/, "");

  const postJson = (path: string, body: unknown) =>
    baseFetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const ai = {
    async run(model: string, input: unknown, options?: unknown) {
      const res = await postJson("/ai/run", { model, input, options });
      if (!res.ok) throw new Error(`fake AI.run failed: ${res.status}`);
      return res.json();
    },
    websearch(request: unknown) {
      return postJson("/ai/websearch", request);
    },
    async toMarkdown(file: { name: string; blob: Blob }) {
      const res = await postJson("/ai/tomarkdown", {
        name: file.name,
        text: await file.blob.text(),
      });
      if (!res.ok) throw new Error(`fake AI.toMarkdown failed: ${res.status}`);
      return res.json();
    },
  } as unknown as Ai;

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const original = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    headers.set("x-original-host", original.host);
    headers.set("x-original-scheme", original.protocol.replace(/:$/, ""));
    return baseFetch(`${base}${original.pathname}${original.search}`, {
      ...init,
      headers,
      redirect: "manual",
    });
  }) as typeof fetch;

  return { ai, fetch: fakeFetch };
}
