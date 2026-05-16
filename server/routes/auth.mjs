/**
 * server/routes/auth.mjs
 * Routes: POST /api/auth/register  POST /api/auth/login
 *         POST /api/auth/logout    GET  /api/auth/me
 *         GET  /api/auth/users     DELETE /api/auth/users/:id  (admin only)
 */
import { Router } from "express";
import {
  countUsers, createUser, authenticateUser,
  createSession, deleteSession,
} from "../db/auth.mjs";
import { adapter } from "../db/migrations.mjs";
import {
  requireAuth, makeSessionCookie, clearSessionCookie,
} from "../middleware/auth.mjs";

const router = Router();

// ── POST /api/auth/register ───────────────────────────────────────────────────
// First user becomes admin automatically; subsequent registrations require
// ALLOW_REGISTRATION=true in .env or an existing admin session.
router.post("/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body ?? {};
    if (!username || !password)
      return res.status(400).json({ ok: false, error: "username and password required" });
    if (String(username).length < 2 || String(username).length > 64)
      return res.status(400).json({ ok: false, error: "username must be 2–64 chars" });
    if (String(password).length < 8)
      return res.status(400).json({ ok: false, error: "password must be at least 8 chars" });

    const total = await countUsers();
    const isFirstUser = total === 0;

    // After first user, require either admin session or ALLOW_REGISTRATION env flag
    if (!isFirstUser) {
      const allowOpen = String(process.env.ALLOW_REGISTRATION ?? "").trim().toLowerCase() === "true";
      const isAdmin   = req.user?.role === "admin";
      if (!allowOpen && !isAdmin)
        return res.status(403).json({ ok: false, error: "Registration is closed" });
    }

    const role = isFirstUser ? "admin" : "user";
    const user = await createUser(String(username), String(password), role);
    const token = await createSession(user.id);

    res.setHeader("Set-Cookie", makeSessionCookie(token));
    return res.status(201).json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    if (String(e?.message).includes("UNIQUE")) {
      return res.status(409).json({ ok: false, error: "Username already taken" });
    }
    console.error("[auth] register error:", e);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body ?? {};
    if (!username || !password)
      return res.status(400).json({ ok: false, error: "username and password required" });

    const user = await authenticateUser(String(username), String(password));
    if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const token = await createSession(user.id);
    res.setHeader("Set-Cookie", makeSessionCookie(token));
    return res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    console.error("[auth] login error:", e);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post("/auth/logout", requireAuth, async (req, res) => {
  try {
    await deleteSession(req.sessionToken);
    res.setHeader("Set-Cookie", clearSessionCookie());
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get("/auth/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ── GET /api/auth/users  (admin) ──────────────────────────────────────────────
router.get("/auth/users", requireAuth, async (req, res) => {
  if (req.user.role !== "admin")
    return res.status(403).json({ ok: false, error: "Admin only" });
  const rows = await adapter.all(
    "SELECT id, username, role, created_at, last_login FROM users ORDER BY id",
  );
  res.json({ ok: true, users: rows });
});

// ── DELETE /api/auth/users/:id  (admin) ──────────────────────────────────────
router.delete("/auth/users/:id", requireAuth, async (req, res) => {
  if (req.user.role !== "admin")
    return res.status(403).json({ ok: false, error: "Admin only" });
  const id = Number(req.params.id);
  if (id === req.user.id)
    return res.status(400).json({ ok: false, error: "Cannot delete yourself" });
  await adapter.run("DELETE FROM users WHERE id = ?", [id]);
  res.json({ ok: true });
});

export default router;
