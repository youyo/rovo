// 契約テスト（型だけ。typecheck:gateway で検査される）。
// Gateway が持つ AgentDO の RPC 型（src/agent/contract.ts）が、apps/agent の型と食い違っていないことを確かめる。
// apps/agent の型を import するのはこのファイル（ビルドに含まれない）だけで、実行時の依存は作らない。
import type * as Agent from "../../../agent/src/agent/types";
import type * as Gateway from "../../src/agent/contract";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type Checks = [
  Assert<Equal<Gateway.TaskSpec, Agent.TaskSpec>>,
  Assert<Equal<Gateway.VerificationCommand, Agent.VerificationCommand>>,
  Assert<Equal<Gateway.StartResult, Agent.StartResult>>,
  Assert<Equal<Gateway.CancelResult, Agent.CancelResult>>,
  Assert<Equal<Gateway.UsageDto, Agent.UsageDto>>,
  Assert<Equal<Gateway.AgentEventDto, Agent.AgentEventDto>>,
  Assert<Equal<Gateway.EventsPage, Agent.EventsPage>>,
  Assert<Equal<Gateway.VerificationSummary, Agent.VerificationSummary>>,
  Assert<Equal<Gateway.VerificationCommandResult, Agent.VerificationCommandResult>>,
  Assert<Equal<Gateway.AgentPhase, Agent.Phase>>,
  Assert<Equal<Gateway.ResultDto, Agent.ResultDto>>,
];
