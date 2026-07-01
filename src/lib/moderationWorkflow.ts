import type { ModerationTargetType } from "@prisma/client";

export type ResolutionDecision = "DISMISS" | "HIDE_CONTENT" | "SUSPEND_USER";

export function buildReportDedupeKey(
  reporterId: string,
  targetType: ModerationTargetType,
  targetId: string
) {
  return `${reporterId}:${targetType}:${targetId}`;
}

export function isResolutionAllowed(
  targetType: ModerationTargetType,
  decision: ResolutionDecision
) {
  if (decision === "DISMISS") return true;
  if (decision === "SUSPEND_USER") return targetType === "USER";
  return targetType === "DISHLIST" || targetType === "RECIPE";
}

export function getReportSlaState(
  createdAt: Date,
  now = new Date()
): "ON_TIME" | "WARNING" | "OVERDUE" {
  const ageHours = (now.getTime() - createdAt.getTime()) / 3_600_000;
  if (ageHours >= 24) return "OVERDUE";
  if (ageHours >= 18) return "WARNING";
  return "ON_TIME";
}
