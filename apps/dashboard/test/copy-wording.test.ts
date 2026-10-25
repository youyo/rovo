import { describe, expect, it } from "vitest";
import { DICTS } from "../src/i18n";

describe("文言", () => {
  it("ja", () => {
    const m = DICTS.ja as Record<string, string>;
    expect(m["rail.tabDay"]).toBe("日付別");
    expect(m["rail.tabWaitingN"]).toBe("要対応 {n}");
    expect(m["header.running"]).toBe("実行中 {n}");
    expect(m["header.merged"]).toBe("マージ済み {n}");
    expect(m["fact.created"]).toBe("作成日時");
  });
  it("en", () => {
    const m = DICTS.en as Record<string, string>;
    expect(m["rail.tabDay"]).toBe("By day");
    expect(m["rail.tabWaitingN"]).toBe("Needs you {n}");
    expect(m["fact.created"]).toBe("Created at");
  });
});
