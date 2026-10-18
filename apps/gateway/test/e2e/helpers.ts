import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { inject } from "vitest";
import { type FakeAdmin, fakeGitHubAdmin } from "./fake-admin";
import { connectAuthenticated } from "./oauth-client";

export const baseUrl = inject("baseUrl");
export const githubUrl = inject("githubUrl");
export const admin: FakeAdmin = fakeGitHubAdmin(githubUrl);

export const ORG = "acme";
export const TEAM = "core";
export const REPO = { id: 4242, fullName: "acme/widgets", push: true };
export const INSTALLATION_ID = 77;

// DO の状態は wrangler dev の間ずっと残るので、テストごとに別のユーザーを使う
let seq = (Date.now() % 1_000_000) * 100;
export function newUser(prefix = "user") {
  const id = ++seq;
  return { id, login: `${prefix}-${id}` };
}

/** ユーザーを偽 GitHub に作り、team の active メンバーにして、現在のユーザーにする。 */
export async function addMember(user: { id: number; login: string }) {
  await admin.addUser(user);
  await admin.setTeam(ORG, TEAM, user.login, "active");
}

/** 偽 GitHub に Installation（acme/widgets に push 可）を用意する。 */
export async function installApp() {
  await admin.setInstallation(INSTALLATION_ID, [REPO]);
}

export async function login(user: { id: number; login: string }): Promise<Client> {
  await admin.setCurrentUser(user.login);
  return connectAuthenticated(baseUrl);
}

export type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
export function bodyOf(r: ToolResult): Record<string, unknown> {
  return JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}");
}

export const startArgs = (title: string, extra: Record<string, unknown> = {}) => ({
  repository: "acme/widgets",
  base_ref: "main",
  base_sha: "0123456789abcdef",
  title,
  instructions: "do it",
  ...extra,
});
