import { describe, expect, it } from "vitest";
import {
  buildReportDedupeKey,
  getReportSlaState,
  isResolutionAllowed,
} from "../moderationWorkflow";

describe("moderation workflow policy", () => {
  it("builds a stable per-reporter target key", () => {
    expect(buildReportDedupeKey("reporter", "USER", "target")).toBe(
      "reporter:USER:target"
    );
  });

  it("limits enforcement decisions to compatible target types", () => {
    expect(isResolutionAllowed("USER", "SUSPEND_USER")).toBe(true);
    expect(isResolutionAllowed("USER", "HIDE_CONTENT")).toBe(false);
    expect(isResolutionAllowed("RECIPE", "HIDE_CONTENT")).toBe(true);
    expect(isResolutionAllowed("DISHLIST", "SUSPEND_USER")).toBe(false);
    expect(isResolutionAllowed("USER", "DISMISS")).toBe(true);
  });

  it("flags reports at the 18 and 24 hour thresholds", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    expect(getReportSlaState(new Date("2026-06-29T19:00:01.000Z"), now)).toBe(
      "ON_TIME"
    );
    expect(getReportSlaState(new Date("2026-06-29T18:00:00.000Z"), now)).toBe(
      "WARNING"
    );
    expect(getReportSlaState(new Date("2026-06-29T12:00:00.000Z"), now)).toBe(
      "OVERDUE"
    );
  });
});
