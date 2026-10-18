import { env } from "cloudflare:workers";
import { ulid } from "../../src/tasks/ulid";

export function newTaskId(): string {
  return ulid();
}

export function taskStub(taskId: string) {
  return env.TASK_DO.getByName(taskId);
}

let userSeq = 1_000_000 + Math.floor(Math.random() * 1_000_000);
export function newUserId(): number {
  return userSeq++;
}

export function userStub(userId: number) {
  return env.USER_DO.getByName(String(userId));
}

export function sampleInput(
  taskId: string,
  ownerId: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    task_id: taskId,
    owner_id: ownerId,
    owner_login: "alice",
    repository_id: 4242,
    installation_id: 77,
    repository: "acme/widgets",
    base_ref: "main",
    base_sha: "0123456789abcdef",
    title: "Implement authentication",
    instructions: "Implement OAuth authentication.",
    acceptance_criteria: ["tests pass"],
    constraints: ["do not merge"],
    ...overrides,
  };
}
