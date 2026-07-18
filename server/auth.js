/*
 * Forly auth — WhatsApp OTP login.
 *
 * Routes (mounted at /api/auth):
 *   POST /otp          { phone }         → sends a 6-digit code on WhatsApp
 *   POST /otp/verify   { phone, code }   → validates, returns a session token + cookie
 *   POST /verify       (alias of /otp/verify — some frontends call this)
 *   GET  /me                             → current session (from cookie or Bearer)
 *   POST /logout                         → clears the cookie
 *
 * Security: codes are stored HASHED (never plaintext), single-use, 5-min TTL,
 * max 5 attempts, 60s resend cooldown. Session is an HMAC-signed token (12h).
 * Only phones that already completed signup (businesses/{phone}) can log in.
 */

const crypto = require("crypto");
const express = require("express");

const OTP_TTL_MS = 5 * 60 * 1000;      // code valid 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;  // 1 resend per minute
const MAX_ATTEMPTS = 5;                // wrong-code attempts before lockout
const SESSION_TTL_S = 12 * 60 * 60;    // 12 hours

// ── phone ──
// The server's own normalizePhone() is Israel-only and returns null otherwise.
// Auth must also work for non-IL test numbers, so accept international digits.
function normalizeAny(raw) {
  let p = String(raw || "").replace(/\D/g, "");
  if (!p) return null;
  if (p.startsWith("00")) p = p.slice(2);
  if (/^05\d{8}$/.test(p)) return "972" + p.slice(1);   // 0501234567 → 972501234567
  if (/^5\d{8}$/.test(p)) return "972" + p;             // 501234567  → 972501234567
  if (p.length >= 9 && p.length <= 15) return p;        // already international
  return null;
}

// ── crypto ──
const hashCode = (secret, phone, code) =>
  crypto.createHmac("sha256", secret).update(`${phone}:${code}`).digest("base64url");

function signSession(secret, phone) {
  const payload = { userId: phone, scope: "session", exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(secret, token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  // constant-time compare
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// uid = one-way hash of the phone. Used in links so the number never leaks.
const uidFor = (secret, phone) =>
  crypto.createHmac("sha256", secret).update(`uid:${phone}`).digest("base64url");

function readToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)forly_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

module.exports = function createAuthRouter({ db, mem, sendWhatsApp, secret }) {
  const router = express.Router();
  if (!secret) throw new Error("auth: FORLY_JWT_SECRET is required");
  if (mem && !mem.otps) mem.otps = new Map();

  // storage: Firestore when available, in-memory otherwise
  const saveOtp = async (phone, rec) => {
    if (db) await db.collection("otps").doc(phone).set(rec);
    else mem.otps.set(phone, rec);
  };
  const getOtp = async (phone) => {
    if (db) { const d = await db.collection("otps").doc(phone).get(); return d.exists ? d.data() : null; }
    return mem.otps.get(phone) || null;
  };
  const patchOtp = async (phone, patch) => {
    if (db) await db.collection("otps").doc(phone).set(patch, { merge: true });
    else Object.assign(mem.otps.get(phone) || {}, patch);
  };
  const isRegistered = async (phone) => {
    if (!db) return true; // in-memory demo: don't block login
    const d = await db.collection("businesses").doc(phone).get();
    return d.exists;
  };

  // ── POST /api/auth/otp — send a code ──
  router.post("/otp", async (req, res) => {
    const phone = normalizeAny(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ ok: false, error: "invalid_phone" });

    try {
      if (!(await isRegistered(phone))) {
        return res.status(404).json({ ok: false, error: "not_registered" });
      }

      // resend cooldown
      const prev = await getOtp(phone);
      const prevAt = prev && prev.created_at ? new Date(prev.created_at.toDate ? prev.created_at.toDate() : prev.created_at).getTime() : 0;
      if (prevAt && Date.now() - prevAt < RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - prevAt)) / 1000);
        return res.status(429).json({ ok: false, error: "too_soon", retry_after: wait });
      }

      const code = String(crypto.randomInt(100000, 1000000)); // 6 digits, CSPRNG
      const now = new Date();
      await saveOtp(phone, {
        code_hash: hashCode(secret, phone, code),
        expires_at: new Date(now.getTime() + OTP_TTL_MS),
        created_at: now,
        attempts: 0,
        used: false,
      });

      // ponytail: no GreenAPI creds = local dev, WhatsApp send is a no-op —
      // print the code so login is testable. Never fires in prod (creds set).
      if (!process.env.GREENAPI_TOKEN) console.log(`[dev] OTP for ${phone}: ${code}`);
      await sendWhatsApp(
        phone,
        `קוד הכניסה שלך ל-Forly: ${code}\nהקוד תקף ל-5 דקות.\n\nYour Forly login code: ${code}\nValid for 5 minutes.`
      );

      return res.json({ ok: true, sent: true, expires_in: OTP_TTL_MS / 1000 });
    } catch (err) {
      console.error("auth/otp failed:", err);
      return res.status(500).json({ ok: false, error: "otp_send_failed" });
    }
  });

  // ── POST /api/auth/otp/verify — check the code, start a session ──
  async function verifyHandler(req, res) {
    const phone = normalizeAny(req.body && req.body.phone);
    const code = String((req.body && req.body.code) || "").replace(/\D/g, "");
    if (!phone || !code) return res.status(400).json({ ok: false, error: "missing_phone_or_code" });

    try {
      const rec = await getOtp(phone);
      if (!rec || !rec.code_hash) return res.status(400).json({ ok: false, error: "no_code_requested" });
      if (rec.used) return res.status(401).json({ ok: false, error: "code_already_used" });
      if ((rec.attempts || 0) >= MAX_ATTEMPTS) return res.status(429).json({ ok: false, error: "too_many_attempts" });

      const exp = rec.expires_at && rec.expires_at.toDate ? rec.expires_at.toDate() : new Date(rec.expires_at);
      if (Date.now() > exp.getTime()) return res.status(401).json({ ok: false, error: "code_expired" });

      const given = Buffer.from(hashCode(secret, phone, code));
      const stored = Buffer.from(String(rec.code_hash));
      const match = given.length === stored.length && crypto.timingSafeEqual(given, stored);

      if (!match) {
        await patchOtp(phone, { attempts: (rec.attempts || 0) + 1 });
        return res.status(401).json({ ok: false, error: "invalid_code" });
      }

      await patchOtp(phone, { used: true, used_at: new Date() });

      const token = signSession(secret, phone);
      res.cookie("forly_session", token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: SESSION_TTL_S * 1000,
      });
      return res.json({ ok: true, token, userId: phone, expires_in: SESSION_TTL_S });
    } catch (err) {
      console.error("auth/otp/verify failed:", err);
      return res.status(500).json({ ok: false, error: "otp_verify_failed" });
    }
  }

  router.post("/otp/verify", verifyHandler);
  router.post("/verify", verifyHandler); // alias, in case the frontend calls this

  // ── GET /api/auth/link?t=… — magic link from WhatsApp ──
  // Token payload is { uid, exp, nonce }: no phone number in the URL.
  // We resolve uid → phone via the uids/{uid} lookup doc written by n8n,
  // then start a session and drop the agent on the create-property page.
  router.get("/link", async (req, res) => {
    const token = String(req.query.t || "");
    const fail = (why) => res.redirect(`/?login_error=${encodeURIComponent(why)}`);

    if (!token.includes(".")) return fail("bad_link");
    const [body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    const a = Buffer.from(sig || "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail("bad_link");

    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return fail("bad_link");
    }
    if (!payload.uid || !payload.exp || payload.exp * 1000 < Date.now()) return fail("link_expired");

    // resolve uid → phone
    let phone = null;
    if (db) {
      const d = await db.collection("uids").doc(payload.uid).get();
      if (d.exists) phone = d.get("phone");
    } else if (mem && mem.uids) {
      phone = mem.uids.get(payload.uid) || null;
    }
    if (!phone) return fail("unknown_link");

    // sanity: the uid must actually hash back to this phone
    if (uidFor(secret, phone) !== payload.uid) return fail("bad_link");

    res.cookie("forly_session", signSession(secret, phone), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: SESSION_TTL_S * 1000,
    });
    return res.redirect("/create.html");
  });

  // ── GET /api/auth/me ──
  router.get("/me", async (req, res) => {
    const session = verifySession(secret, readToken(req));
    if (!session) return res.status(401).json({ ok: false, error: "not_authenticated" });

    let business = null;
    if (db) {
      const d = await db.collection("businesses").doc(session.userId).get();
      if (d.exists) {
        const b = d.data();
        business = {
          phone: session.userId,
          full_name: b.full_name || "",
          logo_url: b.logo_url || null,
          portrait_url: b.portrait_url || null,
        };
      }
    }
    return res.json({ ok: true, userId: session.userId, business });
  });

  // ── POST /api/auth/logout ──
  router.post("/logout", (req, res) => {
    res.clearCookie("forly_session");
    return res.json({ ok: true });
  });

  return router;
};

// Middleware for protecting other routes:
//   const { requireAuth } = require("./auth");
//   app.get("/api/private", requireAuth(SECRET), (req, res) => { req.user.userId ... });
module.exports.uidFor = uidFor;
module.exports.signSession = signSession;
module.exports.verifySession = verifySession;
module.exports.readToken = readToken;

// Canonical phone form used for businesses/{phone} doc ids and session userIds.
// Exported so callers (demo signup, listing ownership) key on the same string.
module.exports.normalizeAuthPhone = normalizeAny;

module.exports.requireAuth = (secret) => (req, res, next) => {
  const session = verifySession(secret, readToken(req));
  if (!session) return res.status(401).json({ error: "unauthenticated" });
  req.user = session;
  next();
};