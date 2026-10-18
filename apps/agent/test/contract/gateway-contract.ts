// 契約テスト（型だけ。typecheck:agent で検査される）。
// Gateway が持つ AgentDO の RPC 型（apps/gateway/src/agent/contract.ts の AgentRpc）が、AgentDO の実際のメソッドの型と
// 食い違っていないことを確かめる。AgentDO は apps/agent の Env 型に依存するので、型を比べるのは agent 側の型検査で行う
// （gateway 側から AgentDO を import すると、Env の食い違いが gateway の型検査に混ざる）。
// gateway の contract.ts は型だけで Env に依存しないので、ここから import できる。実行時の依存は作らない。
import type { AgentRpc } from "../../../gateway/src/agent/contract";
import type { AgentDO } from "../../src/agent-do";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type Params<M extends keyof AgentRpc> = Equal<Parameters<AgentDO[M]>, Parameters<AgentRpc[M]>>;
type Returns<M extends keyof AgentRpc> = Equal<
  Awaited<ReturnType<AgentDO[M]>>,
  Awaited<ReturnType<AgentRpc[M]>>
>;

export type Checks = [
  Assert<Params<"start">>,
  Assert<Returns<"start">>,
  Assert<Params<"cancel">>,
  Assert<Returns<"cancel">>,
  Assert<Params<"getEvents">>,
  Assert<Returns<"getEvents">>,
  Assert<Params<"getResult">>,
  Assert<Returns<"getResult">>,
  Assert<Params<"setGitCredential">>,
  Assert<Returns<"setGitCredential">>,
  Assert<Params<"answer">>,
  Assert<Returns<"answer">>,
  Assert<Params<"steer">>,
  Assert<Returns<"steer">>,
];
