import { DurableObject } from "cloudflare:workers";
import {
  DEPS_BUILD_TIMEOUT_MS,
  DEPS_FAILED_COOLDOWN_MS,
  DEPS_RESTORE_FAILED_COOLDOWN_MS,
  type DepsBuildRequest,
  type DepsBuildResult,
  type DepsEnsureRequest,
  type DepsEnsureResult,
  type DepsMissReason,
  parseDepsSpec,
} from "./deps-cache";

/**
 * 依存関係のキャッシュ（D14）の状態を、キャッシュの鍵ごとに 1 つ持つ Durable Object（名前 = 鍵）。
 *
 * 状態: building（作成中）/ ready（スナップショットがある）/ failed（失敗。クールダウン中は作り直さない）。
 * 同じ鍵の同時の ensure は、この DO の中で 1 つの作成を共有する（作るのは 1 回だけ）。
 *
 * コンテナは持たない。作成は SandboxDO の別インスタンス（deps-<鍵>）の buildDepsSnapshot に任せる。
 * スナップショットは作ったイメージに結び付くので、タスクのコンテナと同じクラス・同じイメージで作る必要がある
 * （別のクラスにコンテナを足すと、イメージが別の参照になり、復元できる保証がない）。
 */

type State =
  | { status: "building"; startedAt: number }
  | { status: "ready"; snapshotId: string; size: number; createdAt: number }
  | { status: "failed"; failedAt: number; cooldownMs: number };

const KEY = /^[0-9a-f]{64}$/;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DepsCacheDO extends DurableObject<Env> {
  /** 作成中の処理。同じ鍵の同時の ensure はこれを待つ（DO の再起動で消える。そのときの building は古い状態として作り直す） */
  private inflight?: Promise<DepsEnsureResult>;
  /** 作成を待つ上限（ms）と、作成側が自分で時間切れを返すのを待つ猶予（ms）。テストで短くする */
  buildTimeoutMs = DEPS_BUILD_TIMEOUT_MS;
  buildGraceMs = 30_000;
  /** 失敗した鍵を作り直さずに待つ時間（ms）。復元に失敗した鍵は、より長く待つ */
  cooldownMs = DEPS_FAILED_COOLDOWN_MS;
  restoreFailedCooldownMs = DEPS_RESTORE_FAILED_COOLDOWN_MS;

  private state(): State | undefined {
    return this.ctx.storage.kv.get<State>("state");
  }
  private setState(s: State): void {
    this.ctx.storage.kv.put("state", s);
  }

  /** 作成用のコンテナ（SandboxDO の別インスタンス）に作らせる。テストで差し替える。 */
  buildOn(name: string, req: DepsBuildRequest): Promise<DepsBuildResult> {
    const stub = this.env.SANDBOX_DO.getByName(name) as unknown as {
      buildDepsSnapshot(req: DepsBuildRequest): Promise<DepsBuildResult>;
    };
    return stub.buildDepsSnapshot(req);
  }

  /**
   * スナップショットを返す。ready ならすぐ返し、building なら同じ作成の完了を待ち、無ければ作る。
   * 失敗はクールダウンの間、作り直さずに cooldown を返す。例外は投げない（呼び出し元は fail-soft で続ける）。
   */
  async ensure(req: DepsEnsureRequest): Promise<DepsEnsureResult> {
    const deps = parseDepsSpec(req?.deps);
    if (
      !deps ||
      typeof req.key !== "string" ||
      !KEY.test(req.key) ||
      req.key !== this.ctx.id.name ||
      typeof req.repository !== "string" ||
      typeof req.baseSha !== "string" ||
      typeof req.branch !== "string" ||
      typeof req.taskId !== "string"
    ) {
      return { ok: false, reason: "invalid_deps" };
    }
    const state = this.state();
    if (state?.status === "ready") {
      return { ok: true, snapshotId: state.snapshotId, size: state.size, built: false, buildMs: 0 };
    }
    if (this.inflight) {
      // 待つだけの呼び出しは、作成の時間を負担しない（built: false）
      const r = await this.inflight;
      return r.ok ? { ...r, built: false, buildMs: 0 } : r;
    }
    if (state?.status === "failed" && Date.now() - state.failedAt < state.cooldownMs) {
      return { ok: false, reason: "cooldown" };
    }
    // ここまで await が無いので、同時の呼び出しは上の inflight に入る
    this.setState({ status: "building", startedAt: Date.now() });
    const p = this.build({ ...req, deps }).finally(() => {
      this.inflight = undefined;
    });
    this.inflight = p;
    return p;
  }

  private async build(req: DepsEnsureRequest): Promise<DepsEnsureResult> {
    let reason: DepsMissReason = "build_failed";
    try {
      const result = await Promise.race([
        this.buildOn(`deps-${req.key}`, { ...req, timeoutMs: this.buildTimeoutMs }),
        // 作成側が自分の期限で build_timeout を返すはず。それも返らなければここで諦める
        sleep(this.buildTimeoutMs + this.buildGraceMs).then((): "timeout" => "timeout"),
      ]);
      if (result === "timeout") {
        reason = "build_timeout";
      } else if (result.ok) {
        this.setState({
          status: "ready",
          snapshotId: result.snapshotId,
          size: result.size,
          createdAt: Date.now(),
        });
        return {
          ok: true,
          snapshotId: result.snapshotId,
          size: result.size,
          built: true,
          buildMs: Math.max(result.buildMs, 0),
        };
      } else {
        reason = result.reason;
      }
    } catch {
      // 例外の文面は外へ出さない（固定コードだけ）
      reason = "build_failed";
    }
    this.setState({ status: "failed", failedAt: Date.now(), cooldownMs: this.cooldownMs });
    return { ok: false, reason };
  }

  /**
   * 復元に失敗したスナップショット（期限切れ・イメージとの不整合など）を無効にする。
   * 別の id（既に作り直された後など）は無視する。次の ensure は、待ちの後に作り直す。
   */
  async invalidate(snapshotId: string): Promise<void> {
    const state = this.state();
    if (state?.status !== "ready" || state.snapshotId !== snapshotId) return;
    this.setState({
      status: "failed",
      failedAt: Date.now(),
      cooldownMs: this.restoreFailedCooldownMs,
    });
  }
}
