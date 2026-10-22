import type { TestProject } from "vitest/node";
import { type SetupOptions, startGatewayServer } from "../support/gateway-server";

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
    githubUrl: string;
  }
}

export type { SetupOptions };

export default function setup(project: TestProject) {
  return startGateway(project, { logs: true });
}

/** gateway（と偽 GitHub・偽 agent Worker）を起動して baseUrl / githubUrl を提供する。戻り値は後始末。 */
export async function startGateway(project: TestProject, options: SetupOptions = {}) {
  const { baseUrl, githubUrl, cleanup } = await startGatewayServer(options);
  project.provide("baseUrl", baseUrl);
  project.provide("githubUrl", githubUrl);
  return cleanup;
}
