import type { CloudflareSummaryDto } from "@rovo/dashboard-contract";
import { cloudflareEstimateHead, cloudflareRows } from "./cloudflare";
import { isAllowedCloudflareUrl } from "./format";
import { useT } from "./lang";
import type { CloudflareState } from "./use-cloudflare";

/**
 * 右の列の Cloudflare の枠（既定は今月・UTC。見出しは応答の range に従う）。取れない項目は理由の言葉で出し、
 * 枠全体が取れなくても他の部分は出す。リンクは行ごとの ?to=/:account/ 形（アカウント ID を含めない）。
 */
export function CloudflarePanel(props: { state: CloudflareState }) {
  const { state } = props;
  const t = useT();
  const head = (d: CloudflareSummaryDto) => cloudflareEstimateHead(d, t);
  const data = state.phase === "ready" ? state.data : state.phase === "failed" ? state.stale : null;
  return (
    <section className="panel" data-cloudflare="" aria-labelledby="cf-h">
      <h2 id="cf-h">{t("cf.title")}</h2>
      <p className="caption">{t(`cf.window.${data?.range ?? "month"}`)}</p>
      {data !== null && head(data) !== null ? (
        <p className="cf-total" data-cf-total="">
          <span>{head(data)?.text}</span>
          {head(data)?.partial ? <span className="cf-note">{t("cf.partial")}</span> : null}
        </p>
      ) : null}
      {state.phase === "failed" ? (
        <p className="soft" role="status">
          {data === null ? t("cf.failed") : t("cf.stale")}
        </p>
      ) : null}
      {state.phase === "loading" || state.phase === "unauthorized" ? (
        <p className="soft" role="status">
          {t("common.loading")}
        </p>
      ) : null}
      {data !== null ? (
        <ul className="cf-rows">
          {cloudflareRows(data, t).map((r) => (
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
                    {t("cf.open")}
                  </a>
                ) : null}
              </span>
              {r.note !== null ? (
                <span className="cf-note cf-basis" data-cf-note="">
                  {r.note}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
