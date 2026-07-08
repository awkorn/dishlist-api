import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { AuthRequest } from "./auth";

// Per-user limiters. Must run AFTER authToken so req.user is populated; fall
// back to IP for safety.
//
// The IP fallback runs through ipKeyGenerator so IPv6 addresses collapse to a
// subnet — otherwise a client could rotate within its /64 to dodge the limit,
// and express-rate-limit v8 rejects a raw req.ip keyGenerator for that reason.
//
// NOTE: uses the default in-memory store, which is per-instance. Fine for a
// single API instance at launch; move to a shared store (e.g. Redis) if the
// API is ever horizontally scaled.
const keyByUser = (req: AuthRequest) =>
  req.user?.uid ?? (req.ip ? ipKeyGenerator(req.ip) : "anonymous");

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

// Guards push-token registration. Combined with the per-user token cap in the
// handler, this keeps a scripted client from churning rows. Default quotas —
// safe launch defaults. Confirm/tune these (see PRODUCTION_READINESS.md:
// notifications → product decision).
export const pushTokenLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20, // 20 registrations/min/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "Too many requests. Please wait a moment and try again." },
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

// Guards the recipe photo-import endpoint — the most expensive call in the app
// (gpt-4o vision, high detail, up to 5 images). Dedicated buckets so import
// traffic doesn't share a counter with the builder. Default quotas — safe
// launch defaults. Confirm/tune these (see PRODUCTION_READINESS.md: recipe →
// product decision).
export const recipeImportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 5, // 5 imports/min/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

export const recipeImportDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 1 day
  limit: 25, // 25 imports/day/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: {
    error: "Daily import limit reached. Please try again tomorrow.",
  },
});

// Guards the nutrition-calculation endpoint (gpt-4o-mini). Dedicated buckets so
// nutrition traffic tunes independently of builder/import. Default quotas — safe
// launch defaults (see PRODUCTION_READINESS.md: recipe → product decision).
export const nutritionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 10, // 10 calculations/min/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

export const nutritionDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 1 day
  limit: 100, // 100 calculations/day/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: {
    error: "Daily nutrition limit reached. Please try again tomorrow.",
  },
});

// Guards recipe sharing against notification fan-out abuse. Mirrors the
// invite-send limiter (see PRODUCTION_READINESS.md: recipe → product decision).
export const recipeShareLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20, // 20 share-requests/min/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "Too many shares. Please wait a moment and try again." },
});

// Guards DishList sharing against the same notification fan-out abuse as
// recipe sharing. Kept as its own limiter so a DishList-share burst and a
// recipe-share burst don't drain each other's budget.
export const dishlistShareLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20, // 20 share-requests/min/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "Too many shares. Please wait a moment and try again." },
});

// Guards the search endpoint. Each call runs several DB queries (social graph +
// saved recipes + 1-3 scored searches with wide `take` windows), so it's a
// heavier read than most. The client already debounces at 300ms; this bounds
// scripted abuse. Generous default — safe launch value (see
// PRODUCTION_READINESS.md: search → product decision).
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 60, // 60 searches/min/user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: "Too many searches. Please wait a moment and try again." },
});
