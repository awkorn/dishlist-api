export function parsePageLimit(
  value: unknown,
  defaultLimit = 20,
  maxLimit = 50
) {
  if (typeof value !== "string" && typeof value !== "number") {
    return defaultLimit;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultLimit;
  }

  return Math.min(parsed, maxLimit);
}
