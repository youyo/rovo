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
import { completedKind, isTerminal, MARKS, type MarkKind, markKindOf } from "./status";
import { MarkGlyph } from "./status-mark";
import { type BandStep, buildSteps, nowSentence, phaseBand, type Step } from "./steps";

/** 詳細の本体（純粋な表示。データ取得は use-task-detail）。表示する文字列はすべて format / steps の関数を通す（D14）。 */

const MERGE_POLICY: Record<TaskDetailDto["settings"]["merge_policy"], string> = {
  human_review: "人のレビューを待つ",
  agent_merge: "依頼した AI がマージしてよい",
};

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
        <MarkGlyph kind={kind} />
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
  const cls = `step${step.current ? " step--now" : ""}${step.tone === "fail" ? " step--fail" : ""}`;
  return (
    <li className={cls} data-seq={step.seq} data-current={String(step.current)}>
      <span className="step-time">{formatClockSeconds(step.at)}</span>
      <span className="step-rail" aria-hidden="true">
        <span className="step-dot" />
      </span>
      <div className="step-body">
        <div className="step-what">
          {step.what}
          {step.target === "" ? null : <span className="step-target"> {step.target}</span>}
          {step.current ? <span className="step-tag">いま</span> : null}
        </div>
        {step.note === "" ? null : <div className="step-note">{step.note}</div>}
      </div>
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

function PrSection(props: { task: VisibleTaskDto }) {
  const { task } = props;
  const pr = task.pr;
  const kind = prMark(task);
  return (
    <section aria-labelledby="pr-h" className="info-section" data-pr="">
      <h2 id="pr-h">Draft PR</h2>
      {pr === null ? (
        <p className="soft">まだありません。</p>
      ) : (
        <>
          {/* 外部リンクは GitHub の PR の URL に厳密に一致するものだけ（D14） */}
          <p className="pr-link">
            {isAllowedPrUrl(pr.url) ? (
              <a href={pr.url} target="_blank" rel="noopener noreferrer">
                {singleLine(task.repository)} #{pr.number}
              </a>
            ) : (
              <span>
                {singleLine(task.repository)} #{pr.number}
              </span>
            )}
          </p>
          <p className="pr-state">
            {kind === null ? null : (
              <span className="status">
                <MarkGlyph kind={kind} />
                {MARKS[kind].label}
              </span>
            )}
            {pr.draft === true ? <span className="soft">Draft</span> : null}
            {pr.draft === false ? <span className="soft">Ready for review</span> : null}
          </p>
          {isTerminal(task.status) ? null : (
            <p className="soft">
              完了して検証に通ったら、依頼した AI がレビューして Ready にします。
            </p>
          )}
        </>
      )}
    </section>
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
  const band = phaseBand(task, detail.phase, reached);
  const steps = buildSteps(events, active);
  const now = nowSentence(detail.now, task.status);
  const model = shortModel(task.model);

  return (
    <div className="task">
      {props.stale ? (
        <p className="notice" role="status">
          更新できませんでした。前の内容を表示しています（自動で再試行します）。
        </p>
      ) : null}

      <section className="task-head" aria-labelledby="task-h">
        <div className="task-meta">
          <StatusLine task={task} />
          <span>{elapsedText(task, generatedAt)}</span>
          <span>{singleLine(task.repository)}</span>
          <span>{singleLine(task.owner_login)} が依頼</span>
          {task.reason === undefined ? null : <span>理由 {singleLine(task.reason)}</span>}
        </div>
        <h1 id="task-h">{singleLine(task.title)}</h1>
        <p className="now-line">
          {now.before}
          {now.target === "" ? null : <strong>{now.target}</strong>}
          {now.after}
        </p>
      </section>

      <Band band={band} />

      <div className="task-cols">
        <section className="progress" aria-labelledby="log-h">
          <div className="progress-head">
            <h2 id="log-h">進み具合</h2>
            <div className="progress-controls">
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
            </div>
          </div>
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
            <p className="soft">進み具合はまだありません。</p>
          ) : (
            <ol className="steps">
              {steps.map((s) => (
                <StepItem key={s.seq} step={s} />
              ))}
            </ol>
          )}

          <div className="output-box">
            <h3>出力の末尾</h3>
            {output.tail === null ? null : (
              <pre className="output">{sanitizeText(output.tail)}</pre>
            )}
            <p className="output-note">
              子エージェントが実行したコマンドの出力の一部です。トークンなどの秘密は伏せて表示しています。
              {output.tail === null ? "いまは表示できる出力がありません。" : ""}
            </p>
          </div>
        </section>

        <aside className="info" aria-label="このタスクの情報">
          <section aria-labelledby="cost-h" className="info-section">
            <h2 id="cost-h">ここまでの費用</h2>
            <p className="cost-big">{formatUsd(task.cost.cost_usd)}</p>
            <p>
              入力 {formatCount(task.cost.input_tokens)} トークン、出力{" "}
              {formatCount(task.cost.output_tokens)} トークン。
            </p>
            <p className="soft">
              キャッシュは読み出し {formatCount(task.cost.cache_read_tokens)}、書き込み{" "}
              {formatCount(task.cost.cache_write_tokens)} トークン。
            </p>
          </section>

          <section aria-labelledby="facts-h" className="info-section">
            <h2 id="facts-h">設定</h2>
            <dl className="facts">
              <Fact k="モデル" v={model.name} title={model.full} />
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
          </section>

          <PrSection task={task} />
        </aside>
      </div>

      <p className="foot-note soft">{formatClockSeconds(generatedAt)} に更新。</p>
    </div>
  );
}
