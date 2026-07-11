import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import * as crypto from "crypto";
import type {Request} from "firebase-functions/https";
import {
  db, normalizePhone, sendWhatsAppMessage,
  greenApiInstance, greenApiToken, nadlanJwtSecret,
} from "../shared";

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_GAP_MS = 60 * 1000;
const OTP_MAX_SENDS_PER_DAY = 5;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_S = 30 * 24 * 60 * 60; // 30 days
export const SESSION_COOKIE = "fly_session";

// ── compact HMAC session token: base64url({sub,exp}) + "." + hmac ──

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmac(data: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(data).digest());
}

export function signSession(phone: string, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify({
    sub: phone,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
  }), "utf8"));
  return `${payload}.${hmac(payload, secret)}`;
}

export function verifySession(token: string, secret: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    ) as {sub?: string; exp?: number};
    if (!parsed.sub || !parsed.exp || parsed.exp * 1000 < Date.now()) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}

/** One-tap action token (e.g. WhatsApp extend links). Self-invalidating:
 *  bind it to a value that the action changes (like expires_at). */
export function signActionToken(parts: string[], secret: string): string {
  return hmac(parts.join(":"), secret);
}

export function verifyActionToken(parts: string[], token: string, secret: string): boolean {
  const expected = signActionToken(parts, secret);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extract the authenticated agent phone from the session cookie, or null. */
export function requireAuth(req: Request): string | null {
  const cookies = String(req.headers.cookie || "");
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  return verifySession(match[1], nadlanJwtSecret.value());
}

function hashCode(code: string, secret: string): string {
  return crypto.createHash("sha256").update(code + secret).digest("hex");
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────
// sendLoginOtp — POST { phone, mode?: "login" | "signup" }
// ────────────────────────────────────────────────────────────
export const sendLoginOtp = onRequest(
  {secrets: [greenApiInstance, greenApiToken, nadlanJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const body = req.body as {phone?: string; mode?: string};
    const phone = normalizePhone(body.phone || "");
    if (!phone) {
      res.status(400).json({error: "invalid_phone"});
      return;
    }
    const mode = body.mode === "signup" ? "signup" : "login";

    const business = await db.collection("businesses").doc(phone).get();
    if (mode === "login" && !business.exists) {
      res.status(404).json({error: "unknown_agent"});
      return;
    }
    if (mode === "signup" && business.exists) {
      res.status(409).json({error: "already_registered"});
      return;
    }

    const otpRef = db.collection("otp_codes").doc(phone);
    const otpDoc = await otpRef.get();
    const now = Date.now();
    const prev = otpDoc.exists ? otpDoc.data() as {
      last_sent_at?: FirebaseFirestore.Timestamp;
      sends_today?: number;
      sends_day?: string;
    } : {};

    const lastSent = prev.last_sent_at ? prev.last_sent_at.toMillis() : 0;
    if (now - lastSent < OTP_RESEND_GAP_MS) {
      res.status(429).json({error: "too_soon", retry_in_s: Math.ceil((OTP_RESEND_GAP_MS - (now - lastSent)) / 1000)});
      return;
    }
    const sendsToday = prev.sends_day === todayKey() ? (prev.sends_today || 0) : 0;
    if (sendsToday >= OTP_MAX_SENDS_PER_DAY) {
      res.status(429).json({error: "daily_limit"});
      return;
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await otpRef.set({
      code_hash: hashCode(code, nadlanJwtSecret.value()),
      expires_at: new Date(now + OTP_TTL_MS),
      attempts: 0,
      mode,
      last_sent_at: new Date(now),
      sends_today: sendsToday + 1,
      sends_day: todayKey(),
    });

    try {
      await sendWhatsAppMessage(
        phone,
        `🔐 קוד הכניסה שלך לפורלי: ${code}\nהקוד תקף ל-5 דקות.`,
        greenApiInstance.value(),
        greenApiToken.value()
      );
    } catch (err) {
      logger.error("OTP WhatsApp send failed:", err);
      res.status(502).json({error: "whatsapp_send_failed"});
      return;
    }
    res.json({ok: true});
  }
);

// ────────────────────────────────────────────────────────────
// verifyLoginOtp — POST { phone, code } → session cookie
// ────────────────────────────────────────────────────────────
export const verifyLoginOtp = onRequest(
  {secrets: [nadlanJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const body = req.body as {phone?: string; code?: string};
    const phone = normalizePhone(body.phone || "");
    const code = String(body.code || "").trim();
    if (!phone || !/^\d{6}$/.test(code)) {
      res.status(400).json({error: "invalid_input"});
      return;
    }

    const otpRef = db.collection("otp_codes").doc(phone);
    const otpDoc = await otpRef.get();
    if (!otpDoc.exists) {
      res.status(400).json({error: "no_code"});
      return;
    }
    const otp = otpDoc.data() as {
      code_hash: string;
      expires_at: FirebaseFirestore.Timestamp;
      attempts: number;
      mode?: string;
    };
    if (otp.expires_at.toMillis() < Date.now()) {
      await otpRef.delete();
      res.status(400).json({error: "expired"});
      return;
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await otpRef.delete();
      res.status(429).json({error: "too_many_attempts"});
      return;
    }
    if (otp.code_hash !== hashCode(code, nadlanJwtSecret.value())) {
      await otpRef.update({attempts: otp.attempts + 1});
      res.status(401).json({error: "wrong_code", attempts_left: OTP_MAX_ATTEMPTS - otp.attempts - 1});
      return;
    }

    await otpRef.delete();
    const token = signSession(phone, nadlanJwtSecret.value());
    res.set("Set-Cookie",
      `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_S}; Path=/`);

    const business = await db.collection("businesses").doc(phone).get();
    const b = business.exists ? business.data() as Record<string, unknown> : {};
    res.json({
      ok: true,
      is_new: !business.exists,
      mode: otp.mode || "login",
      agent: {
        name: (b.full_name as string) || "",
        brand_name: (b.business_name as string) || "",
        logo_url: (b.logo_url as string) || null,
      },
    });
  }
);
