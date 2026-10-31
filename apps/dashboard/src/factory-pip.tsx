import type { OverviewDto } from "@rovo/dashboard-contract";
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFactoryT } from "./factory-i18n";
import FactoryScene from "./factory-scene";
import { formatClock } from "./format";
import { useLang } from "./lang";
import { overviewKeepAlive } from "./poller";
import { taskPath } from "./route";

/**
 * 工場の帯の「小窓」（Document Picture-in-Picture。docs/specs/dashboard-factory.md の「小窓」）。遅延読み込みのチャンクに置く（本体を増やさない）。
 * 小窓の中身は断面図だけ。同じ React の木から createPortal で描く（同じデータ・同じ onSelect）。
 * CSP（style-src 'self'）を変えないため、小窓の head には元の文書の <link rel="stylesheet"> を絶対 URL で作り直して入れる
 * （<style> 要素は作らない・cssRules の文字列は写さない）。この処理はチャンクの中で走るので、チャンクの CSS の link も元の head に入っている。
 */

type DocumentPip = {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
};

/** 小窓に頼む大きさ（断面図の 1440 × 280 を半分に縮めた幅。高さは古さの表示の分だけ足す） */
const PIP_SIZE = { width: 720, height: 150 } as const;
/** 最後に更新に成功してから、これより経ったら古いと出す */
export const PIP_STALE_MS = 30_000;
/** 古さの表示を描き直す間隔 */
const PIP_TICK_MS = 5_000;
/** 小窓の link の load を待つ上限（読めなくても描く） */
const LINK_TIMEOUT_MS = 3_000;

function documentPip(): DocumentPip | null {
  if (typeof window === "undefined" || !("documentPictureInPicture" in window)) return null;
  return (window as unknown as { documentPictureInPicture: DocumentPip }).documentPictureInPicture;
}

/** このブラウザで小窓を出せるか（Chrome / Edge。Safari・Firefox は出せない） */
export function pipSupported(): boolean {
  return documentPip() !== null;
}

/** 元の文書の <link rel="stylesheet"> を、href を絶対 URL にして小窓の head に作り直す */
export function copyStylesheets(from: Document, to: Document): HTMLLinkElement[] {
  const out: HTMLLinkElement[] = [];
  for (const src of from.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')) {
    const href = src.getAttribute("href");
    if (!href) continue;
    const link = to.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL(href, from.baseURI).href;
    if (src.media) link.media = src.media;
    // 元と同じ取り方（CORS の有無）にして、読み込み済みのものを使い回せるようにする
    if (src.crossOrigin !== null) link.crossOrigin = src.crossOrigin;
    to.head.append(link);
    out.push(link);
  }
  return out;
}

/** link をすべて読み終える（失敗も終わりに数える）まで待つ。上限を過ぎたら待たない */
function whenLoaded(links: HTMLLinkElement[], view: Window): Promise<void> {
  return new Promise((resolve) => {
    let left = links.length;
    if (left === 0) {
      resolve();
      return;
    }
    const done = () => {
      left -= 1;
      if (left === 0) resolve();
    };
    for (const l of links) {
      l.addEventListener("load", done, { once: true });
      l.addEventListener("error", done, { once: true });
    }
    view.setTimeout(resolve, LINK_TIMEOUT_MS);
  });
}

/** 閉じる（もう閉じている・閉じられないときも投げない） */
function closeQuietly(win: Window) {
  try {
    win.close();
  } catch {
    // 閉じられなくても続ける
  }
}

/**
 * 小窓の開け閉め。win は開いている小窓（元の帯を「小窓で表示中」の 1 行にする）、ready は小窓の CSS を読み終えたか（読み終えてから描く）、
 * requesting は requestWindow の解決を待っている間（ボタンを押せなくする。二重に開かないためのガードは open の中の ref）。
 * 開いている間は overviewKeepAlive に「小窓の文書が visible か」を差し込み、元のタブが hidden でも一覧の自動更新を続ける。
 * 小窓の pagehide（利用者が閉じた・「戻す」）で元に戻し、帯が消えたら小窓も閉じる。
 * 要求ごとに世代を持ち、最新の世代でない要求（帯が消えた・effect の後始末が走った後に解決したもの）の小窓はすぐ閉じ、状態にも keepAlive にも触らない。
 * 小窓の初期化で例外が出たら、その小窓を閉じて keepAlive を外す（管理外の小窓を残さない）。
 */
export function usePip(title: string) {
  const [state, setState] = useState<{ win: Window; ready: boolean } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const cur = useRef<{ win: Window; off: () => void } | null>(null);
  /** requestWindow を呼んでから解決・拒否までの間。呼ぶ前に同期的に立てる（state の反映を待たない） */
  const pending = useRef(false);
  /** 要求の世代。open のたびと後始末で進める */
  const gen = useRef(0);

  const finish = useCallback((win: Window) => {
    if (cur.current?.win !== win) return;
    cur.current.off();
    cur.current = null;
    setState(null);
  }, []);

  /** 開いた小窓を初期化して採用する。例外が出たら閉じて元に戻す */
  const attach = (win: Window) => {
    const doc = win.document;
    const onHide = () => finish(win);
    const onVisible = () => overviewKeepAlive.notify();
    cur.current = {
      win,
      off: () => {
        win.removeEventListener("pagehide", onHide);
        doc.removeEventListener("visibilitychange", onVisible);
        overviewKeepAlive.set(null);
      },
    };
    try {
      win.addEventListener("pagehide", onHide);
      doc.addEventListener("visibilitychange", onVisible);
      doc.documentElement.lang = document.documentElement.lang;
      doc.title = title;
      doc.body.classList.add("fxpip");
      const links = copyStylesheets(document, doc);
      overviewKeepAlive.set(() => doc.visibilityState === "visible");
      setState({ win, ready: false });
      void whenLoaded(links, win).then(() => {
        if (cur.current?.win === win) setState({ win, ready: true });
      });
    } catch {
      finish(win);
      closeQuietly(win);
    }
  };

  const open = () => {
    const api = documentPip();
    if (api === null || pending.current || cur.current !== null) return;
    gen.current += 1;
    const my = gen.current;
    pending.current = true;
    // ユーザーの操作（クリック）の中で最初に呼ぶ（この前に await を置かない）
    let req: Promise<Window>;
    try {
      req = api.requestWindow(PIP_SIZE);
    } catch {
      pending.current = false;
      return;
    }
    setRequesting(true);
    /** この要求が最新なら「要求中」を下ろして true。古い世代なら何もしないで false */
    const settle = (): boolean => {
      if (gen.current !== my) return false;
      pending.current = false;
      setRequesting(false);
      return true;
    };
    req.then(
      (win) => {
        if (settle()) attach(win);
        else closeQuietly(win);
      },
      () => {
        // 断られた（ユーザーの操作の外・別の小窓が開いているなど）。帯はそのまま
        settle();
      },
    );
  };

  const close = useCallback(() => {
    const c = cur.current;
    if (c === null) return;
    finish(c.win);
    closeQuietly(c.win);
  }, [finish]);

  useEffect(
    () => () => {
      // 帯が消えた（または effect の後始末）。要求中の要求を無効にし、開いている小窓を閉じる
      gen.current += 1;
      if (pending.current) {
        pending.current = false;
        setRequesting(false);
      }
      close();
    },
    [close],
  );

  return { win: state?.win ?? null, ready: state?.ready === true, requesting, open, close };
}

/** 古さ: ok / 最後に更新に成功してから PIP_STALE_MS 以上（old）/ 直近の更新に失敗（error） */
export function pipFreshness(okAt: number, now: number, stale: boolean): "ok" | "old" | "error" {
  if (stale) return "error";
  return now - okAt >= PIP_STALE_MS ? "old" : "ok";
}

/** 小窓のイベントを、React の木を伝って一覧側の親に届かせない（Rovo 自身の onClick は先に動く） */
const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * 小窓の中身（断面図と古さの表示）。小窓の body に portal で描く。
 * Rovo を押したら、クリックの処理の中で同期的に元の window を前に出し（focus の成否によらず）、そのタスクを選ぶ。
 */
export function PipScene(props: {
  win: Window;
  data: OverviewDto;
  stale: boolean;
  /** 最後に一覧の更新に成功した時刻（取得元 use-overview が持つ。小窓を開いた時刻ではない） */
  okAt: number;
  onSelect?: (id: string) => void;
}) {
  const { win, data, stale, okAt, onSelect } = props;
  const t = useFactoryT();
  const { t: tMain } = useLang();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = win.setInterval(() => setTick((n) => n + 1), PIP_TICK_MS);
    return () => win.clearInterval(id);
  }, [win]);
  const select = (id: string) => {
    try {
      window.focus();
    } catch {
      // 前に出せなくても選ぶ
    }
    if (onSelect) onSelect(id);
    else window.location.assign(taskPath(id));
  };
  const fresh = pipFreshness(okAt, Date.now(), stale);
  const time = formatClock(okAt, tMain);
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: イベントを一覧側に伝えないための包み（操作は中の Rovo のリンク）
    <div
      className="fxpip-root"
      onClick={stop}
      onKeyDown={stop}
      onMouseDown={stop}
      onPointerDown={stop}
    >
      {fresh === "ok" ? null : (
        <p
          className="fxpip-status"
          data-pip-stale={fresh}
          role="status"
          title={t("factory.pipStaleTitle")}
        >
          {fresh === "old" ? t("factory.pipOld", { time }) : t("factory.pipError", { time })}
        </p>
      )}
      <FactoryScene data={data} onSelect={select} />
    </div>,
    win.document.body,
  );
}
