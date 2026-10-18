import { describe, expect, it } from "vitest";
import {
  DEFAULT_GITHUB_API_BASE,
  DEFAULT_GITHUB_OAUTH_BASE,
  resolveGitHubBaseUrls,
} from "../../../src/github/config";

describe("resolveGitHubBaseUrls", () => {
  it("未指定なら既定値を返す", () => {
    expect(resolveGitHubBaseUrls({})).toEqual({
      oauthBase: DEFAULT_GITHUB_OAUTH_BASE,
      apiBase: DEFAULT_GITHUB_API_BASE,
    });
    expect(DEFAULT_GITHUB_OAUTH_BASE).toBe("https://github.com");
    expect(DEFAULT_GITHUB_API_BASE).toBe("https://api.github.com");
  });

  it("空文字は未指定として扱う", () => {
    expect(
      resolveGitHubBaseUrls({
        ENVIRONMENT: "production",
        GITHUB_OAUTH_BASE: "",
        GITHUB_API_BASE: "",
      }),
    ).toEqual({ oauthBase: DEFAULT_GITHUB_OAUTH_BASE, apiBase: DEFAULT_GITHUB_API_BASE });
  });

  it("本番で既定値と同じ値を明示しても通る（末尾スラッシュ違いも同じ扱い）", () => {
    expect(
      resolveGitHubBaseUrls({
        ENVIRONMENT: "production",
        GITHUB_OAUTH_BASE: "https://github.com/",
        GITHUB_API_BASE: "https://api.github.com",
      }),
    ).toEqual({ oauthBase: "https://github.com", apiBase: "https://api.github.com" });
  });

  it.each([undefined, "production", "staging", "TEST", ""])(
    "ENVIRONMENT=%s で既定値以外を指定すると fail closed でエラー",
    (environment) => {
      expect(() =>
        resolveGitHubBaseUrls({
          ENVIRONMENT: environment,
          GITHUB_API_BASE: "http://127.0.0.1:9999",
        }),
      ).toThrow(/GITHUB_API_BASE/);
      expect(() =>
        resolveGitHubBaseUrls({
          ENVIRONMENT: environment,
          GITHUB_OAUTH_BASE: "http://127.0.0.1:9999",
        }),
      ).toThrow(/GITHUB_OAUTH_BASE/);
    },
  );

  it("ENVIRONMENT=test のときだけ上書きできる（末尾スラッシュは除く）", () => {
    expect(
      resolveGitHubBaseUrls({
        ENVIRONMENT: "test",
        GITHUB_OAUTH_BASE: "http://127.0.0.1:9999/",
        GITHUB_API_BASE: "http://127.0.0.1:9999",
      }),
    ).toEqual({ oauthBase: "http://127.0.0.1:9999", apiBase: "http://127.0.0.1:9999" });
  });

  it("ENVIRONMENT=test でも URL として不正な値はエラー", () => {
    expect(() =>
      resolveGitHubBaseUrls({ ENVIRONMENT: "test", GITHUB_API_BASE: "not a url" }),
    ).toThrow();
    expect(() =>
      resolveGitHubBaseUrls({ ENVIRONMENT: "test", GITHUB_API_BASE: "ftp://example.com" }),
    ).toThrow();
  });
});
