import { Router, type Response } from "express";
import { z } from "zod";
import type { AuthService, LoginResult } from "../../application/auth.js";
import { permissionsOf, type Principal } from "../../domain/auth.js";
import { DomainError } from "../../domain/errors.js";
import { cookieName, requireCsrf, sessionTokenOf, type CookieConfig } from "../middleware/auth.js";

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

/** What the browser may know about the user. The server still enforces every permission itself. */
export const publicUser = (p: Principal) => ({ username: p.username, staffId: p.staffId, name: p.name, role: p.role, storeCodes: p.storeCodes, permissions: permissionsOf(p.role) });

export function authRoutes(auth: AuthService, cfg: CookieConfig): Router {
  const r = Router();

  const setCookie = (res: Response, login: LoginResult) =>
    res.cookie(cookieName(cfg.secure), login.sessionToken, { httpOnly: true, secure: cfg.secure, sameSite: "strict", path: "/", maxAge: cfg.maxAgeMs });

  // POST /auth/login {username, password} -> sets the session cookie; the response carries the CSRF token for later writes.
  r.post("/login", async (req, res) => {
    const { username, password } = LoginBody.parse(req.body);
    const login = await auth.login(username, password);
    setCookie(res, login);
    res.json({ user: publicUser(login.principal), csrfToken: login.csrfToken });
  });

  // GET /auth/me -> who the cookie belongs to (the SPA calls this on load); 401 when signed out or expired.
  r.get("/me", (req, res) => {
    if (!req.principal || !req.csrfToken) throw new DomainError("UNAUTHENTICATED", "Please sign in.");
    res.json({ user: publicUser(req.principal), csrfToken: req.csrfToken });
  });

  // POST /auth/logout -> ends the session on the server and clears the cookie.
  r.post("/logout", (req, res, next) => {
    const clear = () => {
      res.clearCookie(cookieName(cfg.secure), { httpOnly: true, secure: cfg.secure, sameSite: "strict", path: "/" });
      res.status(204).end();
    };
    if (!req.principal) return clear(); // already signed out
    requireCsrf(req, res, (err?: unknown) => {
      if (err) return next(err);
      auth.logout(sessionTokenOf(req, cfg));
      clear();
    });
  });

  return r;
}
