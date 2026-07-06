// Pure helpers for the notifications + push-token routes. Kept free of
// Prisma/Express so they can be unit-tested (see __tests__/notificationHelpers.test.ts).

export const NOTIFICATIONS_PAGE_SIZE = 50;

// Expo push tokens look like ExponentPushToken[xxxx] (classic) or
// ExpoPushToken[xxxx]. Anything else is junk we refuse to store.
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[.+\]$/;
export const MAX_PUSH_TOKEN_LENGTH = 200;

// Devices per account. Registration keeps the newest and evicts the oldest
// beyond this, so a hostile client can't grow the table unbounded.
export const MAX_PUSH_TOKENS_PER_USER = 20;

/**
 * Validate a client-supplied Expo push token. Returns the token if it is
 * plausibly real, otherwise null.
 */
export function validateExpoPushToken(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PUSH_TOKEN_LENGTH) {
    return null;
  }
  if (!EXPO_PUSH_TOKEN_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse `?cursor=&limit=` for the notifications list. Invalid/absent values
 * fall back to defaults; limit is clamped to the page-size ceiling.
 */
export function parseNotificationsListQuery(query: {
  cursor?: unknown;
  limit?: unknown;
}): { cursor: string | null; limit: number } {
  const cursor =
    typeof query.cursor === "string" && query.cursor.trim().length > 0
      ? query.cursor.trim()
      : null;

  let limit = NOTIFICATIONS_PAGE_SIZE;
  if (typeof query.limit === "string") {
    const parsed = Number.parseInt(query.limit, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      limit = Math.min(parsed, NOTIFICATIONS_PAGE_SIZE);
    }
  }

  return { cursor, limit };
}

/**
 * Safely parse a DISHLIST_INVITATION notification's data payload.
 * Returns null when the JSON is malformed or dishListId is missing —
 * callers should respond 400 rather than let JSON.parse throw into a 500.
 */
export function parseInvitationData(
  data: string | null
): { dishListId: string } | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as { dishListId?: unknown };
    if (typeof parsed?.dishListId === "string" && parsed.dishListId.length > 0) {
      return { dishListId: parsed.dishListId };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Split an array into fixed-size chunks. Expo's push API rejects requests
 * with more than 100 messages, so sends must be batched.
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
