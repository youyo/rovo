/**
 * レビューのモデルに渡す読み取りの道具の口（docs/specs/worker-review.md「レビューのモデルへの入力」）。
 * 道具そのものはワーカーの read_file / list_files / search（tools/sandbox-tools.ts）をそのまま使い、ここでは
 *   - 登録を 3 つだけに絞る（write_file / edit_file / bash / git_commit は、渡されても定義にも実行にも出さない）
 *   - 引数を定義（JSON Schema）に照らして確かめる
 *   - 結果を、モデルに渡す前に毎回、秘密のスキャン（maskSecrets）で伏せ字にし、非信頼データの囲みに入れる
 * だけを行う。道具で読んだ内容（ファイル・検索結果・一覧）は、リポジトリを書いた人が決める非信頼データ。
 */
import { maskSecrets } from "../redact";
import { stripUntrustedMarkers, wrapUntrusted } from "../tools/untrusted";

/** レビューのモデルに渡す道具の名前（これだけ） */
export const REVIEW_TOOL_NAMES = ["read_file", "list_files", "search"] as const;

/** 伏せ字の印（@rovo/audit の maskSecrets が置く文字列）。道具が自分で伏せたものを数えるために見る */
const REDACTED_MARK = "[REDACTED]";

export interface ReviewToolDef {
  name: string;
  description: string;
  /** JSON Schema（pi-ai の Tool.parameters と同じもの） */
  parameters: unknown;
}

export interface ReviewToolResult {
  /** モデルに渡す文字列（伏せ字にして、非信頼データの囲みに入れてある） */
  text: string;
  isError: boolean;
}

export interface ReviewToolRunner {
  definitions: ReviewToolDef[];
  run(call: { name: string; arguments: unknown }): Promise<ReviewToolResult>;
  /** 道具の結果に、秘密らしい文字列があって伏せ字にしたものがあったか（warnings の review_redacted） */
  redacted(): boolean;
}

/** 道具の定義（pi-durable の ToolRegistration のうち、ここで使う部分） */
interface ToolLike {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    args: never,
    api: never,
    context: never,
  ): Promise<{ output?: readonly { type: string; text?: string }[]; isError?: boolean }>;
}

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
};

/** 引数を、道具の JSON Schema（object / string / integer / number / boolean だけ）に照らして確かめる。問題の説明か undefined */
function checkArguments(schema: unknown, args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "arguments must be a JSON object";
  }
  const s = (schema ?? {}) as Schema;
  const record = args as Record<string, unknown>;
  for (const key of s.required ?? []) {
    if (record[key] === undefined) return `missing required argument: ${key}`;
  }
  for (const [key, def] of Object.entries(s.properties ?? {})) {
    const v = record[key];
    if (v === undefined) continue;
    switch (def.type) {
      case "string":
        if (typeof v !== "string") return `${key} must be a string`;
        if (def.minLength !== undefined && v.length < def.minLength) return `${key} is too short`;
        break;
      case "integer":
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) return `${key} must be a number`;
        if (def.type === "integer" && !Number.isInteger(v)) return `${key} must be an integer`;
        if (def.minimum !== undefined && v < def.minimum) return `${key} must be >= ${def.minimum}`;
        if (def.maximum !== undefined && v > def.maximum) return `${key} must be <= ${def.maximum}`;
        break;
      case "boolean":
        if (typeof v !== "boolean") return `${key} must be a boolean`;
        break;
    }
  }
  return undefined;
}

export function createReviewToolRunner(tools: readonly ToolLike[]): ReviewToolRunner {
  // 名前で絞る。渡された道具に書き込み・実行のものがあっても、ここで落とす
  const allowed = new Map<string, ToolLike>();
  for (const name of REVIEW_TOOL_NAMES) {
    const t = tools.find((x) => x.name === name);
    if (t) allowed.set(name, t);
  }
  let redacted = false;

  /** 伏せ字にして囲む。道具が先に囲んでいても、囲みを剥がして 1 つに付け直す（二重に囲まない・本文の終端で閉じさせない） */
  const shield = (name: string, raw: string): string => {
    const plain = stripUntrustedMarkers(raw);
    const masked = maskSecrets(plain);
    if (masked !== plain || masked.includes(REDACTED_MARK)) redacted = true;
    return wrapUntrusted(name, masked);
  };
  const fail = (name: string, message: string): ReviewToolResult => ({
    text: shield(name, message),
    isError: true,
  });

  return {
    definitions: [...allowed.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    redacted: () => redacted,
    run: async (call) => {
      const tool = allowed.get(call.name);
      if (!tool) {
        return fail(
          "tool",
          `unknown tool: ${call.name.slice(0, 64)}. Available tools: ${REVIEW_TOOL_NAMES.join(", ")}.`,
        );
      }
      const problem = checkArguments(tool.parameters, call.arguments);
      if (problem) return fail(tool.name, `invalid arguments: ${problem}`);
      try {
        const res = await tool.execute(call.arguments as never, {} as never, {} as never);
        const text = (res.output ?? [])
          .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("");
        return { text: shield(tool.name, text), isError: res.isError === true };
      } catch (e) {
        return fail(tool.name, e instanceof Error ? e.message : String(e));
      }
    },
  };
}
