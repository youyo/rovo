import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatClockSeconds,
  formatCount,
  formatDateTime,
  formatDayHeading,
  formatDuration,
  formatDurationShort,
  formatUsd,
  isAllowedPrUrl,
  modelFamily,
  sanitizeText,
  shortModel,
  singleLine,
} from "../src/format";
import { tEn, tJa } from "./lang";

describe("sanitizeText（D14: 表示前に制御文字を除く）", () => {
  it("改行・タブ以外の C0・DEL・C1 を除く", () => {
    expect(sanitizeText("a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg")).toBe("abcdefg");
  });

  it("改行とタブは残す", () => {
    expect(sanitizeText("a\nb\tc\r\nd")).toBe("a\nb\tc\r\nd");
  });

  it("双方向の制御文字（U+202A-202E・U+2066-2069）を除く", () => {
    const [rlo, pdf, lri, pdi] = [0x202e, 0x202c, 0x2066, 0x2069].map((c) =>
      String.fromCharCode(c),
    );
    expect(sanitizeText(`gpj${rlo}txt.exe${pdf}${lri}x${pdi}`)).toBe("gpjtxt.exex");
    for (let c = 0x202a; c <= 0x202e; c++) expect(sanitizeText(String.fromCharCode(c))).toBe("");
    for (let c = 0x2066; c <= 0x2069; c++) expect(sanitizeText(String.fromCharCode(c))).toBe("");
  });

  it("通常の文字（日本語・絵文字・記号）は変えない", () => {
    expect(sanitizeText("ログイン画面の文言を直す 🎉 <b>&</b>")).toBe(
      "ログイン画面の文言を直す 🎉 <b>&</b>",
    );
  });

  it("singleLine は改行・タブを空白 1 つにする", () => {
    expect(singleLine(`a\n\nb\tc${String.fromCharCode(0x202e)}`)).toBe("a b c");
  });
});

describe("isAllowedPrUrl（D14: GitHub の PR の URL だけをリンクにする）", () => {
  it("許可する形", () => {
    expect(isAllowedPrUrl("https://github.com/example-org/web-app/pull/101")).toBe(true);
    expect(isAllowedPrUrl("https://github.com/a/b.c_d-e/pull/1")).toBe(true);
  });

  it("javascript:・data:・http:・別ホスト・末尾の付加・userinfo・クエリは拒否", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://github.com/a/b/pull/1",
      "https://github.com.evil.com/a/b/pull/1",
      "https://evil.com/github.com/a/b/pull/1",
      "https://github.com/a/b/pull/1?x=1",
      "https://github.com/a/b/pull/1#frag",
      "https://github.com/a/b/pull/1/files",
      "https://github.com/a/b/pull/x",
      "https://user@github.com/a/b/pull/1",
      "https://github.com/a/b/pull/1\n",
      " https://github.com/a/b/pull/1",
      "https://github.com/a/b/issues/1",
      "https://github.com/o/../pull/1",
      "https://github.com/o/./pull/1",
      "https://github.com/-o/r/pull/1",
      "https://github.com/../r/pull/1",
      "",
    ]) {
      expect(isAllowedPrUrl(bad), bad).toBe(false);
    }
    expect(isAllowedPrUrl(null)).toBe(false);
    expect(isAllowedPrUrl(1)).toBe(false);
  });
});

describe("表示用の整形", () => {
  it("formatUsd: 0 は $0、1 ドル以上は小数 2 桁、未満は 4 桁まで（末尾の 0 は落とすが 2 桁は残す）", () => {
    expect(formatUsd(0, tJa)).toBe("$0");
    expect(formatUsd(1.84, tJa)).toBe("$1.84");
    expect(formatUsd(11.4, tJa)).toBe("$11.40");
    expect(formatUsd(0.0043, tJa)).toBe("$0.0043");
    expect(formatUsd(0.62, tJa)).toBe("$0.62");
    expect(formatUsd(0.018, tJa)).toBe("$0.018");
    expect(formatUsd(0.00001, tJa)).toBe("<$0.0001"); // 0 ではない額を $0.00 と見せない
    expect(formatUsd(0.0001, tJa)).toBe("$0.0001");
  });

  it("formatClock: ローカル時刻の HH:MM（0 埋め）", () => {
    expect(formatClock(new Date(2026, 9, 21, 5, 7).getTime(), tJa)).toBe("05:07");
    expect(formatClock(new Date(2026, 9, 21, 15, 40).getTime(), tJa)).toBe("15:40");
  });

  it("formatDayHeading: ローカル日付の「M月D日」", () => {
    expect(formatDayHeading(new Date(2026, 9, 21, 0, 0).getTime(), tJa)).toBe("10月21日");
    expect(formatDayHeading(new Date(2026, 0, 5, 23, 59).getTime(), tJa)).toBe("1月5日");
  });
});

describe("shortModel（モデル名の表示。プロバイダなどの接頭辞は省く）", () => {
  it("最後の / より後ろを名前にし、全体は full に残す", () => {
    expect(shortModel("anthropic/claude-haiku-5-5")).toEqual({
      name: "claude-haiku-5-5",
      full: "anthropic/claude-haiku-5-5",
    });
    expect(shortModel("workers-ai/@cf/openai/gpt-oss-120b").name).toBe("gpt-oss-120b");
    expect(shortModel("example-model-large")).toEqual({
      name: "example-model-large",
      full: "example-model-large",
    });
  });

  it("制御文字を除く。末尾が / など空になるときは全体を名前にする", () => {
    expect(shortModel("a/b\u0007c").name).toBe("bc");
    expect(shortModel("abc/").name).toBe("abc/");
  });
});

describe("formatDuration（経過時間。日本語）", () => {
  it("1 秒未満・秒・分秒・時間分", () => {
    expect(formatDuration(0, tJa)).toBe("1 秒未満");
    expect(formatDuration(999, tJa)).toBe("1 秒未満");
    expect(formatDuration(42_000, tJa)).toBe("42 秒");
    expect(formatDuration(252_000, tJa)).toBe("4 分 12 秒");
    expect(formatDuration(60_000, tJa)).toBe("1 分 0 秒");
    expect(formatDuration(3_600_000, tJa)).toBe("1 時間 0 分");
    expect(formatDuration(3_600_000 * 2 + 5 * 60_000 + 59_000, tJa)).toBe("2 時間 5 分");
  });
  it("負・NaN は 0 として扱う", () => {
    expect(formatDuration(-5, tJa)).toBe("1 秒未満");
    expect(formatDuration(Number.NaN, tJa)).toBe("1 秒未満");
  });
});

describe("formatClockSeconds / formatCount", () => {
  it("ローカル時刻の HH:MM:SS", () => {
    const d = new Date(2026, 9, 21, 4, 5, 6).getTime();
    expect(formatClockSeconds(d, tJa)).toBe("04:05:06");
  });
  it("桁区切り", () => {
    expect(formatCount(0, tJa)).toBe("0");
    expect(formatCount(9412, tJa)).toBe("9,412");
    expect(formatCount(1234567, tJa)).toBe("1,234,567");
  });
});

describe("modelFamily（レールなど狭い場所のモデル名。sonnet / haiku / opus はその名前に縮める）", () => {
  it("sonnet / haiku / opus を含む名前はその系統名（大文字小文字を問わず）", () => {
    expect(modelFamily("claude-sonnet-5-5")).toBe("sonnet");
    expect(modelFamily("anthropic/claude-haiku-5-5")).toBe("haiku");
    expect(modelFamily("claude-OPUS-5")).toBe("opus");
  });

  it("系統が分からないモデルは shortModel の名前のまま（接頭辞は省く）", () => {
    expect(modelFamily("example-model-large")).toBe("example-model-large");
    expect(modelFamily("workers-ai/@cf/openai/gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  it("制御文字は除く（sanitize 済みの名前から決める）", () => {
    expect(modelFamily("claude-so\u0007nnet-5")).toBe("sonnet");
    expect(modelFamily("my\u0007-model")).toBe("my-model");
  });
});

describe("formatDateTime", () => {
  const ms = Date.UTC(2026, 9, 25, 1, 4, 12);
  it("ja: 年月日 時:分:秒 とタイムゾーンの略称", () => {
    expect(formatDateTime(ms, tJa, "Asia/Tokyo")).toBe("2026/10/25 10:04:12 JST");
  });
  it("en: 年月日・秒・タイムゾーンの略称つき", () => {
    expect(formatDateTime(ms, tEn, "UTC")).toMatch(/10\/25\/2026.*01:04:12.*UTC/);
  });
});

describe("formatDurationShort（狭い幅のレール）", () => {
  it("1 分未満は N s、1 時間未満は M:SS、1 時間以上は H:MM:SS", () => {
    expect(formatDurationShort(58_000)).toBe("58s");
    expect(formatDurationShort(592_000)).toBe("9:52");
    expect(formatDurationShort(60_000)).toBe("1:00");
    expect(formatDurationShort(3_723_000)).toBe("1:02:03");
    expect(formatDurationShort(0)).toBe("0s");
    expect(formatDurationShort(-5)).toBe("0s");
    expect(formatDurationShort(Number.NaN)).toBe("0s");
  });
});
