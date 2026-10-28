import type {
  TaskDetailDto,
  TaskEventDto,
  TaskStatusDto,
  VisibleTaskDto,
} from "@rovo/dashboard-contract";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { CiChip, CiPane, CiTabFailed, ciFailedCount } from "./ci-pane";
import {
  formatClockSeconds,
  formatCount,
  formatDateTime,
  formatDuration,
  formatUsd,
  isAllowedPrUrl,
  sanitizeText,
  shortModel,
  singleLine,
} from "./format";
import type { T } from "./i18n";
import { useT } from "./lang";
import { type ConsoleTab, loadConsoleTab, saveConsoleTab } from "./prefs";
import {
  completedKind,
  isTerminal,
  type MarkKind,
  markDescription,
  markKindOf,
  markLabel,
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
import type { ChecksState } from "./use-task-checks";
import { useWide } from "./use-wide";

/**
 * コンソール（詳細の本体。純粋な表示。データ取得は use-task-detail）。GitHub Actions の run の形:
 * 要約のカード（印付きの題名・状態・モデル・所要・費用・リポジトリ・依頼者・PR・「いま」）→ 段階（job の箱を線でつないだ図）
 * → ログの箱（ステップの行と、いま実行中のコマンドの出力の末尾）。
 * 表示する文字列はすべて format / steps の関数を通す（D14）。
 */

/** モデルの選び方の理由のコード（gateway の model-selection.ts の reason）。知らないコードはそのまま出す */
const MODEL_SELECTION_REASONS = [
  "clef_flash",
  "clef_cascade",
  "single_candidate",
  "no_candidates",
  "fallback_unconfigured",
  "fallback_timeout",
  "fallback_error",
  "fallback_invalid",
] as const;
type ModelSelectionReason = (typeof MODEL_SELECTION_REASONS)[number];
const isKnownReason = (r: string): r is ModelSelectionReason =>
  (MODEL_SELECTION_REASONS as readonly string[]).includes(r);

function modelSelectionText(
  sel: NonNullable<TaskDetailDto["settings"]["model_selection"]>,
  t: T,
): string {
  if (sel.mode === "explicit") return t("modelSelection.explicit");
  const reason = isKnownReason(sel.reason) ? t(`modelSelection.${sel.reason}`) : sel.reason;
  return t("modelSelection.auto", { reason });
}

/** 見出しの状態。印はレール・凡例と同じ記号。名前は短い label のまま、title で長い説明（無ければ label）を出す */
function StatusLine(props: { task: VisibleTaskDto }) {
  const t = useT();
  const kind = markKindOf(props.task);
  return (
    <span className="state-name" title={markDescription(kind, t)}>
      <MarkSymbol kind={kind} decorative />
      {markLabel(kind, t)}
    </span>
  );
}

/** 経過時間のラベルと値。終わったタスクは「所要」、続いているタスクは「開始から」 */
function elapsedFact(
  task: VisibleTaskDto,
  generatedAt: number,
  t: T,
): { label: string; value: string } {
  const start = Date.parse(task.started_at ?? task.created_at);
  if (isTerminal(task.status)) {
    const end = task.ended_at === null ? generatedAt : Date.parse(task.ended_at);
    return { label: t("meta.duration"), value: formatDuration(end - start, t) };
  }
  return { label: t("meta.elapsed"), value: formatDuration(generatedAt - start, t) };
}

/** 所要の文字。終わっていない（今までの経過）なら末尾に … */
const timingText = (timing: StepTiming | PhaseTiming, t: T): string =>
  `${formatDuration(timing.ms, t)}${timing.open ? "…" : ""}`;

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
  const t = useT();
  const label = t("band.aria", {
    list: props.band
      .map((b) => t("band.item", { name: b.name, label: b.label }))
      .join(t("common.sep")),
  });
  return (
    <ol className="band" data-band="" aria-label={label}>
      {props.band.map((b, i) => {
        const timing = props.timings[b.key];
        // 所要があればそれ。止まった・入力待ち・復旧中は、所要の前に状態の文字も添える。所要が無ければ状態の文字
        const small =
          timing === undefined
            ? b.label
            : b.state === "stopped" || b.state === "waiting" || b.state === "recovering"
              ? `${b.label} ${timingText(timing, t)}`
              : timingText(timing, t);
        return (
          <li key={b.key} className={`band-item band-item--${b.state}`} data-state={b.state}>
            {i > 0 ? (
              <span
                className={`band-edge${props.band[i - 1]?.state === "done" ? " done" : ""}`}
                aria-hidden="true"
              />
            ) : null}
            <span
              className="job"
              title={`${t("band.item", { name: b.name, label: b.label })}${
                small === b.label ? "" : `${t("common.sep")}${small}`
              }`}
            >
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
  const t = useT();
  const cls = `step${step.current ? " step--now" : ""}${step.tone === "fail" ? " step--fail" : ""}${
    step.command ? " step--cmd" : ""
  }`;
  const expandable = step.note !== "" || props.below !== undefined || step.outputTail !== undefined;
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
            <span className="prompt">$ </span>
            <span className="step-target">{step.target}</span>
          </>
        ) : (
          <>
            <span className="step-what">{step.what}</span>
            {step.target === "" ? null : <span className="step-target"> {step.target}</span>}
          </>
        )}
        {step.current ? <span className="step-tag">{t("step.now")}</span> : null}
      </span>
      <span className="step-time">{formatClockSeconds(step.at, t)}</span>
      {props.timing === undefined ? (
        <span className="step-dur step-dur--none" />
      ) : (
        <span className={`step-dur${props.timing.open ? " step-dur--open" : ""}`}>
          {timingText(props.timing, t)}
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
            {props.below ??
              (step.outputTail === undefined ? null : (
                <div className="step-output">
                  <OutputLines tail={step.outputTail} />
                  <p className="output-note">{t("output.note")}</p>
                </div>
              ))}
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
  const t = useT();
  const pr = task.pr;
  if (pr === null) {
    return (
      <span className="con-pr" data-pr="">
        <span className="soft">{t("pr.none")}</span>
      </span>
    );
  }
  const kind = prMark(task);
  const label = t(pr.draft === false ? "pr.label" : "pr.draftLabel", { n: pr.number });
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
        <span className="status" title={markDescription(kind, t)}>
          <MarkSymbol kind={kind} decorative />
          {markLabel(kind, t)}
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
  /** PR の隣に出す CI の要約チップ（PR があるときだけ） */
  ci?: ReactNode;
}) {
  const { task } = props;
  const t = useT();
  const model = shortModel(task.model);
  const elapsed = elapsedFact(task, props.generatedAt, t);
  return (
    <dl className="con-meta">
      <MetaItem k={t("meta.status")}>
        <StatusLine task={task} />
      </MetaItem>
      <MetaItem k={t("meta.model")}>
        <span data-model="" title={model.full}>
          {model.name}
        </span>
        {props.modelSelection === undefined ? null : (
          <span className="soft"> {modelSelectionText(props.modelSelection, t)}</span>
        )}
      </MetaItem>
      <MetaItem k={elapsed.label}>{elapsed.value}</MetaItem>
      <MetaItem k={t("meta.cost")}>{formatUsd(task.cost.cost_usd, t)}</MetaItem>
      <MetaItem k={t("meta.repository")}>{singleLine(task.repository)}</MetaItem>
      <MetaItem k={t("meta.requester")}>{singleLine(task.owner_login)}</MetaItem>
      {task.reason === undefined ? null : (
        <MetaItem k={t("meta.reason")}>{singleLine(task.reason)}</MetaItem>
      )}
      <MetaItem k={t("meta.pr")}>
        <PrInline task={task} />
        {props.ci}
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
  const t = useT();
  return (
    <section className="console" aria-labelledby="task-h" aria-busy="true" data-preview="">
      <div className="con-head">
        <ConTitle task={props.task} />
        <ConMeta task={props.task} generatedAt={props.at} />
      </div>
      <p className="soft con-loading" role="status">
        {t("common.loading")}
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
  /** PR の CI。PR が無い（取りに行かない）ときは null / 未指定。あれば、チップ・タブ（または並びのペイン）を出す */
  checks?: ChecksState | null;
}) {
  const { detail, events } = props;
  const t = useT();
  const checks = props.checks ?? null;
  const wide = useWide();
  const [tab, setTab] = useState<ConsoleTab>(() => loadConsoleTab());
  const ciRef = useRef<HTMLElement | null>(null);
  const focusCi = useRef(false);
  useEffect(() => {
    // タブを切り替えた直後の焦点（隠れていた CI のパネルが見えてから移す）
    if (focusCi.current && (wide || tab === "ci")) {
      focusCi.current = false;
      ciRef.current?.focus();
    }
  }, [tab, wide]);
  const chooseTab = (next: ConsoleTab) => {
    setTab(next);
    saveConsoleTab(next);
  };
  /** チップ: 並びの時は CI のペインへ焦点とスクロール、タブの時は CI のタブへ */
  const showCi = () => {
    const pane = ciRef.current;
    if (wide) {
      pane?.focus({ preventScroll: true });
      const calm =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      pane?.scrollIntoView?.({ block: "nearest", behavior: calm ? "auto" : "smooth" });
      return;
    }
    focusCi.current = true;
    if (tab === "ci") ciRef.current?.focus();
    else chooseTab("ci");
  };
  const onTabKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: ConsoleTab = tab === "console" ? "ci" : "console";
    chooseTab(next);
    document.getElementById(`con-tab-${next}`)?.focus();
  };
  const failed = ciFailedCount(checks);
  const { task, settings, output } = detail;
  const generatedAt = Date.parse(detail.generated_at);
  const active = !isTerminal(task.status);
  const reached = new Set(
    events.flatMap((e) => (e.type === "status_changed" ? [e.to] : [])),
  ) as ReadonlySet<TaskStatusDto>;
  const band = phaseBand(task, detail.phase, t, reached, detail.stopped_phase);
  const steps = buildSteps(events, active, t);
  let lastPlace: string | undefined;
  const timings = stepTimings(steps, generatedAt);
  const phases = phaseTimings(events, band, generatedAt);
  const now = nowSentence(detail.now, task.status, t);
  const model = shortModel(task.model);
  const running = output.running === true;
  const waiting = task.status === "INPUT_REQUIRED";
  // 実行中のコマンドの出力の末尾は、そのコマンドの行（いまの行）の下に開いて見せる。
  // 実行中でない（終わったコマンドの末尾）、またはいまの行がコマンドでないときは、手順の外の出力の枠に出す
  // （終わったコマンドの出力がどの行のものかは、決めつけない）
  const lastStep = steps.at(-1);
  const hasStepTail = steps.some((s) => s.outputTail !== undefined);
  const attachSeq = running && lastStep?.current && lastStep.command ? lastStep.seq : null;

  const scroll = useStickToBottom(
    `${events.at(-1)?.seq ?? 0}:${steps.length}:${output.tail?.length ?? -1}:${running}:${props.hasOlder}`,
  );

  const outputBox = (
    <div className="output-box">
      <h3>
        {output.command === undefined
          ? t("output.tail")
          : t(running ? "output.ofRunning" : "output.ofTail", {
              command: singleLine(output.command),
            })}
      </h3>
      {output.tail === null ? null : <OutputLines tail={output.tail} />}
      {running && (
        <p className="output-running">
          {t("output.running")}
          {output.started_at !== undefined && !Number.isNaN(generatedAt)
            ? t("output.elapsed", {
                duration: formatDuration(generatedAt - Date.parse(output.started_at), t),
              })
            : ""}
          <span className="cursor" aria-hidden="true" />
        </p>
      )}
      <p className="output-note">
        {t("output.note")}
        {output.tail === null ? t("output.none") : ""}
      </p>
    </div>
  );

  const consoleBody = (
    <>
      <Band band={band} timings={phases} />

      <div className="logbox">
        <div className="loghd">
          <span className="loghd-title">
            {t("log.title")}{" "}
            <span className="loghd-count">
              {t("log.count", { n: steps.length, plus: props.hasOlder ? "+" : "" })}
            </span>
          </span>
          <details className="con-more">
            <summary>{t("log.settings")}</summary>
            <p>
              {t("log.tokens", {
                input: formatCount(task.cost.input_tokens, t),
                output: formatCount(task.cost.output_tokens, t),
                read: formatCount(task.cost.cache_read_tokens, t),
                write: formatCount(task.cost.cache_write_tokens, t),
              })}
            </p>
            <dl className="facts">
              <Fact k={t("fact.model")} v={model.name} title={model.full} />
              {settings.model_selection === undefined ? null : (
                <Fact
                  k={t("fact.modelSelection")}
                  v={singleLine(modelSelectionText(settings.model_selection, t))}
                />
              )}
              <Fact k={t("fact.effort")} v={task.effort} />
              <Fact k={t("fact.reviewPolicy")} v={t(`reviewPolicy.${settings.review_policy}`)} />
              {settings.deps_cache === undefined ? null : (
                <Fact
                  k={t("fact.depsCache")}
                  v={`${t(`depsCache.${settings.deps_cache}`)}${
                    settings.deps_cache === "built" && settings.cache_build_ms !== undefined
                      ? t("depsCache.builtTime", {
                          duration: formatDuration(settings.cache_build_ms, t),
                        })
                      : ""
                  }`}
                />
              )}
              {settings.sandbox_runtime_ms === undefined ? null : (
                <Fact
                  k={t("fact.sandboxRuntime")}
                  v={formatDuration(settings.sandbox_runtime_ms, t)}
                />
              )}
              {settings.sandbox_instance === undefined ? null : (
                <Fact k={t("fact.sandboxSize")} v={singleLine(settings.sandbox_instance)} />
              )}
              <Fact k={t("fact.created")} v={formatDateTime(Date.parse(task.created_at), t)} />
            </dl>
            {task.pr !== null && active ? <p className="soft">{t("log.readyNote")}</p> : null}
          </details>
        </div>

        <section
          className="screen"
          ref={scroll.ref}
          onScroll={scroll.onScroll}
          data-following={String(scroll.following)}
          aria-label={t("screen.label")}
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
                {t("screen.older")}
              </button>
              {props.loadingOlder ? <span role="status"> {t("common.loading")}</span> : null}
              {props.olderError ? <span role="alert"> {t("screen.olderError")}</span> : null}
            </div>
          ) : null}
          {steps.length === 0 ? (
            <p className="screen-empty">{t("screen.empty")}</p>
          ) : (
            <ol className="steps">
              {steps.flatMap((s, i) => {
                const items: ReactNode[] = [];
                if (s.command) {
                  const place = s.where ?? "";
                  const prev = lastPlace;
                  lastPlace = place;
                  if (prev === undefined ? place !== "" : prev !== place) {
                    items.push(
                      <li key={`h${s.seq}`} className="step-head">
                        {place === "" ? t("step.root") : place}
                      </li>,
                    );
                  }
                }
                items.push(
                  <StepItem
                    key={s.seq}
                    step={s}
                    timing={timings[i]}
                    waiting={waiting}
                    {...(s.seq === attachSeq ? { below: outputBox } : {})}
                  />,
                );
                return items;
              })}
            </ol>
          )}

          {attachSeq === null && (running || !hasStepTail) ? outputBox : null}

          {active && !running ? (
            <div className="prompt-line">
              <span className="prompt">$ </span>
              <span className="cursor" aria-hidden="true" />
            </div>
          ) : null}
        </section>
      </div>
    </>
  );

  return (
    <section className="console" aria-labelledby="task-h">
      {props.stale ? (
        <p className="notice" role="status">
          {t("console.stale")}
        </p>
      ) : null}

      <div className="con-head">
        <ConTitle task={task} />
        <ConMeta
          task={task}
          generatedAt={generatedAt}
          modelSelection={settings.model_selection}
          {...(checks === null ? {} : { ci: <CiChip state={checks} onClick={showCi} /> })}
        />
        <p className="now-line" data-active={String(active)}>
          {now.before}
          {now.prompt === undefined ? null : (
            <span className="prompt now-prompt">{now.prompt}</span>
          )}
          {now.target === "" ? null : <strong>{now.target}</strong>}
          {now.after}
        </p>
      </div>

      {checks === null ? (
        consoleBody
      ) : (
        <>
          {wide ? null : (
            <div className="ci-tabs" role="tablist" aria-label={t("ci.tabsLabel")}>
              <button
                type="button"
                role="tab"
                id="con-tab-console"
                aria-selected={tab === "console"}
                aria-controls="con-panel-console"
                tabIndex={tab === "console" ? 0 : -1}
                onClick={() => chooseTab("console")}
                onKeyDown={onTabKey}
              >
                {t("ci.tabConsole")}
              </button>
              <button
                type="button"
                role="tab"
                id="con-tab-ci"
                aria-selected={tab === "ci"}
                aria-controls="con-panel-ci"
                tabIndex={tab === "ci" ? 0 : -1}
                onClick={() => chooseTab("ci")}
                onKeyDown={onTabKey}
                {...(failed > 0 ? { "aria-label": t("ci.tabCiFailedAria", { n: failed }) } : {})}
              >
                {t("ci.tabCi")}
                {failed > 0 ? <CiTabFailed n={failed} /> : null}
              </button>
            </div>
          )}
          <div className="con-split" data-wide={String(wide)}>
            <div
              className="con-main"
              id="con-panel-console"
              {...(wide ? {} : { role: "tabpanel", "aria-labelledby": "con-tab-console" })}
              hidden={!wide && tab !== "console"}
            >
              {consoleBody}
            </div>
            <CiPane
              state={checks}
              now={Date.now()}
              id="con-panel-ci"
              headingId="ci-h"
              paneRef={ciRef}
              hidden={!wide && tab !== "ci"}
              {...(wide ? {} : { role: "tabpanel" as const, labelledBy: "con-tab-ci" })}
            />
          </div>
        </>
      )}

      <div className="con-foot">
        <span className="soft">
          {t("foot.updated", { time: formatClockSeconds(generatedAt, t) })}
        </span>
        <label>
          <input
            type="checkbox"
            checked={props.autoRefresh}
            onChange={(e) => props.onAutoRefreshChange(e.currentTarget.checked)}
          />
          {t("common.autoRefresh")}
        </label>
        <button type="button" className="link-button" onClick={props.onRefresh}>
          {t("common.refreshNow")}
        </button>
        {scroll.following ? null : (
          <button type="button" className="link-button" onClick={scroll.jumpToEnd}>
            {t("foot.jumpToEnd")}
          </button>
        )}
      </div>
    </section>
  );
}
