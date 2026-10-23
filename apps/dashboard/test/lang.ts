import { createElement, type ReactElement } from "react";
import { makeT } from "../src/i18n";
import { LangProvider } from "../src/lang";

/** テスト用: 日本語・英語の t と、その言語で描くための包み。既存のテストは日本語の文言で探すので inJa で描く。 */
export const tJa = makeT("ja");
export const tEn = makeT("en");
export const inJa = (el: ReactElement): ReactElement =>
  createElement(LangProvider, { initial: "ja" }, el);
export const inEn = (el: ReactElement): ReactElement =>
  createElement(LangProvider, { initial: "en" }, el);
