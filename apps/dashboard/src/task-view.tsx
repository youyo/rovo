import type {
  TaskDetailDto,
  TaskEventDto,
  TaskStatusDto,
  VisibleTaskDto,
} from "@rovo/dashboard-contract";
import type { ReactNode } from "react";
import {
  formatClock,
  formatClockSeconds,
  formatCount,
  formatDuration,
  formatUsd,
  isAllowedPrUrl,
  sanitizeText,
  shortModel,
  singleLine,
} from "./format";
import {
  completedKind,
  isTerminal,
  MARKS,
  type MarkKind,
  markDescription,
  markKindOf,
} from "./status";
import { MarkSymbol, ShapeSymbol } from "./status-mark";
import {
  type BandStep,
  buildSteps,
  nowSentence,
  type PhaseTiming,
  phaseBand,
  phaseTimings,
  type Step,
  type StepTiming,
  stepTimings,
} from "./steps";
import { useStickToBottom } from "./use-stick-to-bottom";

/**
 * コンソール（詳細の本体。純粋な表示。データ取得は use-task-detail）。GitHub Actions の run の形:
 * 要約のカード（印付きの題名・状態・モデル・所要・費用・リポジトリ・依頼者・PR・「いま」）→ 段階（job の箱を線でつないだ図）
 * → ログの箱（ステップの行と、いま実行中のコマンドの出力の末尾）。
 * 表示する文字列はすべて format / steps の関数を通す（D14）。
 */

const MERGE_POLICY: Record<TaskDetailDto["settings"]["merge_policy"], string> = {
  human_review: "人のレビューを待つ",
  agent_merge: "依頼した AI がマージしてよい",
};

/** モデルの選び方の理由のコード（gateway の model-selection.ts の reason）の日本語。知らないコードはそのまま出す */
const MODEL_SELECTION_REASON: Record<string, string> = {
  clef_flash: "Clef が内容から選んだ",
  clef_cascade: "Clef が聞き直して選んだ",
  single_candidate: "選べるモデルが 1 つだった",
  no_candidates: "選べるモデルが無く既定のモデル",
  fallback_unconfigured: "Clef を使えず既定のモデル",
  fallback_timeout: "時間切れで既定のモデル",
  fallback_error: "Clef の失敗で既定のモデル",
  fallback_invalid: "Clef の答えが想定外で既定のモデル",
};

function modelSelectionText(
  sel: NonNullable<TaskDetailDto["settings"]["model_selection"]>,
): string {
  if (sel.mode === "explicit") return "指定（依頼した側が選んだ）";
  return `自動（${MODEL_SELECTION_REASON[sel.reason] ?? sel.reason}）`;
}

const DEPS_CACHE: Record<NonNullable<TaskDetailDto["settings"]["deps_cache"]>, string> = {
  hit: "再利用した",
  miss: "見つからなかった",
  built: "新しく作った",
  disabled: "使わない",
};

/** 見出しの状態。印はレール・凡例と同じ記号。名前は短い label のまま、title で長い説明（無ければ label）を出す */
function StatusLine(props: { task: VisibleTaskDto }) {
  const kind = markKindOf(props.task);
  return (
    <span className="state-name" title={markDescription(kind)}>
      <MarkSymbol kind={kind} decorative />
      {MARKS[kind].label}
    </span>
  );
}

/** 経過時間のラベルと値。終わったタスクは「所要」、続いているタスクは「開始から」 */
function elapsedFact(task: VisibleTaskDto, generatedAt: number): { label: string; value: string } {
  const start = Date.parse(task.started_at ?? task.created_at);
  if (isTerminal(task.status)) {
    const end = task.ended_at === null ? generatedAt : Date.parse(task.ended_at);
    return { label: "所要", value: formatDuration(end - start) };
  }
  return { label: "開始から", value: formatDuration(generatedAt - start) };
}

/** 所要の文字。終わっていない（今までの経過）なら末尾に … */
const timingText = (t: StepTiming | PhaseTiming): string =>
  `${formatDuration(t.ms)}${t.open ? "…" : ""}`;

/** 段階の箱の印。済み=✓、いま=回る輪、入力待ち=！、復旧中=灰の回る輪、止まった=✕、これから=点線の輪 */
function JobIcon(props: { state: BandStep["state"] }) {
  switch (props.state) {
    case "done":
      return <ShapeSymbol shape="check" tone="ok" />;
    case "now":
      return <ShapeSymbol shape="spinner" tone="run" live />;
    case "waiting":
      return <ShapeSymbol shape="bang" tone="run" />;
    case "recovering":
      return <ShapeSymbol shape="spinner" tone="skip" live />;
    case "stopped":
      return <ShapeSymbol shape="cross" tone="bad" />;
    case "todo":
      return <ShapeSymbol shape="queued" tone="skip" />;
  }
}

/** 段階の帯: job の箱を線でつないだ図。済んだ区間の線は緑。箱の文字は所要（無ければ状態の文字） */
function Band(props: { band: BandStep[]; timings: Partial<Record<BandStep["key"], PhaseTiming>> }) {
  const label = `段階: ${props.band.map((b) => `${b.name}は${b.label}`).join("、")}`;
  return (
    <ol className="band" data-band="" aria-label={label}>
      {props.band.map((b, i) => {
        const timing = props.timings[b.key];
        // 所要があればそれ。止まった・入力待ち・復旧中は、所要の前に状態の文字も添える。所要が無ければ状態の文字
        const small =
          timing === undefined
            ? b.label
            : b.state === "stopped" || b.state === "waiting" || b.state === "recovering"
              ? `${b.label} ${timingText(timing)}`
              : timingText(timing);
        return (
          <li key={b.key} className={`band-item band-item--${b.state}`} data-state={b.state}>
            {i > 0 ? (
              <span
                className={`band-edge${props.band[i - 1]?.state === "done" ? " done" : ""}`}
                aria-hidden="true"
              />
            ) : null}
            <span className="job" title={`${b.name}: ${b.label}`}>
              <JobIcon state={b.state} />
              <span className="band-name">{b.name}</span>
              <small>{small}</small>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** ステップの行の印。失敗=✕、いま=回る輪（入力待ちのタスクでは ！）、そのほか=✓ */
function StepIcon(props: { step: Step; waiting: boolean }) {
  const { step } = props;
  if (step.tone === "fail") return <ShapeSymbol shape="cross" tone="bad" />;
  if (step.current) {
    return props.waiting ? (
      <ShapeSymbol shape="bang" tone="run" />
    ) : (
      <ShapeSymbol shape="spinner" tone="run" live />
    );
  }
  return <ShapeSymbol shape="check" tone="ok" />;
}

/**
 * ステップ 1 行（▸・印・内容・時刻・所要）。中身（note、実行中のコマンドの出力の末尾）があるときだけ開ける（details）。
 * 無ければ ▸ も出さない。失敗した行と、出力を載せる行は最初から開く。
 */
function StepItem(props: {
  step: Step;
  timing: StepTiming | undefined;
  waiting: boolean;
  /** この行の下に開いて見せるもの（実行中のコマンドの出力の末尾） */
  below?: ReactNode;
}) {
  const { step } = props;
  const cls = `step${step.current ? " step--now" : ""}${step.tone === "fail" ? " step--fail" : ""}${
    step.command ? " step--cmd" : ""
  }`;
  const expandable = step.note !== "" || props.below !== undefined;
  const cells = (
    <>
      {expandable ? (
        <span className="step-car" aria-hidden="true">
          ▸
        </span>
      ) : (
        <span className="step-gap" aria-hidden="true" />
      )}
      <StepIcon step={step} waiting={props.waiting} />
      <span className="step-body">
        {step.command ? (
          <>
            <span className="sr-only">{step.what} </span>
            {step.where === undefined ? null : <span className="step-where">{step.where} で </span>}
            <span className="prompt">$ </span>
            <span className="step-target">{step.target}</span>
          </>
        ) : (
          <>
            <span className="step-what">{step.what}</span>
            {step.target === "" ? null : <span className="step-target"> {step.target}</span>}
          </>
        )}
        {step.current ? <span className="step-tag">いま</span> : null}
      </span>
      <span className="step-time">{formatClockSeconds(step.at)}</span>
      {props.timing === undefined ? (
        <span className="step-dur step-dur--none" />
      ) : (
        <span className={`step-dur${props.timing.open ? " step-dur--open" : ""}`}>
          {timingText(props.timing)}
        </span>
      )}
    </>
  );
  return (
    <li className={cls} data-seq={step.seq} data-current={String(step.current)}>
      {expandable ? (
        <details className="step-details" open={props.below !== undefined || step.tone === "fail"}>
          <summary className="step-row">{cells}</summary>
          <div className="step-more">
            {step.note === "" ? null : <p className="step-detail">{step.note}</p>}
            {props.below}
          </div>
        </details>
      ) : (
        <div className="step-row">{cells}</div>
      )}
    </li>
  );
}

/** 出力の末尾（1 行 1 要素。行番号は CSS の counter で付ける）。改行は各行の末尾に残し、元の文字列と同じにする */
function OutputLines(props: { tail: string }) {
  const lines = sanitizeText(props.tail).split(/(?<=\n)/);
  return (
    <pre className="output">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 行は並びが全てで、並べ替えない
        <span className="out-line" key={i}>
          {line}
        </span>
      ))}
    </pre>
  );
}

function prMark(task: VisibleTaskDto): MarkKind | null {
  const pr = task.pr;
  if (!pr) return null;
  if (task.status === "COMPLETED") return completedKind(pr);
  if (pr.merged || pr.state === "merged") return "merged";
  return pr.state === "closed" ? "closed" : null;
}

/** 見出しの Draft PR（リンクと状態）。外部リンクは GitHub の PR の URL に厳密に一致するものだけ（D14）。 */
function PrInline(props: { task: VisibleTaskDto }) {
  const { task } = props;
  const pr = task.pr;
  if (pr === null) {
    return (
      <span className="con-pr" data-pr="">
        <span className="soft">Draft PR はまだありません。</span>
      </span>
    );
  }
  const kind = prMark(task);
  const label = `${pr.draft === false ? "PR" : "Draft PR"} #${pr.number}`;
  return (
    <span className="con-pr" data-pr="">
      {isAllowedPrUrl(pr.url) ? (
        <a href={pr.url} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
      {kind === null ? null : (
        <span className="status" title={markDescription(kind)}>
          <MarkSymbol kind={kind} decorative />
          {MARKS[kind].label}
        </span>
      )}
      {pr.draft === true ? <span className="soft">Draft</span> : null}
      {pr.draft === false ? <span className="soft">Ready for review</span> : null}
    </span>
  );
}

function Fact(props: { k: string; v: string; title?: string }) {
  return (
    <div className="fact">
      <dt>{props.k}</dt>
      <dd title={props.title}>{props.v}</dd>
    </div>
  );
}

/** 要約のカードの「小さなラベルと値」の 1 組 */
function MetaItem(props: { k: string; children: ReactNode }) {
  return (
    <div className="meta-item">
      <dt>{props.k}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/** 要約のカードの属性（状態・モデル・経過・費用・リポジトリ・依頼者・PR）。一覧の行（VisibleTaskDto）だけで描ける */
function ConMeta(props: {
  task: VisibleTaskDto;
  /** 経過時間の基準（詳細の generated_at。一覧の行だけのときは一覧の generated_at） */
  generatedAt: number;
  /** 詳細の設定にだけある（一覧の行には無い） */
  modelSelection?: NonNullable<TaskDetailDto["settings"]["model_selection"]>;
}) {
  const { task } = props;
  const model = shortModel(task.model);
  const elapsed = elapsedFact(task, props.generatedAt);
  return (
    <dl className="con-meta">
      <MetaItem k="状態">
        <StatusLine task={task} />
      </MetaItem>
      <MetaItem k="モデル">
        <span data-model="" title={model.full}>
          {model.name}
        </span>
        {props.modelSelection === undefined ? null : (
          <span className="soft"> {modelSelectionText(props.modelSelection)}</span>
        )}
      </MetaItem>
      <MetaItem k={elapsed.label}>{elapsed.value}</MetaItem>
      <MetaItem k="費用">{formatUsd(task.cost.cost_usd)}</MetaItem>
      <MetaItem k="リポジトリ">{singleLine(task.repository)}</MetaItem>
      <MetaItem k="依頼者">{singleLine(task.owner_login)}</MetaItem>
      {task.reason === undefined ? null : <MetaItem k="理由">{singleLine(task.reason)}</MetaItem>}
      <MetaItem k="PR">
        <PrInline task={task} />
      </MetaItem>
    </dl>
  );
}

/** 要約のカードの題名。印は状態の印（装飾。隣に題名と、状態の文字がある） */
function ConTitle(props: { task: VisibleTaskDto }) {
  return (
    <h1 id="task-h">
      <MarkSymbol kind={markKindOf(props.task)} decorative />
      <span className="con-title">{singleLine(props.task.title)}</span>
    </h1>
  );
}

/**
 * 切り替えた瞬間のコンソール。詳細（と events）が届くまで、一覧の行にある情報（題名・状態・モデル・費用・PR など）だけで要約のカードを描く。
 * 一覧の行は一覧の取得で権限を確かめ済みのもの。表示する文字列は詳細と同じ関数を通す。
 */
export function TaskPreview(props: { task: VisibleTaskDto; at: number }) {
  return (
    <section className="console" aria-labelledby="task-h" aria-busy="true" data-preview="">
      <div className="con-head">
        <ConTitle task={props.task} />
        <ConMeta task={props.task} generatedAt={props.at} />
      </div>
      <p className="soft con-loading" role="status">
        読み込み中…
      </p>
    </section>
  );
}

export function TaskView(props: {
  detail: TaskDetailDto;
  events: TaskEventDto[];
  hasOlder: boolean;
  stale: boolean;
  loadingOlder: boolean;
  olderError: boolean;
  autoRefresh: boolean;
  onAutoRefreshChange: (on: boolean) => void;
  onRefresh: () => void;
  onLoadOlder: () => void;
}) {
  const { detail, events } = props;
  const { task, settings, output } = detail;
  const generatedAt = Date.parse(detail.generated_at);
  const active = !isTerminal(task.status);
  const reached = new Set(
    events.flatMap((e) => (e.type === "status_changed" ? [e.to] : [])),
  ) as ReadonlySet<TaskStatusDto>;
  const band = phaseBand(task, detail.phase, reached, detail.stopped_phase);
  const steps = buildSteps(events, active);
  const timings = stepTimings(steps, generatedAt);
  const phases = phaseTimings(events, band, generatedAt);
  const now = nowSentence(detail.now, task.status);
  const model = shortModel(task.model);
  const running = output.running === true;
  const waiting = task.status === "INPUT_REQUIRED";
  // 実行中のコマンドの出力の末尾は、そのコマンドの行（いまの行）の下に開いて見せる。
  // 実行中でない（終わったコマンドの末尾）、またはいまの行がコマンドでないときは、手順の外の出力の枠に出す
  // （終わったコマンドの出力がどの行のものかは、決めつけない）
  const lastStep = steps.at(-1);
  const attachSeq = running && lastStep?.current && lastStep.command ? lastStep.seq : null;

  const scroll = useStickToBottom(
    `${events.at(-1)?.seq ?? 0}:${steps.length}:${output.tail?.length ?? -1}:${running}:${props.hasOlder}`,
  );

  const outputBox = (
    <div className="output-box">
      <h3>
        {output.command === undefined
          ? "出力の末尾"
          : `${singleLine(output.command)} の出力（${running ? "途中" : "末尾"}）`}
      </h3>
      {output.tail === null ? null : <OutputLines tail={output.tail} />}
      {running && (
        <p className="output-running">
          実行中
          {output.started_at !== undefined && !Number.isNaN(generatedAt)
            ? `（経過 ${formatDuration(generatedAt - Date.parse(output.started_at))}）`
            : ""}
          <span className="cursor" aria-hidden="true" />
        </p>
      )}
      <p className="output-note">
        子エージェントが実行したコマンドの出力の一部です。トークンなどの秘密は伏せて表示しています。
        {output.tail === null ? "いまは表示できる出力がありません。" : ""}
      </p>
    </div>
  );

  return (
    <section className="console" aria-labelledby="task-h">
      {props.stale ? (
        <p className="notice" role="status">
          更新できませんでした。前の内容を表示しています（自動で再試行します）。
        </p>
      ) : null}

      <div className="con-head">
        <ConTitle task={task} />
        <ConMeta task={task} generatedAt={generatedAt} modelSelection={settings.model_selection} />
        <p className="now-line" data-active={String(active)}>
          {now.before}
          {now.prompt === undefined ? null : (
            <span className="prompt now-prompt">{now.prompt}</span>
          )}
          {now.target === "" ? null : <strong>{now.target}</strong>}
          {now.after}
        </p>
      </div>

      <Band band={band} timings={phases} />

      <div className="logbox">
        <div className="loghd">
          <span className="loghd-title">
            進み具合{" "}
            <span className="loghd-count">
              {steps.length}
              {props.hasOlder ? "+" : ""} ステップ
            </span>
          </span>
          <details className="con-more">
            <summary>設定と費用の内訳</summary>
            <p>
              入力 {formatCount(task.cost.input_tokens)} トークン、出力{" "}
              {formatCount(task.cost.output_tokens)} トークン。キャッシュは読み出し{" "}
              {formatCount(task.cost.cache_read_tokens)}、書き込み{" "}
              {formatCount(task.cost.cache_write_tokens)} トークン。
            </p>
            <dl className="facts">
              <Fact k="モデル" v={model.name} title={model.full} />
              {settings.model_selection === undefined ? null : (
                <Fact
                  k="モデルの選び方"
                  v={singleLine(modelSelectionText(settings.model_selection))}
                />
              )}
              <Fact k="思考" v={task.effort} />
              <Fact k="マージの方針" v={MERGE_POLICY[settings.merge_policy]} />
              {settings.deps_cache === undefined ? null : (
                <Fact
                  k="依存キャッシュ"
                  v={`${DEPS_CACHE[settings.deps_cache]}${
                    settings.deps_cache === "built" && settings.cache_build_ms !== undefined
                      ? `（${formatDuration(settings.cache_build_ms)}）`
                      : ""
                  }`}
                />
              )}
              {settings.sandbox_runtime_ms === undefined ? null : (
                <Fact k="Sandbox の稼働" v={formatDuration(settings.sandbox_runtime_ms)} />
              )}
              {settings.sandbox_instance === undefined ? null : (
                <Fact k="Sandbox の大きさ" v={singleLine(settings.sandbox_instance)} />
              )}
              <Fact k="作成" v={formatClock(Date.parse(task.created_at))} />
            </dl>
            {task.pr !== null && active ? (
              <p className="soft">
                完了して検証に通ったら、依頼した AI がレビューして Ready にします。
              </p>
            ) : null}
          </details>
        </div>

        <section
          className="screen"
          ref={scroll.ref}
          onScroll={scroll.onScroll}
          data-following={String(scroll.following)}
          aria-label="進み具合のコンソール"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: スクロールする領域はキーボードで焦点を当てて読めるようにする（WCAG 2.1.1）
          tabIndex={0}
        >
          {props.hasOlder ? (
            <div className="older">
              <button
                type="button"
                className="link-button"
                disabled={props.loadingOlder}
                onClick={props.onLoadOlder}
              >
                さらに読む
              </button>
              {props.loadingOlder ? <span role="status"> 読み込み中…</span> : null}
              {props.olderError ? (
                <span role="alert"> 古い手順を読み込めませんでした。</span>
              ) : null}
            </div>
          ) : null}
          {steps.length === 0 ? (
            <p className="screen-empty">進み具合はまだありません。</p>
          ) : (
            <ol className="steps">
              {steps.map((s, i) => (
                <StepItem
                  key={s.seq}
                  step={s}
                  timing={timings[i]}
                  waiting={waiting}
                  {...(s.seq === attachSeq ? { below: outputBox } : {})}
                />
              ))}
            </ol>
          )}

          {attachSeq === null ? outputBox : null}

          {active && !running ? (
            <div className="prompt-line">
              <span className="prompt">$ </span>
              <span className="cursor" aria-hidden="true" />
            </div>
          ) : null}
        </section>
      </div>

      <div className="con-foot">
        <span className="soft">{formatClockSeconds(generatedAt)} に更新。</span>
        <label>
          <input
            type="checkbox"
            checked={props.autoRefresh}
            onChange={(e) => props.onAutoRefreshChange(e.currentTarget.checked)}
          />
          自動で更新する
        </label>
        <button type="button" className="link-button" onClick={props.onRefresh}>
          今すぐ更新
        </button>
        {scroll.following ? null : (
          <button type="button" className="link-button" onClick={scroll.jumpToEnd}>
            末尾へ
          </button>
        )}
      </div>
    </section>
  );
}
