import { Request, Response, NextFunction } from "express";
import { adminPrisma } from "../lib/prisma";
import { supabaseAdmin } from "../lib/supabase";
import type { UserRole } from "@prisma/client";

if (!process.env.SUPABASE_URL) {
  throw new Error("Missing SUPABASE_URL environment variable");
}

const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, "");
const expectedIssuer = `${supabaseUrl}/auth/v1`;

interface SupabaseJwtPayload {
  sub: string;
  iss?: string;
  aud?: string | string[];
  email?: string;
  role?: string;
}

function getBearerToken(req: Request) {
  const authorization = req.headers.authorization;
  if (!authorization) return null;

  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

async function verifyAuthToken(token: string) {
  // getClaims verifies asymmetric tokens against the project's cached JWKS and
  // safely falls back to the Auth server for legacy HS256 projects.
  const { data, error } = await supabaseAdmin.auth.getClaims(token);
  if (error || !data?.claims) {
    throw error || new Error("JWT claims are unavailable");
  }

  const decoded = data.claims as SupabaseJwtPayload;
  const hasExpectedAudience = Array.isArray(decoded.aud)
    ? decoded.aud.includes("authenticated")
    : decoded.aud === "authenticated";

  if (
    !decoded.sub ||
    decoded.iss !== expectedIssuer ||
    !hasExpectedAudience ||
    decoded.role !== "authenticated"
  ) {
    throw new Error("JWT does not represent an authenticated user");
  }

  return decoded;
}

function isAccountDeletionRetry(req: Request) {
  return (
    req.method === "DELETE" &&
    req.baseUrl === "/users" &&
    req.path === "/me"
  );
}

async function isAccountDeletionBlocked(userId: string, req: Request) {
  if (isAccountDeletionRetry(req)) return false;

  const deletion = await adminPrisma.accountDeletion.findUnique({
    where: { userId },
    select: { userId: true },
  });
  return !!deletion;
}

export interface AuthRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    role: UserRole;
  };
}

export const authToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = await verifyAuthToken(token);
    const [deletionBlocked, applicationUser] = await Promise.all([
      isAccountDeletionBlocked(decoded.sub, req),
      adminPrisma.user.findUnique({
        where: { uid: decoded.sub },
        select: { role: true, status: true },
      }),
    ]);
    if (deletionBlocked) {
      return res.status(410).json({ error: "Account deletion is in progress" });
    }
    if (applicationUser?.status === "SUSPENDED") {
      return res.status(403).json({
        error: "This account has been suspended",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    req.user = {
      uid: decoded.sub,
      email: decoded.email,
      role: applicationUser?.role ?? "USER",
    };

    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
};

export const optionalAuthToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return next();
    }

    const decoded = await verifyAuthToken(token);
    const [deletionBlocked, applicationUser] = await Promise.all([
      isAccountDeletionBlocked(decoded.sub, req),
      adminPrisma.user.findUnique({
        where: { uid: decoded.sub },
        select: { role: true, status: true },
      }),
    ]);
    if (deletionBlocked) {
      return next();
    }
    if (applicationUser?.status === "SUSPENDED") {
      return next();
    }

    req.user = {
      uid: decoded.sub,
      email: decoded.email,
      role: applicationUser?.role ?? "USER",
    };

    next();
  } catch {
    next();
  }
};

export function requireModerator(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (req.user?.role !== "MODERATOR" && req.user?.role !== "ADMIN") {
    return res.status(403).json({ error: "Moderator access required" });
  }
  next();
}

export function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (req.user?.role !== "ADMIN") {
    return res.status(403).json({ error: "Administrator access required" });
  }
  next();
}
