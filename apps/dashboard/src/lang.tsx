import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { DEFAULT_LANG, type Lang, type T, tFor } from "./i18n";
import { loadLang, saveLang } from "./prefs";

/**
 * 現在の言語を配る Context。Provider が無い場所（部品の単体の表示）では英語（既定）。
 * 言語を変えると localStorage に保存し、`<html lang>` と `<title>` を切り替える。
 */
type LangContext = { lang: Lang; t: T; setLang: (lang: Lang) => void };

const Ctx = createContext<LangContext>({
  lang: DEFAULT_LANG,
  t: tFor(DEFAULT_LANG),
  setLang: () => {},
});

export function LangProvider(
  props: PropsWithChildren<{
    /** 最初の言語。無ければ保存された言語（無ければ英語）。テスト用 */
    initial?: Lang;
  }>,
) {
  const [lang, setLangState] = useState<Lang>(() => props.initial ?? loadLang());
  const t = tFor(lang);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    saveLang(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t("app.title");
  }, [lang, t]);
  const value = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

/** 現在の言語と t と切り替え。 */
export function useLang(): LangContext {
  return useContext(Ctx);
}

/** t だけ欲しいとき。 */
export function useT(): T {
  return useContext(Ctx).t;
}
