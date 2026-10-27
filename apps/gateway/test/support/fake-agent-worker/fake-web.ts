// E2E 用の偽の Web Research Service（apps/web の WebResearch の代わり）。gateway の WEB バインディングを、この
// WorkerEntrypoint への service binding に差し替えて使う（test/support/gateway-server.ts の writeE2eConfig）。
// 外部のネットワークには出ない。道具つきの consult（#135）の E2E が、検索語と URL が届いたことを本文で確かめる。
import { WorkerEntrypoint } from "cloudflare:workers";

const SAFETY = {
  evaluator: "fake",
  model_version: "fake",
  verdict: "allow",
  categories: [],
  reason: "no issues detected",
  evaluated: true,
  model: { verdict: "allow", scores: null },
  policy: { verdict: "allow", rules: [] },
};

export class FakeWebResearch extends WorkerEntrypoint {
  async search(req: { query: string }): Promise<unknown> {
    return {
      results: [
        {
          source: {
            url: "https://docs.example.com/release",
            retrieved_at: new Date(0).toISOString(),
            via: "search",
          },
          title: "Release notes",
          content: `fake search result for: ${req.query}`,
          safety: SAFETY,
        },
      ],
      metadata: { requestId: "fake", latencyMs: 1, provider: "fake", dropped_urls: 0 },
    };
  }

  async fetchUrl(req: { url: string }): Promise<unknown> {
    return {
      source: {
        url: req.url,
        final_url: req.url,
        retrieved_at: new Date(0).toISOString(),
        via: "direct",
      },
      content: `fake page body of ${req.url}`,
      safety: SAFETY,
      status: "ok",
    };
  }

  async browse(): Promise<unknown> {
    throw new Error("disabled: web_browse is not available in the fake");
  }
}
