import type { GitCredential, SandboxMetrics } from "./agent/types";
import type { DepsSpec } from "./deps-cache";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 既定 10 分。超えたらプロセスグループごと kill して timedOut を立てる。 */
  timeoutMs?: number;
  /** 既定 64KiB。超えた分は捨て、末尾を残す。 */
  maxOutputBytes?: number;
  /**
   * このコマンドの出自。あれば、実行の前に Clef が「今の Sandbox の大きさで足りるか」を判断し、足りなければ大きい Sandbox へ昇格する
   * （sandbox-scale-decision.ts。fail-soft）。ワーカーが実行するコマンド（bash ツール）は agent_command、検証コマンドは verification。
   * 無ければ Sandbox 自身の内部の exec（git・ファイルの確認など）として、判断しない。コマンドの重さの規則ではなく、誰のコマンドかの区別。
   */
  origin?: "agent_command" | "verification";
  /**
   * 自動の push（git_commit・WIP・完了時の同期）の exec にだけ付ける許可証。SandboxDO は exec の間だけ（終わったら必ず）これを
   * 預かり、OutboundGateway は receive-pack の ref と newSha がこれと一致するときだけ認証を付けて転送する。
   * ワーカーの bash（agent_command）と検証コマンド（verification）には渡さない（渡せる経路を作らない）。
   */
  pushPermit?: PushPermit;
}

/** push を許す更新 1 件。ref は `refs/heads/<branch>`、newSha は送る commit の SHA（40 桁の 16 進）。 */
export interface PushPermit {
  ref: string;
  newSha: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 出力が上限を超えて切り詰められたか */
  truncated: boolean;
  /** 終端（terminate 済み）のため実行しなかった。exitCode は -1。 */
  terminated?: boolean;
}

/** Sandbox の作業環境を用意するための指定。認証済みの taskSpec から作る。 */
export interface WorkspaceSpec {
  /** owner/name */
  repository: string;
  baseSha: string;
  /** 作業ブランチ名（例: agent/task-<id>）。リモートに既にある（TaskDO が作成済み）ことが前提。 */
  branch: string;
  /** 作業ブランチの初期コミット（base_sha の上の空コミット）。 */
  initialSha: string;
  /** epoch ms。超えたら SandboxDO は自分でコンテナを止める。 */
  deadlineAt: number;
  /**
   * 依存関係のキャッシュ（D14）の指定。gateway が base_sha 時点のルート直下の lockfile から作る。
   * 無い・null ならキャッシュを使わない。ensureReady の同一性（conflict）の判定には含めない。
   */
  deps?: DepsSpec | null;
  /**
   * コンテナの大きさ（task_start の sandbox_instance。standard-1〜4）。**あれば利用者が明示した**ので、このタスクの間はずっとこの大きさで
   * 起動する（env の SANDBOX_INSTANCE より優先。Clef による昇格もしない）。無ければ env の既定から始めて、コマンドの前に Clef が
   * 上げると判断したら上限（env の SANDBOX_MAX_INSTANCE）までの大きさへ昇格する。ensureReady の同一性（conflict）の判定には含めない。
   * 依存関係のキャッシュを作るコンテナ（deps-<key>）には使わない（常に既定のまま）。
   */
  instance?: string;
}

/** peekOutput の結果。stdout / stderr はそれぞれ末尾 64KiB までの途中の出力（未マスク）。 */
export interface PeekedOutput {
  running: boolean;
  /** 実行を始めた時刻（ms）。running のときだけ */
  startedAt?: number;
  stdout: string;
  stderr: string;
}

/** AgentDO から見た Sandbox。Unit では fake に差し替え、E2E では SandboxDO（実コンテナ）を使う。 */
export interface SandboxPort {
  /**
   * コンテナを起動し、/workspace に作業ツリーを用意する（冪等）。
   * 傍受の登録と CA 設定が終わるまで clone / exec はしない。
   */
  ensureReady(spec: WorkspaceSpec): Promise<void>;
  /**
   * GitHub の Installation Token を預ける（暗号化して SandboxDO の storage に保存。コンテナには入れない）。
   * ensureReady より前に呼ぶ（clone にも使うため）。冪等で、保存済みより新しい expiresAt のものだけ採用する。
   * 終端後は例外。terminate で削除される。
   */
  setGitCredential(credential: GitCredential): Promise<void>;
  /** terminate 後は例外ではなく `terminated: true` の結果を返す。 */
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * 実行中のワーカーのコマンド（origin 付きの exec）の途中の出力。exec の完了を待たずに返る（exec の鎖の外）。
   * 実行中でなければ running: false。マスクはしない（呼び出し側が窓全体にかけてから切る）。無い実装では進捗を流さない。
   */
  peekOutput?(): Promise<PeekedOutput>;
  /**
   * 期限を延ばす（回答待ちの間に止めていた分を戻す）。単調増加だけ受け付け（小さい値は無視）、
   * 上限は作成時刻 + 2 時間 + 24 時間。超える値・準備前・終端後は例外。alarm も張り直す。
   */
  extendDeadline(deadlineAt: number): Promise<void>;
  /**
   * 期限を正確な値に設定する（短くもできる。回答のときに、質問で延ばした上限から戻す）。
   * 上限は作成時刻 + 2 時間 + 24 時間で、超える値・準備前・終端後は例外。現在時刻より前の値は即座に期限切れとして扱う。
   */
  setDeadline(deadlineAt: number): Promise<void>;
  /** 実行中のプロセスグループを止め、止まらなければコンテナを止める。停止を確かめてから戻る。 */
  stop(): Promise<{ stopped: boolean }>;
  /**
   * 永続的な終端停止。コンテナを止め、以後の ensureReady / exec / ファイル操作を拒否する（再開させない）。
   * cancel と、タスクの終端（期限・予算・失敗・完了）の片付けで使う。無い実装には stop で代用する。
   */
  terminate?(): Promise<{ stopped: boolean }>;
  /**
   * 回答待ちの間、費用を止めるためにコンテナを止める（予算の延長の承認待ちなど）。作業ツリーのスナップショットを取ってから止め、
   * 次の操作（exec など）で同じスナップショットから起動し直して作業ツリーを戻す。
   * mode: snapshot = 取って止めた / destroyed = 取れなかったが allowReclone なので止めた（戻すときは再 clone） /
   * running = 取れず、止めなかった（fail-soft。作業ツリーを失わないため）。allowReclone は、呼び出し側が
   * 「作業ツリーが clean で HEAD が push 済み」を確かめたときだけ true にする。無い実装では中断せずコンテナを動かし続ける。
   */
  suspend?(options: {
    allowReclone: boolean;
  }): Promise<{ mode: "snapshot" | "destroyed" | "running" }>;
  /**
   * 実行時間・作り直し・起動のやり直しのカウンタ（永続。定義は sandbox-do.ts）。AgentDO が usage イベントに載せる。
   * 無い実装、または読めない（undefined / 例外）ときは、usage に sandbox を載せない。
   */
  metrics?(): Promise<SandboxMetrics | undefined>;
}
