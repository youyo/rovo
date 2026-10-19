# セキュリティポリシー

## 脆弱性の報告

脆弱性を見つけたら、公開の Issue や Pull Request には書かず、GitHub の private vulnerability reporting で報告してほしい。

1. このリポジトリの **Security** タブを開く。
2. **Report a vulnerability** から報告する。

報告には、影響を受ける箇所（Worker、ツール、バージョンまたはコミット）、再現の手順、想定される影響を書いてほしい。実際の秘密やトークン、他人の情報は含めないでほしい。

個人のプロジェクトなので、返信や修正の時期は約束できない。報告を受けたら内容を確認し、できる範囲で対応する。

> 公開の直後は、まだ報告の窓口を有効にしていないことがある。Report a vulnerability が見当たらないときは、少し時間をおいてからもう一度試してほしい。

## 対象

- このリポジトリのコード（`apps/gateway`、`apps/agent`、`apps/web`、`packages/audit`）と、ドキュメントに書かれた設定。
- 対象外: 各利用者が自分の Cloudflare アカウントや GitHub App に行った設定。依存パッケージ、Cloudflare、GitHub そのものの脆弱性は、それぞれの窓口に報告してほしい。

## 前提としている設計

rovo の脅威モデルと防御は [docs/specs/design.md](docs/specs/design.md) にある。特に次の点は、設計上の前提として扱っている。

- Web から取得した内容、リポジトリの内容、子エージェントの出力は、非信頼データとして扱う。
- 子エージェントの Sandbox は、外向き通信を許可リストで制限する。禁止先への通信を完全に防げるとは保証しない（`web_browse` は実験的で、既定では無効）。
- 利用者の認可の防御線は、gateway の org / team の制限と、タスクごとの push 権限の検証。
