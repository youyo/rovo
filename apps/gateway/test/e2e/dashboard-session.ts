import { expect } from "vitest";
import { admin, baseUrl } from "./helpers";
import { approveAtGitHub, callCallback } from "./oauth-client";

// ブラウザの代わりに fetch でダッシュボードにログインし、セッション Cookie を返す（M5b の E2E 用）。
// 偽 GitHub の「現在のユーザー」でログインする。ブラウザが付ける Sec-Fetch-Site も手で付ける。

const SESSION_COOKIE = "__Host-rovo_dash";

function cookiePairs(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter((c) => c.includes("=") && !c.endsWith("="))
    .join("; ");
}

/** ダッシュボードにログインする。返すのは API 呼び出しに付ける Cookie ヘッダの値。 */
export async function dashboardLogin(user: { id: number; login: string }): Promise<string> {
  await admin.setCurrentUser(user.login);
  const start = await fetch(`${baseUrl}/dashboard/auth/login`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const callbackUrl = await approveAtGitHub(start.headers.get("location") ?? "");
  const res = await callCallback(callbackUrl, cookiePairs(start));
  expect(res.status).toBe(302);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error("セッション Cookie が発行されませんでした");
  return cookie;
}

export interface DashboardResponse {
  status: number;
  text: string;
  /** 状態・ヘッダの値・本文を 1 つにつないだ文字列（応答全体の検索用） */
  whole: string;
  json: () => unknown;
}

/** 読み取り API を呼ぶ（same-origin のブラウザの fetch と同じヘッダ）。 */
export async function dashboardGet(cookie: string, path: string): Promise<DashboardResponse> {
  const res = await fetch(`${baseUrl}/dashboard/api${path}`, {
    headers: { cookie, "sec-fetch-site": "same-origin" },
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    whole: `${res.status}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${text}`,
    json: () => JSON.parse(text) as unknown,
  };
}
