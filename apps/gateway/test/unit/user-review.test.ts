import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getFakeApp, UNIT_REPO, type UnitGitHubEnv } from "../support/unit-github";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";

// UserDO.authorizeReview（task_review の権限）: team の再検証・App の Installation と push 権限（task_start と同じ）に加え、
// 利用者本人のトークンでその PR が見えること。fork・閉じた・マージ済みの PR は断る。

const app = () => getFakeApp(env as unknown as UnitGitHubEnv);
const REPO = UNIT_REPO.fullName;
const BASE = "0123456789abcdef0123456789abcdef01234567";

let seq = 0;
async function setup(opts: { fork?: boolean } = {}) {
  const id = newUserId();
  const gh = new FakeGitHubFetch();
  gh.user = { id, login: "alice" };
  gh.app = app();
  const stub = await installFakeGitHub(id, gh);
  const branch = `feature/review-${++seq}-${id}`;
  const head = await app().addCommit(REPO, BASE, `client work ${branch}`);
  app().setBranch(REPO, "main", BASE);
  if (!opts.fork) app().setBranch(REPO, branch, head);
  const number = app().seedPull(REPO, {
    head: branch,
    base: "main",
    title: "Fix sum",
    body: "please review",
    draft: false,
    ...(opts.fork ? { headRepo: "mallory/widgets", headSha: head } : {}),
  });
  return { id, gh, stub, head, number };
}

describe("UserDO.authorizeReview", () => {
  it("見える PR なら、repository / installation の ID と PR の情報（固定する head・base・タイトル・本文）を返す", async () => {
    const { id, stub, head, number } = await setup();
    const r = await stub.authorizeReview(id, REPO, number);
    expect(r).toEqual({
      ok: true,
      repositoryId: UNIT_REPO.id,
      installationId: 77,
      pull: {
        number,
        url: `https://github.test/${REPO}/pull/${number}`,
        headSha: head,
        headRef: expect.stringMatching(/^feature\/review-/),
        baseSha: BASE,
        baseRef: "main",
        title: "Fix sum",
        body: "please review",
        draft: false,
      },
    });
    // PR は利用者本人のトークンで読む（App の権限だけで許さない）
    expect(
      app()
        .requests()
        .filter((x) => x.path === `/repos/${REPO}/pulls/${number}`)
        .every((x) => x.auth === "user"),
    ).toBe(true);
  });

  it("fork の PR は invalid_input（fork_not_supported）", async () => {
    const { id, stub, number } = await setup({ fork: true });
    const r = await stub.authorizeReview(id, REPO, number);
    expect(r).toMatchObject({ ok: false, code: "invalid_input" });
    if (r.ok) return;
    expect(r.message).toMatch(/^fork_not_supported: /);
  });

  it("閉じた PR・マージ済みの PR は invalid_input（理由のコード付き）", async () => {
    const a = await setup();
    app().closePull(REPO, a.number);
    const closed = await a.stub.authorizeReview(a.id, REPO, a.number);
    expect(closed).toMatchObject({ ok: false, code: "invalid_input" });
    if (!closed.ok) expect(closed.message).toMatch(/^pull_request_closed: /);

    const b = await setup();
    app().markMerged(REPO, b.number);
    const merged = await b.stub.authorizeReview(b.id, REPO, b.number);
    expect(merged).toMatchObject({ ok: false, code: "invalid_input" });
    if (!merged.ok) expect(merged.message).toMatch(/^pull_request_merged: /);
  });

  it("見えない・無い PR は not_found（存在を教えない）", async () => {
    const { id, stub } = await setup();
    const r = await stub.authorizeReview(id, REPO, 999_999);
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });

  it("App の Installation に無いリポジトリは forbidden（task_start と同じ）", async () => {
    const { id, stub, number } = await setup();
    const r = await stub.authorizeReview(id, "acme/elsewhere", number);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("team に属していなければ forbidden", async () => {
    const { id, gh, stub, number } = await setup();
    gh.team = "none";
    const r = await stub.authorizeReview(id, REPO, number);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
  });
});
