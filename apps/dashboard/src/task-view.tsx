import type {
  TaskDetailDto,
  TaskEventDto,
  TaskStatusDto,
  VisibleTaskDto,
} from "@rovo/dashboard-contract";
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
import { railGlyph } from "./rail";
import { completedKind, isTerminal, MARKS, type MarkKind, markKindOf } from "./status";
import { MarkGlyph } from "./status-mark";
import { type BandStep, buildSteps, nowSentence, phaseBand, type Step } from "./steps";
import { useStickToBottom } from "./use-stick-to-bottom";

/**
 * コンソール（詳細の本体。純粋な表示。データ取得は use-task-detail）。
 * 見出し（題名・モデル・所要・費用・Draft PR）→ 段階の帯 → 画面（構造化イベントの行と、出力の末尾）。
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

const PULSING: ReadonlySet<TaskStatusDto> = new Set(["RUNNING", "VERIFYING"]);

function StatusLine(props: { task: VisibleTaskDto }) {
  const { task } = props;
  const kind = markKindOf(task);
  return (
    <span className="state-name">
      {PULSING.has(task.status) ? (
        <span className="pulse" aria-hidden="true" />
      ) : (
        <span className={`rail-mark rail-mark--${railGlyph(kind).tone}`} aria-hidden="true">
          {railGlyph(kind).char}
        </span>
      )}
      {MARKS[kind].label}
    </span>
  );
}

function elapsedText(task: VisibleTaskDto, generatedAt: number): string {
  const start = Date.parse(task.started_at ?? task.created_at);
  if (isTerminal(task.status)) {
    const end = task.ended_at === null ? generatedAt : Date.parse(task.ended_at);
    return `所要 ${formatDuration(end - start)}`;
  }
  return `開始から ${formatDuration(generatedAt - start)}`;
}

function Band(props: { band: BandStep[] }) {
  const label = `段階: ${props.band.map((b) => `${b.name}は${b.label}`).join("、")}`;
  return (
    <ol className="band" data-band="" aria-label={label}>
      {props.band.map((b) => (
        <li key={b.key} className={`band-item band-item--${b.state}`} data-state={b.state}>
          <span className="band-bar" aria-hidden="true" />
          <span className="band-name">{b.name}</span>
          <span className="band-label">{b.label}</span>
        </li>
      ))}
    </ol>
  );
}

function StepItem(props: { step: Step }) {
  const { step } = props;
  const cls = `step${step.current ? " step--now" : ""}${step.tone === "fail" ? " step--fail" : ""}${
    step.command ? " step--cmd" : ""
  }`;
  return (
    <li className={cls} data-seq={step.seq} data-current={String(step.current)}>
      <span className="step-time">{formatClockSeconds(step.at)}</span>
      <span className="step-body">
        {step.command ? (
          <>
            <span className="sr-only">{step.what} </span>
            <span className="prompt">$ </span>
            <span className="step-target">{step.target}</span>
          </>
        ) : (
          <>
            <span className="step-what">{step.what}</span>
            {step.target === "" ? null : <span className="step-target"> {step.target}</span>}
          </>
        )}
        {step.note === "" ? null : <span className="step-note">{step.note}</span>}
        {step.current ? <span className="step-tag">いま</span> : null}
      </span>
    </li>
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
        <span className="status">
          <MarkGlyph kind={kind} />
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
  const now = nowSentence(detail.now, task.status);
  const model = shortModel(task.model);
  const running = output.running === true;

  const scroll = useStickToBottom(
    `${events.at(-1)?.seq ?? 0}:${steps.length}:${output.tail?.length ?? -1}:${running}:${props.hasOlder}`,
  );

  return (
    <section className="console" aria-labelledby="task-h">
      {props.stale ? (
        <p className="notice" role="status">
          更新できませんでした。前の内容を表示しています（自動で再試行します）。
        </p>
      ) : null}

      <div className="con-head">
        <h1 id="task-h">{singleLine(task.title)}</h1>
        <div className="con-meta">
          <StatusLine task={task} />
          <span className="con-model">
            <span data-model="" title={model.full}>
              {model.name}
            </span>
            {settings.model_selection === undefined ? null : (
              <span className="soft"> {modelSelectionText(settings.model_selection)}</span>
            )}
          </span>
          <span>{elapsedText(task, generatedAt)}</span>
          <span>{formatUsd(task.cost.cost_usd)}</span>
          <span className="soft">{singleLine(task.repository)}</span>
          <span className="soft">{singleLine(task.owner_login)} が依頼</span>
          {task.reason === undefined ? null : (
            <span className="soft">理由 {singleLine(task.reason)}</span>
          )}
          <span className="grow" />
          <PrInline task={task} />
        </div>
        <p className="now-line">
          {now.before}
          {now.prompt === undefined ? null : (
            <span className="prompt now-prompt">{now.prompt}</span>
          )}
          {now.target === "" ? null : <strong>{now.target}</strong>}
          {now.after}
        </p>
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

      <Band band={band} />

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
            {props.olderError ? <span role="alert"> 古い手順を読み込めませんでした。</span> : null}
          </div>
        ) : null}
        {steps.length === 0 ? (
          <p className="screen-empty">進み具合はまだありません。</p>
        ) : (
          <ol className="steps">
            {steps.map((s) => (
              <StepItem key={s.seq} step={s} />
            ))}
          </ol>
        )}

        <div className="output-box">
          <h3>
            {output.command === undefined
              ? "出力の末尾"
              : `${singleLine(output.command)} の出力（${running ? "途中" : "末尾"}）`}
          </h3>
          {output.tail === null ? null : <pre className="output">{sanitizeText(output.tail)}</pre>}
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

        {active && !running ? (
          <div className="prompt-line">
            <span className="prompt">$ </span>
            <span className="cursor" aria-hidden="true" />
          </div>
        ) : null}
      </section>

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
