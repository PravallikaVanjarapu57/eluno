import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { AuthService } from "../../application/auth.js";
import { DomainError } from "../../domain/errors.js";
import { can, canAccessStore, type Permission, type Principal } from "../../domain/auth.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set only from a valid server-side session. Nothing in the request body, query or headers can set it. */
    principal?: Principal;
    csrfToken?: string;
  }
}

export interface CookieConfig {
  secure: boolean;
  maxAgeMs: number;
}

/** `__Host-` pins the cookie to this exact host and path, and requires Secure, so it is used whenever Secure is on. */
export const cookieName = (secure: boolean) => (secure ? "__Host-eluno_sid" : "eluno_sid");

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const sessionTokenOf = (req: Request, cfg: CookieConfig): string | undefined => parseCookies(req.headers.cookie)[cookieName(cfg.secure)];

/** Resolve the cookie to a principal. Never rejects by itself: routes opt in with requireAuth. */
export const loadSession =
  (auth: AuthService, cfg: CookieConfig): RequestHandler =>
  (req, _res, next) => {
    try {
      const token = sessionTokenOf(req, cfg);
      if (!token) return next();
      const info = auth.authenticate(token);
      if (info) {
        req.principal = info.principal;
        req.csrfToken = info.csrfToken;
      }
      next();
    } catch (e) {
      next(e);
    }
  };

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.principal) return next(new DomainError("UNAUTHENTICATED", "Please sign in."));
  next();
};

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cross-site request forgery. The cookie is SameSite=Strict; on top of that every state-changing request must
 * (1) come from this site when the browser says where it came from, and (2) echo the session's CSRF token in a header,
 * which another site cannot read. `needToken` is off only for sign-in, which has no session yet.
 */
export const refuseCrossSite: RequestHandler = (req, _res, next) => {
  if (SAFE.has(req.method)) return next();
  const origin = req.get("origin");
  if (origin) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* malformed */
    }
    if (host !== req.get("host")) return next(new DomainError("CSRF_INVALID", "This request came from another site and was refused."));
  }
  next();
};

export const requireCsrf: RequestHandler = (req, _res, next) => {
  if (SAFE.has(req.method)) return next();
  const sent = req.get("x-csrf-token") ?? "";
  const expected = req.csrfToken ?? "";
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) return next(new DomainError("CSRF_INVALID", "Your session could not be verified. Reload the page and try again."));
  next();
};

export const requirePermission =
  (permission: Permission, message: string): RequestHandler =>
  (req, _res, next) => {
    if (!req.principal) return next(new DomainError("UNAUTHENTICATED", "Please sign in."));
    if (!can(req.principal, permission)) return next(new DomainError("FORBIDDEN", message, { required: permission }));
    next();
  };

/** Throws unless the signed-in user is assigned to this store. */
export function assertStore(req: Request, storeCode: string): void {
  const p = req.principal;
  if (!p) throw new DomainError("UNAUTHENTICATED", "Please sign in.");
  if (!canAccessStore(p, storeCode)) throw new DomainError("STORE_FORBIDDEN", `You are not assigned to store ${storeCode}.`, { storeCode });
}

/** The signed-in user. Only call behind requireAuth. */
export function me(req: Request): Principal {
  if (!req.principal) throw new DomainError("UNAUTHENTICATED", "Please sign in.");
  return req.principal;
}
