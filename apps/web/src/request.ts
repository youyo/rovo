import { WebResearchError } from "./errors";
import type { CallContext } from "./types";

/** 呼び出し元の情報（caller は props 由来、userId / taskId は引数）を検査する。 */
export function readCallContext(req: unknown): CallContext {
  if (typeof req !== "object" || req === null) {
    throw new WebResearchError("invalid_request", "Request must be an object.");
  }
  const r = req as Record<string, unknown>;
  if (r.caller !== "parent" && r.caller !== "child") {
    throw new WebResearchError("invalid_request", 'caller must be "parent" or "child".');
  }
  if (typeof r.userId !== "string" || r.userId.trim() === "" || r.userId.length > 256) {
    throw new WebResearchError(
      "invalid_request",
      "userId must be a non-empty string (at most 256 characters).",
    );
  }
  if (r.taskId !== undefined && (typeof r.taskId !== "string" || r.taskId.length > 256)) {
    throw new WebResearchError(
      "invalid_request",
      "taskId must be a string (at most 256 characters) when given.",
    );
  }
  return {
    caller: r.caller,
    userId: r.userId,
    ...(typeof r.taskId === "string" && r.taskId !== "" ? { taskId: r.taskId } : {}),
  };
}
