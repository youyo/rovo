// モデルの自動選択（apps/gateway/src/model-selection.ts）の閾値を決める実験。実際の Clef に、指示の見本を投げて確率を記録する。
// 使い方: node scripts/clef-model-experiment.mjs <出力する JSON のパス> [反復回数 既定 2] [候補 既定 haiku,sonnet,opus]
//   見本: apps/gateway/test/fixtures/model-selection-samples.json（本物に近い指示 + 期待する等級）
//   接続（どちらか）:
//     CLEF_PROXY_URL=http://localhost:8799   AI バインディングを持つ Worker（wrangler dev --remote。ボディ {model,input} を AI.run に渡して
//                                            {ok,ms,out} を返すだけのもの）。wrangler のログイン済みの認証を使うので、トークンを環境変数に置かなくてよい
//     CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID   Workers AI の REST（/accounts/{id}/ai/run/<model>）を直接呼ぶ
// トークン・アカウント ID は出力・ログ・ファイルに書かない。出力には確率・入力 tokens・往復時間だけが入る。
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// packages/audit は拡張子なしの相対 import を使う（バンドラ前提）。Node で直接読むため、見つからなければ .ts を補う
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw e;
    }
  },
});
const { buildSelectionQuestions, buildSelectionState, CLEF_FLASH, CLEF_FULL, eligibleCandidates } =
  await import("../apps/gateway/src/model-selection.ts");

const here = dirname(fileURLToPath(import.meta.url));
const [outPath, repeatArg, candArg] = process.argv.slice(2);
if (!outPath) {
  console.error("使い方: node scripts/clef-model-experiment.mjs <出力パス> [反復回数] [候補]");
  process.exit(2);
}
const repeat = Number(repeatArg ?? 2);
const ids = (candArg ?? "haiku,sonnet,opus")
  .split(",")
  .map((n) => (n === "fable" ? "anthropic/claude-fable-5-1" : `anthropic/claude-${n}-5-5`));
const candidates = eligibleCandidates(ids, ids, () => true);

const samples = JSON.parse(
  readFileSync(join(here, "../apps/gateway/test/fixtures/model-selection-samples.json"), "utf8"),
);

async function callClef(model, body) {
  const t = Date.now();
  const proxy = process.env.CLEF_PROXY_URL;
  if (proxy) {
    const res = await fetch(proxy, {
      method: "POST",
      body: JSON.stringify({ model: model.id, input: body }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error("clef call failed");
    return { out: j.out, ms: Date.now() - t };
  }
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
  if (!token || !account) {
    throw new Error("CLEF_PROXY_URL か、CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る");
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model.id}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`clef call failed (${res.status})`);
  const j = await res.json();
  return { out: j.result ?? j, ms: Date.now() - t };
}

const questions = buildSelectionQuestions(candidates);
const results = [];
for (const s of samples) {
  const state = buildSelectionState(s.task);
  const row = { id: s.id, expect: s.expect, flash: [], clef: [] };
  for (let i = 0; i < repeat; i++) {
    for (const [key, model] of [
      ["flash", CLEF_FLASH],
      ["clef", CLEF_FULL],
    ]) {
      const { out, ms } = await callClef(model, { model: model.name, state, questions });
      const p = out.answers?.tier?.probabilities ?? {};
      row[key].push({
        probabilities: p,
        input_tokens: out.usage?.input_tokens ?? null,
        ms,
      });
    }
  }
  results.push(row);
  console.log(s.id, "done");
}
writeFileSync(
  outPath,
  `${JSON.stringify({ candidates: candidates.map((c) => c.id), questions, results }, null, 2)}\n`,
);
console.log("wrote", outPath);
