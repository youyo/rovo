/** 追跡している rovo のタスク 1 件（$.store にも保存する）。 */
export type RovoTask = {
  taskId: string;
  title: string;
  /** task_start を呼んだ MCP サーバー名（ツール名の `mcp__<server>__` の部分）。 */
  server: string;
  /** ツール名の接頭辞。空か `my-rovo_` のようなもの。 */
  prefix: string;
  /** `https://` で始まるものだけ入れる。 */
  dashboardUrl?: string;
  /** 追跡を始めた時刻（ms）。 */
  startedAt: number;
  /** RUNNING / INPUT_REQUIRED / COMPLETED / FAILED / BUDGET_EXCEEDED / CANCELLED など。 */
  status: string;
  /** 終端になったと気づいた時刻（ms）。1 時間たつと消す。 */
  terminalAt?: number;
  /** 終端のトーストを出し済み。 */
  notified?: boolean;
  /** 予算の延長の承認待ち（INPUT_REQUIRED のとき）。トーストを繰り返さない印も兼ねる。 */
  awaiting?: "budget_extension";
  /** task_console が使えなかったので task_status に切り替えた。 */
  noConsole?: boolean;
  /** noConsole の間、task_console を次に試し直す時刻（ms）。60 秒に 1 回。 */
  consoleRetryAt?: number;
  /** ここから下は task_list（呼んだ人の全タスク）から来る。task_list が無いサーバーでは入らない。 */
  kind?: "task" | "review";
  repository?: string;
  model?: string;
  /** task: setup|work|verify|pr|done、review: fetch|investigate|post|done。 */
  stage?: string;
  verifyAttempt?: number;
  verifyMax?: number;
  /** 質問への答え待ち（waiting_for_answer）。 */
  waiting?: boolean;
  /** task_list から入ったタスク。一覧の上限が task_start で拾ったものと別（50 件）。 */
  listed?: boolean;
  /** task_list の pr（https のみ）。task_console の pr があればそちらを優先する。 */
  pr?: { number: number | null; url: string };
};

/** task_console（か task_status）の最後の取得結果。囲みは外し、制御文字は落としてある。 */
export type RovoConsole = {
  phase: string | null;
  stoppedPhase: string | null;
  nowText: string | null;
  /** nowText のコマンドの場所（/workspace からの相対）。 */
  nowWhere?: string;
  command: string | null;
  /** command の場所（/workspace からの相対）。 */
  commandWhere?: string;
  tail: string | null;
  isRunning: boolean;
  /** 出力に対応していないサーバー（task_status だけ）。 */
  hasOutput: boolean;
  /** 取得した時刻（ms）。 */
  fetchedAt: number;
  dashboardUrl?: string;
  /** PR へのリンク（https のみ）。number が null なら「PR」とだけ出す。 */
  pr?: { number: number | null; url: string };
};

declare module "claude-code" {
  interface PluginState {
    rovo: {
      tasks: RovoTask[];
      /** キーは taskKey(task) = `${server}/${taskId}`。 */
      consoles: Record<string, RovoConsole>;
      /** 選択中のタスクの taskKey。null は既定（最新の実行中、無ければ最新）。 */
      selected: string | null;
      /** 出力の窓。follow は末尾に追従中。offset は追従を止めたときの先頭行（出力の中の行番号）。 */
      scroll: { follow: boolean; offset: number };
      /** 直近にペインへ出していたタスクの taskKey。自動の切り替えを見つけて追従に戻すために持つ。 */
      shown: string | null;
      /** /rovo-create-task が実行された時刻（ms）。タスクを拾うと null に戻る。10 分たつと表示しない。 */
      creating: number | null;
      /** 描き直しの番号。0.7 秒ごとに 1 つ進み、スピナー・▶・点滅の位置を決める。 */
      frame: number;
      /** 各ワーカーが今いる駅と、その駅に着いたフレーム（着いた直後の ◉ のため）。キーは taskKey。 */
      arrivals: Record<string, { at: number; since: number }>;
      /** rovo のツールを呼んだ接続先（server と prefix）。task_list を呼ぶ先。$.store にも残す。 */
      endpoints: { server: string; prefix: string }[];
      /** task_list の接続先（server と prefix の組）ごとの状態。キーは `${server}/${prefix}`。 */
      lists: Record<string, { supported: boolean; retryAt: number; lastAt: number }>;
    };
  }
}
