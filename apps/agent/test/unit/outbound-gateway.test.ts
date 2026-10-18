import { describe, expect, it } from "vitest";
import { buildUpstreamHeaders } from "../../src/outbound-gateway";

describe("buildUpstreamHeaders", () => {
  it("許可リストのヘッダだけを渡し、Authorization / Cookie / Host などは落とす", () => {
    const out = buildUpstreamHeaders(
      new Headers({
        authorization: "Bearer secret",
        cookie: "sid=1",
        host: "evil.example",
        "x-forwarded-for": "1.2.3.4",
        "x-custom": "leak",
        accept: "application/json",
        "user-agent": "git/2.x",
        "git-protocol": "version=2",
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
      }),
    );
    expect(Object.fromEntries(out.entries())).toEqual({
      accept: "application/json",
      "user-agent": "git/2.x",
      "git-protocol": "version=2",
      "content-type": "application/x-git-upload-pack-request",
      "content-encoding": "gzip",
    });
  });
});
