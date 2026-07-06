import { describe, expect, it } from "vitest";
import {
  NOTIFICATIONS_PAGE_SIZE,
  MAX_PUSH_TOKEN_LENGTH,
  chunkArray,
  parseInvitationData,
  parseNotificationsListQuery,
  validateExpoPushToken,
} from "../notificationHelpers";

describe("validateExpoPushToken", () => {
  it("accepts a classic Expo token", () => {
    expect(validateExpoPushToken("ExponentPushToken[abc123XYZ]")).toBe(
      "ExponentPushToken[abc123XYZ]"
    );
  });

  it("accepts the newer ExpoPushToken form", () => {
    expect(validateExpoPushToken("ExpoPushToken[abc123XYZ]")).toBe(
      "ExpoPushToken[abc123XYZ]"
    );
  });

  it("trims surrounding whitespace", () => {
    expect(validateExpoPushToken("  ExponentPushToken[abc]  ")).toBe(
      "ExponentPushToken[abc]"
    );
  });

  it("rejects non-strings", () => {
    expect(validateExpoPushToken(undefined)).toBeNull();
    expect(validateExpoPushToken(null)).toBeNull();
    expect(validateExpoPushToken(42)).toBeNull();
    expect(validateExpoPushToken({ token: "x" })).toBeNull();
  });

  it("rejects empty and non-token strings", () => {
    expect(validateExpoPushToken("")).toBeNull();
    expect(validateExpoPushToken("   ")).toBeNull();
    expect(validateExpoPushToken("not-a-token")).toBeNull();
    expect(validateExpoPushToken("ExponentPushToken[]")).toBeNull();
    expect(validateExpoPushToken("ExponentPushToken[abc")).toBeNull();
  });

  it("rejects oversized tokens", () => {
    const huge = `ExponentPushToken[${"a".repeat(MAX_PUSH_TOKEN_LENGTH)}]`;
    expect(validateExpoPushToken(huge)).toBeNull();
  });
});

describe("parseNotificationsListQuery", () => {
  it("defaults with no params", () => {
    expect(parseNotificationsListQuery({})).toEqual({
      cursor: null,
      limit: NOTIFICATIONS_PAGE_SIZE,
    });
  });

  it("passes through a cursor and clamps limit to the page size", () => {
    expect(
      parseNotificationsListQuery({ cursor: "cm123", limit: "500" })
    ).toEqual({ cursor: "cm123", limit: NOTIFICATIONS_PAGE_SIZE });
  });

  it("accepts a smaller limit", () => {
    expect(parseNotificationsListQuery({ limit: "10" }).limit).toBe(10);
  });

  it("ignores junk cursor and limit values", () => {
    expect(
      parseNotificationsListQuery({ cursor: "   ", limit: "-5" })
    ).toEqual({ cursor: null, limit: NOTIFICATIONS_PAGE_SIZE });
    expect(parseNotificationsListQuery({ limit: "abc" }).limit).toBe(
      NOTIFICATIONS_PAGE_SIZE
    );
    expect(parseNotificationsListQuery({ limit: "0" }).limit).toBe(
      NOTIFICATIONS_PAGE_SIZE
    );
  });
});

describe("parseInvitationData", () => {
  it("parses a valid invitation payload", () => {
    const data = JSON.stringify({ dishListId: "dl-1", dishListTitle: "Summer" });
    expect(parseInvitationData(data)).toEqual({ dishListId: "dl-1" });
  });

  it("returns null for null data", () => {
    expect(parseInvitationData(null)).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(parseInvitationData("{not json")).toBeNull();
  });

  it("returns null when dishListId is missing or wrong type", () => {
    expect(parseInvitationData(JSON.stringify({}))).toBeNull();
    expect(parseInvitationData(JSON.stringify({ dishListId: 42 }))).toBeNull();
    expect(parseInvitationData(JSON.stringify({ dishListId: "" }))).toBeNull();
    expect(parseInvitationData(JSON.stringify(null))).toBeNull();
  });
});

describe("chunkArray", () => {
  it("splits into fixed-size chunks with a remainder", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single chunk when under the size", () => {
    expect(chunkArray([1, 2], 100)).toEqual([[1, 2]]);
  });

  it("returns no chunks for an empty array", () => {
    expect(chunkArray([], 100)).toEqual([]);
  });

  it("throws on a non-positive size", () => {
    expect(() => chunkArray([1], 0)).toThrow();
  });
});
