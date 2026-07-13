/** Authored by: Mohit Singh */
import { Router } from "express";
import { ACCESS_COOKIE, clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "../auth/cookies.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { loginSchema } from "../schemas/auth.js";
import { getAuthenticatedUser, login, refreshAccessToken } from "../services/authService.js";
import { UnauthorizedError } from "../errors.js";

export const authRouter = Router();

authRouter.post("/auth/login", validate(loginSchema), async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  const { user, accessToken, refreshToken } = await login(email, password);
  setAuthCookies(res, accessToken, refreshToken);
  res.json({ user });
});

authRouter.post("/auth/logout", (_req, res) => {
  clearAuthCookies(res);
  res.status(204).send();
});

authRouter.get("/auth/me", requireAuth, async (req, res) => {
  const user = await getAuthenticatedUser(req.user!.id);
  res.json({ user });
});

authRouter.post("/auth/refresh", async (req, res) => {
  const token: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof token !== "string" || token.length === 0) {
    throw new UnauthorizedError("No refresh token");
  }
  const accessToken = await refreshAccessToken(token);
  res.cookie(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60 * 1000,
  });
  res.status(204).send();
});
