// 契約テスト（型だけ。typecheck:web で検査される）。
// gateway（apps/gateway/src/web/contract.ts）と agent（apps/agent/src/tools/web.ts）は、web の実装を import せずに
// RPC の型を写して持っている（Env の型が混ざるため）。その写しが WebResearch の実際の型と食い違っていないことを確かめる。
//   - 戻り値: web が返す型が、呼び出し側の期待する型に代入できる
//   - 引数: 呼び出し側が渡す型が、web の引数に代入できる
import type { WebPort as AgentWebPort } from "../../../agent/src/tools/web";
import type { WebPort as GatewayWebPort } from "../../../gateway/src/web/contract";
import type { WebResearch } from "../../src/index";

type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;

type SearchOut = Awaited<ReturnType<WebResearch["search"]>>;
type FetchOut = Awaited<ReturnType<WebResearch["fetchUrl"]>>;
type SearchIn = Parameters<WebResearch["search"]>[0];
type FetchIn = Parameters<WebResearch["fetchUrl"]>[0];

export type Checks = [
  // gateway
  Assert<Extends<SearchOut, Awaited<ReturnType<GatewayWebPort["search"]>>>>,
  Assert<Extends<FetchOut, Awaited<ReturnType<GatewayWebPort["fetchUrl"]>>>>,
  Assert<Extends<Parameters<GatewayWebPort["search"]>[0], SearchIn>>,
  Assert<Extends<Parameters<GatewayWebPort["fetchUrl"]>[0], FetchIn>>,
  // agent
  Assert<Extends<SearchOut, Awaited<ReturnType<AgentWebPort["search"]>>>>,
  Assert<Extends<FetchOut, Awaited<ReturnType<AgentWebPort["fetchUrl"]>>>>,
  Assert<Extends<Parameters<AgentWebPort["search"]>[0], SearchIn>>,
  Assert<Extends<Parameters<AgentWebPort["fetchUrl"]>[0], FetchIn>>,
];
