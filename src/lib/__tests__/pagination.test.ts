import { describe, expect, it } from "vitest";
import { parsePageLimit } from "../pagination";

describe("parsePageLimit", () => {
  it("uses the requested positive integer", () => {
    expect(parsePageLimit("25")).toBe(25);
  });

  it("caps oversized pages", () => {
    expect(parsePageLimit("1000")).toBe(50);
  });

  it.each([undefined, "", "nope", "1.5", "0", "-2", ["20"]])(
    "uses the default for invalid input: %s",
    (value) => {
      expect(parsePageLimit(value)).toBe(20);
    }
  );
});
