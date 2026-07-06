import { describe, expect, it } from "vitest";
import {
  getInviteExpiryDate,
  checkInviteUsable,
  checkInviteRecipient,
  evaluateAcceptEligibility,
  checkCollaboratorLimit,
  normalizeRecipientIds,
  INVITE_EXPIRY_DAYS,
  MAX_COLLABORATORS,
  MAX_SEND_RECIPIENTS,
  type InviteState,
} from "../inviteValidation";

const future = new Date(Date.now() + 60 * 60 * 1000);
const past = new Date(Date.now() - 60 * 60 * 1000);

// A usable, direct invite from an active inviter to an active owner's visible list.
const baseState = (overrides: Partial<InviteState> = {}): InviteState => ({
  inviterStatus: "ACTIVE",
  ownerStatus: "ACTIVE",
  moderationState: "VISIBLE",
  expiresAt: future,
  usedAt: null,
  inviteeId: "invitee-1",
  ownerId: "owner-1",
  ...overrides,
});

describe("getInviteExpiryDate", () => {
  it("adds INVITE_EXPIRY_DAYS to the given instant without mutating it", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const expiry = getInviteExpiryDate(from);
    expect(expiry.getTime()).toBeGreaterThan(from.getTime());
    const days = (expiry.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(INVITE_EXPIRY_DAYS);
    expect(from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("checkInviteUsable", () => {
  it("passes a live, unexpired, unused invite", () => {
    expect(checkInviteUsable(baseState())).toBeNull();
  });

  it("rejects when the inviter, owner, or list is not active/visible", () => {
    expect(checkInviteUsable(baseState({ inviterStatus: "SUSPENDED" }))?.code).toBe(
      "UNAVAILABLE"
    );
    expect(checkInviteUsable(baseState({ ownerStatus: "DELETED" }))?.code).toBe(
      "UNAVAILABLE"
    );
    expect(
      checkInviteUsable(baseState({ moderationState: "HIDDEN" }))?.code
    ).toBe("UNAVAILABLE");
  });

  it("rejects an expired invite", () => {
    const rejection = checkInviteUsable(baseState({ expiresAt: past }));
    expect(rejection?.status).toBe(410);
    expect(rejection?.code).toBe("EXPIRED");
  });

  it("rejects an already-used invite", () => {
    expect(checkInviteUsable(baseState({ usedAt: new Date() }))?.code).toBe(
      "ALREADY_USED"
    );
  });

  it("honors the supplied now for the expiry boundary", () => {
    const state = baseState({ expiresAt: new Date("2026-06-01T00:00:00Z") });
    expect(checkInviteUsable(state, new Date("2026-05-31T23:59:59Z"))).toBeNull();
    expect(
      checkInviteUsable(state, new Date("2026-06-01T00:00:01Z"))?.code
    ).toBe("EXPIRED");
  });
});

describe("checkInviteRecipient", () => {
  it("allows the addressed user", () => {
    expect(checkInviteRecipient("invitee-1", "invitee-1")).toBeNull();
  });

  it("rejects a different user on a direct invite", () => {
    const rejection = checkInviteRecipient("invitee-1", "someone-else");
    expect(rejection?.status).toBe(403);
    expect(rejection?.code).toBe("WRONG_USER");
  });

  it("allows anyone on a link invite (null inviteeId)", () => {
    expect(checkInviteRecipient(null, "anyone")).toBeNull();
    expect(checkInviteRecipient(null, undefined)).toBeNull();
  });
});

describe("evaluateAcceptEligibility", () => {
  const ctx = { userId: "invitee-1", isBlocked: false };

  it("passes an eligible acceptance", () => {
    expect(evaluateAcceptEligibility(baseState(), ctx)).toBeNull();
  });

  it("short-circuits on the usable chain first", () => {
    expect(
      evaluateAcceptEligibility(baseState({ usedAt: new Date() }), ctx)?.code
    ).toBe("ALREADY_USED");
  });

  it("rejects the wrong recipient", () => {
    expect(
      evaluateAcceptEligibility(baseState(), { userId: "other", isBlocked: false })
        ?.code
    ).toBe("WRONG_USER");
  });

  it("rejects the owner accepting their own invite", () => {
    const state = baseState({ inviteeId: null, ownerId: "owner-1" });
    expect(
      evaluateAcceptEligibility(state, { userId: "owner-1", isBlocked: false })
        ?.code
    ).toBe("IS_OWNER");
  });

  it("rejects a blocked relationship", () => {
    const state = baseState({ inviteeId: null });
    expect(
      evaluateAcceptEligibility(state, { userId: "invitee-1", isBlocked: true })
        ?.code
    ).toBe("BLOCKED");
  });

  it("does not enforce the collaborator limit (handled separately)", () => {
    // Even a link invite with a blocked-free eligible user passes here; the
    // limit is checked after the already-collaborator short-circuit.
    expect(
      evaluateAcceptEligibility(baseState({ inviteeId: null }), ctx)
    ).toBeNull();
  });
});

describe("checkCollaboratorLimit", () => {
  it("passes below capacity", () => {
    expect(checkCollaboratorLimit(MAX_COLLABORATORS - 1)).toBeNull();
  });

  it("rejects at or above capacity", () => {
    expect(checkCollaboratorLimit(MAX_COLLABORATORS)?.code).toBe("LIMIT_REACHED");
    expect(checkCollaboratorLimit(MAX_COLLABORATORS + 10)?.status).toBe(400);
  });
});

describe("normalizeRecipientIds", () => {
  it("keeps valid ids, trims, and preserves order", () => {
    const result = normalizeRecipientIds(["  a ", "b"], "self");
    expect(result).toEqual({ ok: true, recipientIds: ["a", "b"] });
  });

  it("rejects a non-array or empty array", () => {
    expect(normalizeRecipientIds(null, "self").ok).toBe(false);
    expect(normalizeRecipientIds("nope", "self").ok).toBe(false);
    expect(normalizeRecipientIds([], "self").ok).toBe(false);
  });

  it("dedupes and drops the caller's own id", () => {
    const result = normalizeRecipientIds(["a", "a", "self", "b"], "self");
    expect(result).toEqual({ ok: true, recipientIds: ["a", "b"] });
  });

  it("drops non-string and blank entries", () => {
    const result = normalizeRecipientIds(
      ["a", 42 as unknown as string, "", "   ", null as unknown as string, "b"],
      "self"
    );
    expect(result).toEqual({ ok: true, recipientIds: ["a", "b"] });
  });

  it("rejects when nothing valid remains after filtering", () => {
    const result = normalizeRecipientIds(["self", "   ", 1 as unknown as string], "self");
    expect(result).toEqual({
      ok: false,
      error: "At least one valid recipient is required",
    });
  });

  it("rejects a batch larger than MAX_SEND_RECIPIENTS", () => {
    const ids = Array.from({ length: MAX_SEND_RECIPIENTS + 1 }, (_, i) => `u${i}`);
    const result = normalizeRecipientIds(ids, "self");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(String(MAX_SEND_RECIPIENTS));
    }
  });

  it("accepts exactly MAX_SEND_RECIPIENTS", () => {
    const ids = Array.from({ length: MAX_SEND_RECIPIENTS }, (_, i) => `u${i}`);
    const result = normalizeRecipientIds(ids, "self");
    expect(result.ok).toBe(true);
  });
});
