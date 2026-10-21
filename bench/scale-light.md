# scale-light 作業メモ

## ls（リポジトリ直下）

LICENSE, README.md, SECURITY.md, apps, biome.json, deploy.example, docs, infra, mise.toml, node_modules, package.json, packages, pnpm-lock.yaml, pnpm-workspace.yaml, rovo.config.example.json, scripts

## package.json の要約

- name: rovo（private, license: MIT）
- packageManager: pnpm@12.14.0
- engines.node: >=24
- scripts: 空
- devDependencies: @biomejs/biome ^2.5.15

## git log --oneline -5

- ae45b60 rovo: start task 01M5FZMQ353H9PKYXEGDXS1BHX
- 7e464c6 Merge branch 'worktree-agent-a40a116266e35724a'
- 32aa74c fix(agent): 聞き直しの帯の上端を排他にし、秘密の伏せと判断の大きさをテストで固定する
- ae2037a fix(agent): Clef の聞き直しの帯を 0.2〜0.7 にし、帯の中は flash と clef の大きいほうで上げるかを決める
- e6f7c3d docs: Sandbox の昇格の Clef への一本化を設計・デプロイ手順・受入に反映する
