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
  // task_review（kind: "review"）の指定と結果
  Assert<Equal<Gateway.ReviewSpec, Agent.ReviewSpec>>,
  Assert<Equal<Gateway.ReviewResultDto, Agent.ReviewResultDto>>,
  // worker_review（task_start の review_policy: "worker_review"）の指定
  Assert<Equal<Gateway.WorkerReviewSpec, Agent.WorkerReviewSpec>>,
  // Phase 4: 回答と steer の RPC。AgentDO 本体は import しない（apps/agent の Env 型が gateway の型検査に混ざるため）。
  // 戻り値は apps/agent の DeliveryResult と一致し、引数は (id: string, text: string) であること。
  Assert<Equal<Awaited<ReturnType<Gateway.AgentRpc["answer"]>>, Agent.DeliveryResult>>,
  Assert<Equal<Awaited<ReturnType<Gateway.AgentRpc["steer"]>>, Agent.DeliveryResult>>,
  Assert<Equal<Parameters<Gateway.AgentRpc["answer"]>, [questionId: string, answer: string]>>,
  Assert<Equal<Parameters<Gateway.AgentRpc["steer"]>, [steerId: string, message: string]>>,
  // D10: consult の依頼と結果
  Assert<Equal<Gateway.ConsultRequest, Agent.ConsultRequest>>,
  Assert<Equal<Gateway.ConsultResult, Agent.ConsultResult>>,
  // 同一の関数型として扱える（Gateway のスタブに apps/agent の型で書いた実装を代入できる）
  Assert<
    Equal<
      Gateway.AgentRpc["answer"],
      (questionId: string, answer: string) => Promise<Agent.DeliveryResult>
    >
  >,
  Assert<
    Equal<
      Gateway.AgentRpc["steer"],
      (steerId: string, message: string) => Promise<Agent.DeliveryResult>
    >
  >,
];
