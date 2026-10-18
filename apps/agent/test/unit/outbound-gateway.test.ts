import { describe, expect, it } from "vitest";
import {
  buildTestUpstreamUrl,
  buildUpstreamHeaders,
  classifyDestination,
  limitBody,
} from "../../src/outbound-gateway";

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

describe("buildTestUpstreamUrl（テスト用転送先の組み立て）", () => {
  it("通常のパスは転送先の origin に付く", () => {
    expect(
      buildTestUpstreamUrl("http://127.0.0.1:9000", new URL("https://github.com/a/b?x=1")).href,
    ).toBe("http://127.0.0.1:9000/a/b?x=1");
  });
  it("//host で始まる pathname でも転送先の origin を置き換えられない", () => {
    const u = buildTestUpstreamUrl(
      "http://127.0.0.1:9000",
      new URL("https://registry.npmjs.org//example.com/x"),
    );
    expect(u.origin).toBe("http://127.0.0.1:9000");
    expect(u.pathname).toBe("//example.com/x");
  });
});

describe("classifyDestination", () => {
  it("github / registry / other に分類し、ホスト名そのものは返さない", () => {
    expect(classifyDestination("github.com")).toBe("github");
    expect(classifyDestination("registry.npmjs.org")).toBe("registry");
    expect(classifyDestination("pypi.org")).toBe("registry");
    expect(classifyDestination("evil.example")).toBe("other");
    expect(classifyDestination("169.254.169.254")).toBe("other");
  });
});

describe("limitBody", () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    });
  it("上限以内ならそのまま通す", async () => {
    const out = await new Response(limitBody(stream(["abc", "def"]), 10)).text();
    expect(out).toBe("abcdef");
  });
  it("上限を超えたら読み取りがエラーになる", async () => {
    await expect(new Response(limitBody(stream(["abcdef", "ghijkl"]), 8)).text()).rejects.toThrow(
      /too large/,
    );
  });
});
