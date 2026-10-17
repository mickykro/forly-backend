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

// Step-up: for the few admin actions that hand out live control (the dev
// browser viewer), a 30-day session is not enough — the admin must have
// completed an OTP login in the last 10 hours. That login sets a
// "stepup"-scoped token (auth.js verifyHandler) in the forly_stepup cookie;
// scripts may send it as x-stepup-token instead. Mount AFTER requireAdmin: it
// must belong to the same person as the admin session (req.user).
function readStepUpToken(req) {
  const header = req.headers["x-stepup-token"];
  if (header) return String(header);
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)forly_stepup=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function makeStepUpGuard({ verifySession, authSecret }) {
  function requireStepUp(req, res, next) {
    const stepup = verifySession(authSecret, readStepUpToken(req), ["stepup"]);
    const userId = req.user && req.user.userId;
    if (!stepup || !userId || stepup.userId !== userId) return res.status(401).json({ error: "stepup_required" });
    next();
  }
  return { requireStepUp };
}

// View-as: an admin sees an agent's dashboard exactly as the agent does. The
// admin panel sets the forly_viewas=<phone> cookie; every requireAuth route
// then runs as that agent. It is not a credential (the admin session is
// re-checked on every request), and it is read-only: writes are refused so
// the admin can never act in the agent's name by accident.
function readViewAs(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)forly_viewas=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Wraps auth.requireAuth(secret, scopes) with the same signature.
function makeViewAs({ isAdmin }) {
  return (requireAuth) => (secret, scopes) => {
    const inner = requireAuth(secret, scopes);
    return (req, res, next) => inner(req, res, () => {
      const target = normalizeAuthPhone(readViewAs(req) || "");
      if (!target || (req.user.scope || "session") !== "session" || !isAdmin(req.user)) return next();
      if (req.method !== "GET" && req.method !== "HEAD") return res.status(403).json({ error: "view_as_readonly" });
      req.user = { ...req.user, userId: target, viewAsBy: req.user.userId };
      next();
    });
  };
}

module.exports = { makeAdminGuard, makeStepUpGuard, makeViewAs };
