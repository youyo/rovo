export const DEFAULT_GITHUB_OAUTH_BASE = "https://github.com";
export const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

export interface GitHubBaseEnv {
  ENVIRONMENT?: string;
  GITHUB_OAUTH_BASE?: string;
  GITHUB_API_BASE?: string;
}

export interface GitHubBaseUrls {
  oauthBase: string;
  apiBase: string;
}

function normalize(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return value.replace(/\/+$/, "");
}

function pick(
  name: string,
  value: string | undefined,
  fallback: string,
  allowOverride: boolean,
): string {
  if (value === undefined || value === "") return fallback;
  const normalized = normalize(name, value);
  if (normalized === fallback) return fallback;
  // fail closed: ENVIRONMENT が "test" 以外で既定値以外が指定されたら起動を止める
  if (!allowOverride) {
    throw new Error(`${name} override is only allowed when ENVIRONMENT is "test"`);
  }
  return normalized;
}

/** GitHub の接続先 URL を決める。上書きは ENVIRONMENT === "test" のときだけ許可する。 */
export function resolveGitHubBaseUrls(env: GitHubBaseEnv): GitHubBaseUrls {
  const allow = env.ENVIRONMENT === "test";
  return {
    oauthBase: pick("GITHUB_OAUTH_BASE", env.GITHUB_OAUTH_BASE, DEFAULT_GITHUB_OAUTH_BASE, allow),
    apiBase: pick("GITHUB_API_BASE", env.GITHUB_API_BASE, DEFAULT_GITHUB_API_BASE, allow),
  };
}
