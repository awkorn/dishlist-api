import rateLimit from "express-rate-limit";
import type { AuthRequest } from "./auth";

// Per-user limiters. Must run AFTER authToken so req.user is populated; fall
// back to IP for safety.
//
// NOTE: uses the default in-memory store, which is per-instance. Fine for a
// single API instance at launch; move to a shared store (e.g. Redis) if the
// API is ever horizontally scaled.
const keyByUser = (req: AuthRequest) => req.user?.uid ?? req.ip ?? "anonymous";

// Guards the paid AI generation endpoint. Default quotas — safe launch
// defaults. Confirm/tune these (see PRODUCTION_READINESS.md: builder →
// product decision).
export const aiGenerateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 10, // 10 generations/min/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

export const aiGenerateDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 1 day
  limit: 100, // 100 generations/day/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: {
    error: "Daily generation limit reached. Please try again tomorrow.",
  },
});

// Guards the invite-send endpoint against fan-out abuse. Default quotas — safe
// launch defaults. Confirm/tune these (see PRODUCTION_READINESS.md: invite →
// product decision).
export const inviteSendLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20, // 20 send-requests/min/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "Too many invites sent. Please wait a moment and try again." },
});

// Guards shareable-link generation. Combined with link reuse in the handler,
// this keeps a single user from minting rows in a loop.
export const inviteLinkLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20, // 20 link-requests/min/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: {
    error: "Too many invite links generated. Please wait a moment and try again.",
  },
});
