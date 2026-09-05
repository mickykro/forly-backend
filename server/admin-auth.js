/*
 * admin-auth.js — shared operator-admin gate.
 *
 * A logged-in agent is an admin only if their session phone is on the
 * ADMIN_PHONES allowlist. Both the admin panel (routes/admin.js) and the
 * operator-driven demo flow (routes/intake.js) gate on this — the demo mints a
 * session for a client-supplied phone, so only a trusted admin may reach it.
 */

const { normalizeAuthPhone } = require("./utils");

// Build an admin guard from an allowlist + the session verifier.
//   const { isAdmin, requireAdmin } = makeAdminGuard({ verifySession, readToken, authSecret, adminPhones });
function makeAdminGuard({ verifySession, readToken, authSecret, adminPhones }) {
  // Normalize once so "050-…", "+972…" and "972…" all match the session's
  // canonical phone form. An empty allowlist denies everyone.
  const allow = new Set(
    (adminPhones || []).map((p) => normalizeAuthPhone(p)).filter(Boolean)
  );

  const isAdmin = (session) =>
    !!session && allow.has(normalizeAuthPhone(session.userId) || "");

  function requireAdmin(req, res, next) {
    const session = verifySession(authSecret, readToken(req));
    if (!session) return res.status(401).json({ error: "unauthenticated" });
    if (!isAdmin(session)) return res.status(403).json({ error: "not_admin" });
    req.user = session;
    next();
  }

  return { allow, isAdmin, requireAdmin };
}

module.exports = { makeAdminGuard };
