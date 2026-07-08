import { describe, expect, it } from "vitest";
import { normalizeSearchParam } from "../requestValidation";

describe("normalizeSearchParam", () => {
  it("trims a string param", () => {
    expect(normalizeSearchParam("  alex  ", 100)).toBe("alex");
  });

  it("caps the param at maxLength", () => {
    expect(normalizeSearchParam("a".repeat(150), 100)).toBe("a".repeat(100));
  });

  it("collapses array-valued params to an empty string", () => {
    // Repeated query keys (?search=a&search=b) arrive as an array in Express.
    expect(normalizeSearchParam(["a", "b"], 100)).toBe("");
  });

  it("collapses undefined / non-string params to an empty string", () => {
    expect(normalizeSearchParam(undefined, 100)).toBe("");
    expect(normalizeSearchParam(42, 100)).toBe("");
    expect(normalizeSearchParam({ q: "x" }, 100)).toBe("");
  });

  it("returns an empty string for a whitespace-only param", () => {
    expect(normalizeSearchParam("   ", 100)).toBe("");
  });
});
