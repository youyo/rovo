/** 追跡している rovo のタスク 1 件（$.store にも保存する）。 */
export type RovoTask = {
  taskId: string;
  title: string;
  /** タスクを拾った接続先の MCP サーバー名（ツール名の `mcp__<server>__` の部分）。 */
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
  /** task_list から入ったタスク。一覧の上限が、それ以外（前の版で保存したもの）と別（50 件）。 */
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

/** ログ（task_console の log）の 1 行。kind で色が決まる。where は cmd の場所（/workspace からの相対）。 */
export type RovoLogLine = {
  kind: "cmd" | "out" | "edit" | "commit" | "web" | "tool" | "status" | "pr" | "error";
  text: string;
  where?: string;
};

declare module "claude-code" {
  interface PluginState {
    "rovo-console": {
      tasks: RovoTask[];
      /** キーは taskKey(task) = `${server}/${taskId}`。 */
      consoles: Record<string, RovoConsole>;
      /** 出力の窓。follow は末尾に追従中。offset は追従を止めたときの先頭行（出力の中の行番号）。 */
      scroll: { follow: boolean; offset: number };
      /** いまペインに出しているワーカーの taskKey。描くたびには選び直さず、クリックとイベント（新しい作業中のタスク・質問待ち）のときだけ替わる。替わったら窓を追従に戻す。 */
      shown: string | null;
      /** /rovo:create-task が実行された時刻（ms）。task_list で新しいタスクを拾うと null に戻る。10 分たつと表示しない。 */
      creating: number | null;
      /** 描き直しの番号。0.7 秒ごとに 1 つ進み、スピナー・▶・点滅の位置を決める。 */
      frame: number;
      /** 各ワーカーが今いる駅と、その駅に着いたフレーム（着いた直後の ◉ のため）。キーは taskKey。 */
      arrivals: Record<string, { at: number; since: number }>;
      /**
       * $.tool.list() の名前から見つけた接続先（server と prefix。task_start・task_list・task_console が揃うもの）。
       * task_list を呼ぶ先。$.store にも残す。
       */
      endpoints: { server: string; prefix: string }[];
      /** task_start と task_console はあるが task_list が無い接続先（$.tool.list() で見たもの）。追跡できないと知らせる。 */
      noList: { server: string; prefix: string }[];
      /** このセッションで task_list の同期が 1 回済んだ接続先（キーは `${server}/${prefix}`）。開始のトーストの基準。 */
      synced: Record<string, true>;
      /**
       * task_list の接続先（server と prefix の組）ごとの状態。キーは `${server}/${prefix}`。
       * missing は、呼んで unknown tool か形の違う答えが返った（task_list が無い）印。
       */
      lists: Record<
        string,
        { supported: boolean; retryAt: number; lastAt: number; missing?: boolean }
      >;
      /**
       * 積み上がるログ。キーは taskKey。supported は task_console が log を返したワーカー
       * （false なら最新のコマンドだけの表示）。cursor は次に渡す log_after、lines は最大 500 行。
       */
      logs: Record<string, { supported: boolean; cursor: string; lines: RovoLogLine[] }>;
      /** log_after を受け付けなかった接続先（`${server}/${prefix}`）を、この時刻（ms）まで使わない。 */
      logOff: Record<string, number>;
    };
  }
}
