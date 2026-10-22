import { cloudflareEstimateHead, cloudflareRows } from "./cloudflare";
import { isAllowedCloudflareUrl } from "./format";
import type { CloudflareState } from "./use-cloudflare";

/**
 * 右の列の Cloudflare の枠（直近 24 時間）。取れない項目は理由の言葉で出し、
 * 枠全体が取れなくても他の部分は出す。リンクは Cloudflare のトップだけ（アカウント ID を含めない）。
 */
export function CloudflarePanel(props: { state: CloudflareState }) {
  const { state } = props;
  const data = state.phase === "ready" ? state.data : state.phase === "failed" ? state.stale : null;
  return (
    <section className="panel" data-cloudflare="" aria-labelledby="cf-h">
      <h2 id="cf-h">Cloudflare</h2>
      <p className="caption">直近 24 時間</p>
      {data !== null && cloudflareEstimateHead(data) !== null ? (
        <p className="cf-total" data-cf-total="">
          <span>{cloudflareEstimateHead(data)?.text}</span>
          {cloudflareEstimateHead(data)?.partial ? (
            <span className="cf-note">一部の項目は含まない</span>
          ) : null}
        </p>
      ) : null}
      {state.phase === "failed" ? (
        <p className="soft" role="status">
          {data === null
            ? "取得できませんでした。自動で再試行します。"
            : "更新できませんでした。前の内容を表示しています。"}
        </p>
      ) : null}
      {state.phase === "loading" || state.phase === "unauthorized" ? (
        <p className="soft" role="status">
          読み込み中…
        </p>
      ) : null}
      {data !== null ? (
        <ul className="cf-rows">
          {cloudflareRows(data).map((r) => (
            <li key={r.key} data-cf={r.key} data-ok={r.ok ? "true" : "false"}>
              <span className="cf-name">{r.name}</span>
              <span className="cf-value">
                <span className={r.ok ? "cf-text" : "cf-text cf-missing"}>{r.text}</span>
                {r.cost !== null ? <span className="cf-cost">{r.cost}</span> : null}
                {isAllowedCloudflareUrl(r.href) ? (
                  <a
                    href={r.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={r.ariaLabel}
                  >
                    開く
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
