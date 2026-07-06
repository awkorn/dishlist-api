// Pure helpers for the invite endpoints: the validate/accept guard chain,
// recipient-list normalization, and shared constants. Kept dependency-free and
// side-effect free so they can be unit tested directly (see
// __tests__/inviteValidation.test.ts). The route handlers in routes/invites.ts
// perform the DB work and translate a returned rejection into an HTTP response.

export const INVITE_EXPIRY_DAYS = 7;
export const MAX_COLLABORATORS = 100;
export const MAX_SEND_RECIPIENTS = 20;

// A structured rejection the route can hand straight to res.status().json().
export interface InviteRejection {
  status: number;
  code: string;
  error: string;
}

// The persisted invite fields relevant to eligibility, plus the joined
// account/moderation status needed for the "no longer available" check.
export interface InviteState {
  inviterStatus: string;
  ownerStatus: string;
  moderationState: string;
  expiresAt: Date;
  usedAt: Date | null;
  inviteeId: string | null;
  ownerId: string;
}

export interface AcceptContext {
  userId: string;
  isBlocked: boolean;
  now?: Date;
}

/**
 * Compute the expiry date for a freshly created/extended invite. Pure: takes
 * the "from" instant so it can be tested deterministically.
 */
export function getInviteExpiryDate(from: Date = new Date()): Date {
  const date = new Date(from);
  date.setDate(date.getDate() + INVITE_EXPIRY_DAYS);
  return date;
}

/**
 * Shared availability chain used by both validate and accept: the invite (and
 * the accounts/DishList behind it) must be live, unexpired, and unused. Returns
 * a rejection or null when usable.
 */
export function checkInviteUsable(
  state: InviteState,
  now: Date = new Date()
): InviteRejection | null {
  if (
    state.inviterStatus !== "ACTIVE" ||
    state.ownerStatus !== "ACTIVE" ||
    state.moderationState !== "VISIBLE"
  ) {
    return {
      status: 410,
      code: "UNAVAILABLE",
      error: "This invite is no longer available",
    };
  }

  if (state.expiresAt.getTime() < now.getTime()) {
    return { status: 410, code: "EXPIRED", error: "Invite has expired" };
  }

  if (state.usedAt) {
    return {
      status: 410,
      code: "ALREADY_USED",
      error: "Invite has already been used",
    };
  }

  return null;
}

/**
 * A direct (non-link) invite is addressed to a specific user. Link invites have
 * inviteeId === null and are accepted by anyone. Returns a rejection when a
 * direct invite is being used by the wrong account.
 */
export function checkInviteRecipient(
  inviteeId: string | null,
  userId: string | null | undefined
): InviteRejection | null {
  if (inviteeId && inviteeId !== userId) {
    return {
      status: 403,
      code: "WRONG_USER",
      error: "This invite is for another user",
    };
  }
  return null;
}

/**
 * Full accept-eligibility chain, in the same order the route enforces it:
 * usable → correct recipient → not the owner → not blocked. Does NOT include the
 * collaborator-count limit, which the route checks after the "already a
 * collaborator" short-circuit — use checkCollaboratorLimit for that.
 */
export function evaluateAcceptEligibility(
  state: InviteState,
  context: AcceptContext
): InviteRejection | null {
  const usable = checkInviteUsable(state, context.now);
  if (usable) return usable;

  const recipient = checkInviteRecipient(state.inviteeId, context.userId);
  if (recipient) return recipient;

  if (state.ownerId === context.userId) {
    return {
      status: 400,
      code: "IS_OWNER",
      error: "You cannot collaborate on your own DishList",
    };
  }

  if (context.isBlocked) {
    return {
      status: 403,
      code: "BLOCKED",
      error: "This invite is no longer available",
    };
  }

  return null;
}

/**
 * Reject once a DishList is at capacity. Kept separate so the route can run it
 * after the "already a collaborator" success path (existing members must not be
 * turned away by the limit).
 */
export function checkCollaboratorLimit(
  collaboratorCount: number
): InviteRejection | null {
  if (collaboratorCount >= MAX_COLLABORATORS) {
    return {
      status: 400,
      code: "LIMIT_REACHED",
      error: "This DishList has reached its collaborator limit",
    };
  }
  return null;
}

// Result of normalizing the raw recipientIds body: either a clean list or a
// 400-worthy message. Return-based (not thrown) to match the route's early
// returns.
export type RecipientIdsResult =
  | { ok: true; recipientIds: string[] }
  | { ok: false; error: string };

/**
 * Validate and normalize the recipientIds sent to POST /invites/dishlist/:id/send.
 * Rejects non-arrays, keeps only non-empty strings, trims, dedupes, drops the
 * caller's own id, and caps the batch at MAX_SEND_RECIPIENTS so a single request
 * can't fan out unbounded work before any DB writes happen.
 */
export function normalizeRecipientIds(
  raw: unknown,
  selfId: string
): RecipientIdsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "At least one recipient is required" };
  }

  const cleaned = Array.from(
    new Set(
      raw
        .filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0
        )
        .map((id) => id.trim())
    )
  ).filter((id) => id !== selfId);

  if (cleaned.length === 0) {
    return { ok: false, error: "At least one valid recipient is required" };
  }

  if (cleaned.length > MAX_SEND_RECIPIENTS) {
    return {
      ok: false,
      error: `You can invite at most ${MAX_SEND_RECIPIENTS} people at once`,
    };
  }

  return { ok: true, recipientIds: cleaned };
}
