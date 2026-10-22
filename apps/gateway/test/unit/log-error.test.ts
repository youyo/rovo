import { describe, expect, it } from "vitest";
import { errorMessageForLog, LOG_ERROR_MESSAGE_MAX } from "../../src/log-error";

// ソースに実在の形のトークンを書かない（scan:secrets に一致させない）。実行時に組み立てる
const token = ["gh", "u", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("");

describe("errorMessageForLog（例外のメッセージをログに出せる形にする）", () => {
  it("メッセージを返す", () => {
    expect(errorMessageForLog(new TypeError("Illegal invocation"))).toBe("Illegal invocation");
  });

  it("資格情報らしき文字列はマスクする", () => {
    const out = errorMessageForLog(new TypeError(`bad token ${token} in header`));
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });

  it("200 文字で切る", () => {
    const out = errorMessageForLog(new Error("x".repeat(1000)));
    expect(out.length).toBe(LOG_ERROR_MESSAGE_MAX);
    expect(LOG_ERROR_MESSAGE_MAX).toBe(200);
  });

  it("Error 以外は中身を出さず型名だけ。message が読めない例外でも落ちない", () => {
    expect(errorMessageForLog(`secret ${token}`)).toBe("string");
    expect(errorMessageForLog(null)).toBe("object");
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new TypeError("nope");
      },
    });
    expect(errorMessageForLog(hostile)).toBe("");
  });
});
