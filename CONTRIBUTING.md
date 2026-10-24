# Contributing to Rovo

Thanks for your interest. Rovo is a personal project, so replies and merges may be slow, but issues and pull requests are welcome.

Not affiliated with Atlassian Rovo.

## Set up

Tools are managed by [mise](https://mise.jdx.dev/). Docker must be running for the agent's E2E tests.

```bash
mise install            # node / pnpm / terraform
mise run install        # dependencies
```

Run development commands through `mise run <task>` (see `mise tasks`), not by calling `npm`, `pnpm` or `vitest` directly.

## Develop with TDD

Write a failing test first, see it fail for the expected reason, then write the smallest change that makes it pass, then refactor.

- Add a **unit test** for the logic and an **E2E test** for the behavior a user can see. For a bug fix, write a test that reproduces the bug first.
- Do not weaken, skip or delete a test to make it pass.
- Do not put real account IDs, domains, tokens or private repository names in code, tests or docs. Use placeholders such as `<YOUR_ACCOUNT_ID>`.

## Check before you open a pull request

```bash
mise run lint           # biome, type checks, docs check, terraform fmt
mise run test           # unit + infra + E2E (Docker required)
mise run scan:secrets   # secrets and personal values in HEAD and the whole history
```

All three must exit with 0. If you only touched one area, running the related `test:unit:*` task while you work is fine, but the full `mise run test` and `mise run lint` are what a pull request is checked against.

## Pull requests

1. Fork, then create a branch from `main`.
2. Keep one change per pull request, and explain why in the description.
3. Docs: `README.md` is the English main document and `README.ja.md` is its Japanese counterpart. Keep them in sync.
4. Open the pull request. A maintainer reviews it; please be patient.

## Security

Do not report vulnerabilities in a public issue or pull request. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
