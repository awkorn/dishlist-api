import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

// Supabase JWKS endpoint — public keys for verifying asymmetric JWTs
const client = jwksClient({
  jwksUri: `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,             
  cacheMaxAge: 600000,      // Cache for 10 minutes (matches Supabase edge cache)
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

if (!process.env.SUPABASE_URL) {
  throw new Error("Missing SUPABASE_URL environment variable");
}

// Callback for jsonwebtoken — fetches the correct public key by kid
function getKey(
  header: jwt.JwtHeader,
  callback: (err: Error | null, key?: string) => void
) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      return callback(err);
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

interface SupabaseJwtPayload extends jwt.JwtPayload {
  sub: string;
  email?: string;
  role?: string;
}

export interface AuthRequest extends Request {
  user?: {
    uid: string;
    email?: string;
  };
}

export const authToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = await new Promise<SupabaseJwtPayload>((resolve, reject) => {
      jwt.verify(token, getKey, { algorithms: ["ES256"] }, (err, payload) => {
        if (err) reject(err);
        else resolve(payload as SupabaseJwtPayload);
      });
    });

    req.user = {
      uid: decoded.sub,
      email: decoded.email,
    };

    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

export const optionalAuthToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return next();
    }

    const decoded = await new Promise<SupabaseJwtPayload>((resolve, reject) => {
      jwt.verify(token, getKey, { algorithms: ["ES256"] }, (err, payload) => {
        if (err) reject(err);
        else resolve(payload as SupabaseJwtPayload);
      });
    });

    req.user = {
      uid: decoded.sub,
      email: decoded.email,
    };

    next();
  } catch (error) {
    next();
  }
};