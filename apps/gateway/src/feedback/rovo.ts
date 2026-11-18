/**
 * rovo_feedback の匿名化ルールのうち、rovo 固有の部分（共通仕様 §7.2）。
 * 共通の部分は guide.ts。env・サービス・DO を import しない。
 */

/** rovo 固有のプレースホルダ。共通の `<USER>` `<EMAIL>` `<ORG>` `<HOST>` `<URL>` `<ID>` に続けて返す。 */
export const ROVO_PLACEHOLDERS = ["<REPO>"] as const;

/** rovo 固有の匿名化ルール。共通のルールに続けて返す。プレースホルダはバッククォートで囲む。 */
export const ROVO_ANONYMIZATION_RULES: readonly string[] = [
  "GitHub のリポジトリ名（owner/repo。公開のものも含む）は `<REPO>` にする。ブランチ名・commit SHA・PR 番号・タスク ID・consult の ID は `<ID>` にする",
  "タスクの instructions・acceptance_criteria・verification_commands の中身、ワーカーの出力（summary・質問・コンソールのログ）、差分とコード、PR の本文とレビューのコメント、consult の質問と回答、web_search・web_fetch・web_browse の結果は貼らない。抜き出し・言い換え・翻訳したものも同じ扱いにする。現象の説明に必要なら、構造だけを残した架空の例に置き換える",
  "費用・予算の額、usage と実行統計の実測値（トークン数・実行時間・試行回数など）、デプロイの設定値（モデルの許可リスト・同時実行数・Sandbox の設定と実行環境の識別情報）、使ったモデルの id、dashboard_url は書かない。説明に必要なら架空の値にする",
  "残してよい rovo の公開固定値は、rovo の公開ツール名、エラーの code（`{code, message}` の code だけ。例 invalid_input・not_ready）、タスクの status（COMPLETED など）、task_result の reason と warnings の固定コード（コードの部分だけ。後ろに付くホスト名・ツール名・件数・コマンドなどの値は書かない）。どれも rovo の README とソースに列挙された値と完全に一致するものだけで、一致しない値は消す",
];
