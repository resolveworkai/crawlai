/** Authored by: Mohit Singh */
import { verifyPassword } from "../auth/password.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../auth/jwt.js";
import { findUserByEmail, findUserById } from "../db/users.js";
import { listRolesForUser } from "../db/userRoles.js";
import { UnauthorizedError } from "../errors.js";
import type { AppRole } from "../types/db.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string | null;
  roles: AppRole[];
}

export async function login(
  email: string,
  password: string,
): Promise<{ user: AuthenticatedUser; accessToken: string; refreshToken: string }> {
  const user = await findUserByEmail(email);
  if (!user) throw new UnauthorizedError("Invalid email or password");

  const passwordValid = await verifyPassword(password, user.password_hash);
  if (!passwordValid) throw new UnauthorizedError("Invalid email or password");

  const roles = await listRolesForUser(user.id);
  const accessToken = signAccessToken({ id: user.id, email: user.email, roles });
  const refreshToken = signRefreshToken(user.id);

  return {
    user: { id: user.id, email: user.email, fullName: user.full_name, roles },
    accessToken,
    refreshToken,
  };
}

export async function getAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
  const user = await findUserById(userId);
  if (!user) throw new UnauthorizedError("User no longer exists");
  const roles = await listRolesForUser(user.id);
  return { id: user.id, email: user.email, fullName: user.full_name, roles };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  let userId: string;
  try {
    userId = verifyRefreshToken(refreshToken).sub;
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }
  const user = await findUserById(userId);
  if (!user) throw new UnauthorizedError("User no longer exists");
  const roles = await listRolesForUser(user.id);
  return signAccessToken({ id: user.id, email: user.email, roles });
}
