/**
 * server/middleware/auth.mjs
 * Session cookie extraction + requireAuth middleware.
 */
import { getSession } from "../db/auth.mjs";

export const COOKIE_NAME = "mf_session";
const COOKIE_MAX_AGE = 30 * 24 * 3600; // 30 days in seconds

/** Parse a raw Cookie header into a Map<name, value> */
function parseCookies(header) {
  const map = new Map();
  if (!header) return map;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    map.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return map;
}

/** Attach session user to req.user (null if unauthenticated). */
export async function attachSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token   = cookies.get(COOKIE_NAME);
  if (token) {
    const session = await getSession(token).catch(() => null);
    req.user      = session ? { id: session.user_id, username: session.username, role: session.role } : null;
    req.sessionToken = token;
  } else {
    req.user = null;
  }
  next();
}

/** Middleware: reject unauthenticated requests with 401. */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

/** Serialize a Set-Cookie header value for the session token. */
export function makeSessionCookie(token, maxAge = COOKIE_MAX_AGE) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${maxAge}`;
}

/** Clear-cookie header value. */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
