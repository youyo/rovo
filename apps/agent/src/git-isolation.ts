import { repositoryCloneUrl } from "./secret-scan";

/**
 * 自動の git（push と、その前後の ls-remote / rev-parse）を、ワーカーの gitconfig から切り離すための env。
 * ワーカーは root で、/root/.gitconfig・/etc/gitconfig・/workspace/.git/config を書き換えられる。
 * GIT_CONFIG_GLOBAL=/dev/null で global（~/.gitconfig と XDG）を、GIT_CONFIG_NOSYSTEM=1 で system を読まない。
 * safe.directory は BASE_ENV の GIT_CONFIG_COUNT 側（env）なので、これらとは独立に効く。
 */
export const GIT_ISOLATION_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/**
 * `git` の直後に置く上書き（-c は .git/config より優先する）。
 * - core.hooksPath=/dev/null: ワーカーが .git/hooks や core.hooksPath に置いた pre-push フックを実行しない。
 * - credential.helper=（空）: ワーカーが設定した credential helper を呼ばない（トークンはコンテナに無く、gateway が付ける）。
 * remote.origin.pushurl / url.<base>.insteadOf は、打ち消せない（insteadOf は同じ長さなら先に書いた設定が勝つ）ので上書きしない。
 * 代わりに push・ls-remote は origin ではなくリポジトリの URL を直接渡す（pushTarget）。それでも insteadOf で URL を書き換えられた場合、
 * 行き先は gateway（外向きの判定と push の許可証）が止めるので、push が失敗するだけで、秘密の検査を通らない push にはならない。
 */
export const GIT_ISOLATION_ARGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
];

/** ワーカーの gitconfig から切り離した git の argv（先頭の `git` から）を作る。 */
export function isolatedGit(argv: readonly string[]): string[] {
  return ["git", ...GIT_ISOLATION_ARGS, ...argv];
}

/**
 * push・ls-remote の宛先。spec の repository（owner/name）から作る URL（clone と同じ）を使い、設定の origin は使わない。
 * repository が分からない・形が不正なときだけ origin に戻る（本番では spec の検証で必ず分かる）。
 */
export function pushTarget(repository: string | undefined): string {
  return repositoryCloneUrl(repository) ?? "origin";
}
