import type { NextFunction, Response } from "express";
import { describe, expect, it } from "vitest";
import {
  AuthRequest,
  requireAdmin,
  requireModerator,
} from "../auth";

function authorize(
  role: "USER" | "MODERATOR" | "ADMIN",
  middleware: typeof requireModerator
) {
  const req = { user: { uid: "test-user", role } } as AuthRequest;
  let statusCode = 200;
  let nextCalled = false;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  const next = (() => {
    nextCalled = true;
  }) as NextFunction;

  middleware(req, res, next);
  return { statusCode, nextCalled };
}

describe("moderation authorization", () => {
  it("rejects ordinary users from moderator routes", () => {
    expect(authorize("USER", requireModerator)).toEqual({
      statusCode: 403,
      nextCalled: false,
    });
  });

  it("allows moderators and administrators into moderator routes", () => {
    expect(authorize("MODERATOR", requireModerator).nextCalled).toBe(true);
    expect(authorize("ADMIN", requireModerator).nextCalled).toBe(true);
  });

  it("reserves restoration routes for administrators", () => {
    expect(authorize("MODERATOR", requireAdmin).statusCode).toBe(403);
    expect(authorize("ADMIN", requireAdmin).nextCalled).toBe(true);
  });
});
