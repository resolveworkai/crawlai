/** Authored by: Mohit Singh */
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { AppRole } from "../types/db.js";

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  roles: AppRole[];
  type: "access";
}

export interface RefreshTokenPayload {
  sub: string;
  type: "refresh";
}

export function signAccessToken(user: { id: string; email: string; roles: AppRole[] }): string {
  const payload: AccessTokenPayload = {
    sub: user.id,
    email: user.email,
    roles: user.roles,
    type: "access",
  };
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_ACCESS_TTL } as jwt.SignOptions);
}

export function signRefreshToken(userId: string): string {
  const payload: RefreshTokenPayload = { sub: userId, type: "refresh" };
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_REFRESH_TTL } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, config.JWT_SECRET);
  if (typeof decoded === "string" || decoded.type !== "access") {
    throw new Error("Not an access token");
  }
  return decoded as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, config.JWT_SECRET);
  if (typeof decoded === "string" || decoded.type !== "refresh") {
    throw new Error("Not a refresh token");
  }
  return decoded as RefreshTokenPayload;
}
