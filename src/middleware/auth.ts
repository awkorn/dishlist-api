import { Request, Response, NextFunction } from "express";
import admin from "firebase-admin";

export interface AuthRequest extends Request {
  user?: admin.auth.DecodedIdToken;
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

    // Development bypass
    if (process.env.NODE_ENV === "development" && token === "dev-mock-token") {
      console.log("🔧 DEV MODE: Using mock authentication");
      req.user = {
        uid: "dev-user-123",
        email: "dev@dishlist.com",
        email_verified: true,
      } as any;
      return next();
    }

    // Normal Firebase token verification
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};
