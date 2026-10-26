import type { Api, Model } from "@earendil-works/pi-ai";

const EPHEMERAL = { type: "ephemeral" } as const;

type Block = Record<string, unknown>;
type Message = { role?: unknown; content?: unknown } & Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** content を、cache_control を外したブロックの配列にする（文字列は text ブロックにする）。 */
function stripped(content: unknown): Block[] | undefined {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return undefined;
  return content.map((b) => {
    if (!isObject(b)) return b as Block;
    const { cache_control: _drop, ...rest } = b;
    return rest;
  });
}

/**
 * consult の prompt caching（Anthropic の Messages API の payload に cache_control を付ける）。
 *
 * pi-ai は既定で system と「最後のメッセージ」にブレークポイントを付けるが、consult では最後の user メッセージ
 * （質問）が毎回変わる。呼び出し元が同じ前置きを送ったときに 2 回目以降が読まれるよう、
 * - system の末尾のブロック
 * - 最後の user メッセージより前の部分（その直前のメッセージの末尾のブロック）
 * に付け、messages の他の cache_control（pi が付けた最後のメッセージのもの）は外す。
 * Anthropic 以外のモデル（OpenAI は自動キャッシュ）と、形の合わない payload は何もしない。元の payload は書き換えない。
 *
 * 道具の往復の歩（opts.lastMessage。#135）では、最後のメッセージ（道具の結果）の末尾にも付ける。次の歩は同じ前置きに
 * 1 往復を足しただけなので、そこまでがキャッシュから読まれる。Anthropic のブレークポイントは 4 個までなので、system は
 * 末尾のブロックだけに残す（system 1・道具の定義 1（pi が付ける）・最後の user の前 1・最後 1 の合計 4 個）。
 */
export function applyConsultCacheControl(
  model: Model<Api>,
  payload: unknown,
  opts: { lastMessage?: boolean } = {},
): unknown {
  if (model.api !== "anthropic-messages" && !/claude/i.test(model.id)) return payload;
  if (!isObject(payload) || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages as Message[];

  // 最後の user メッセージの位置
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isObject(messages[i]) && messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }

  const lastIndex = messages.length - 1;
  const next = messages.map((m, i) => {
    if (!isObject(m)) return m;
    const blocks = stripped(m.content);
    if (blocks === undefined) return m;
    if (opts.lastMessage === true && i === lastIndex && blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (isObject(last)) {
        return { ...m, content: [...blocks.slice(0, -1), { ...last, cache_control: EPHEMERAL }] };
      }
    }
    // 最後の user の直前のメッセージの、末尾のブロックに付ける
    if (lastUser > 0 && i === lastUser - 1 && blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (isObject(last)) {
        return { ...m, content: [...blocks.slice(0, -1), { ...last, cache_control: EPHEMERAL }] };
      }
    }
    // 文字列のままだった content は、ブロックに直さず元のまま返す（付ける対象でなければ変えない）
    return typeof m.content === "string" ? m : { ...m, content: blocks };
  });

  let system = payload.system;
  if (Array.isArray(system) && system.length > 0) {
    const last = system[system.length - 1];
    if (isObject(last)) {
      const head = system.slice(0, -1);
      system = [
        ...(opts.lastMessage === true ? (stripped(head) ?? head) : head),
        { ...last, cache_control: EPHEMERAL },
      ];
    }
  }
  return { ...payload, ...(system !== undefined ? { system } : {}), messages: next };
}
