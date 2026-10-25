import { describe, expect, it } from "vitest";
import { clampInt } from "../src/clamp";

describe("clampInt", () => {
  it("returns min when n is below min", () => {
    expect(clampInt(-5, 0, 10)).toBe(0);
    expect(clampInt(1, 2, 10)).toBe(2);
  });

  it("returns n when n is inside the range", () => {
    expect(clampInt(0, 0, 10)).toBe(0);
    expect(clampInt(5, 0, 10)).toBe(5);
    expect(clampInt(7, 2, 10)).toBe(7);
  });

  it("returns max when n is above max", () => {
    expect(clampInt(15, 0, 10)).toBe(10);
    expect(clampInt(11, 0, 10)).toBe(10);
  });

  it("returns max when n equals max", () => {
    expect(clampInt(10, 0, 10)).toBe(10);
  });
});
