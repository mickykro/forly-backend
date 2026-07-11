import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import {
  db, sendWhatsAppMessage, greenApiInstance, greenApiToken, nadlanJwtSecret,
} from "../shared";
import {requireAuth} from "../nadlan/auth";

// ────────────────────────────────────────────────────────────
// submitWebSignup — POST, requires a session cookie obtained via the
// signup-mode OTP flow (sendLoginOtp{mode:"signup"} → verifyLoginOtp).
// Writes businesses/{phone} in the same shape Signup Bot2 produces, so both
// channels converge on one canonical doc.
// ────────────────────────────────────────────────────────────
export const submitWebSignup = onRequest(
  {secrets: [nadlanJwtSecret, greenApiInstance, greenApiToken], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const phone = requireAuth(req);
    if (!phone) {
      res.status(401).json({error: "unauthenticated"});
      return;
    }

    const body = req.body as {
      full_name?: string;
      business_name?: string;
      city?: string;
      niche?: string;
      logo_url?: string | null;
      wants_generated_logo?: boolean;
    };
    const fullName = String(body.full_name || "").trim().slice(0, 60);
    const businessName = String(body.business_name || "").trim().slice(0, 60);
    if (fullName.length < 2 || businessName.length < 2) {
      res.status(400).json({error: "full_name and business_name required"});
      return;
    }

    const ref = db.collection("businesses").doc(phone);
    const existing = await ref.get();
    if (existing.exists && existing.get("signup_completed_at")) {
      res.status(409).json({error: "already_registered"});
      return;
    }

    try {
      await ref.set({
        phone,
        full_name: fullName,
        business_name: businessName,
        city: String(body.city || "").slice(0, 60),
        niche: String(body.niche || "nadlan").slice(0, 40),
        logo_url: body.logo_url || null,
        logo_requested: body.wants_generated_logo === true && !body.logo_url,
        source: "web_signup",
        signup_completed_at: new Date(),
        total_inquiries_reported: 0,
        total_deals_closed: 0,
        created_at: existing.exists ? existing.get("created_at") : new Date(),
      }, {merge: true});

      // Starter quota subcollection — same shape Signup Bot2 writes.
      await ref.collection("quota").doc("current").set({
        plan: "trial",
        period_start: new Date(),
      }, {merge: true});

      // Welcome on WhatsApp — best-effort.
      try {
        await sendWhatsAppMessage(
          phone,
          `ברוכים הבאים לפורלי 🦉\n` +
          `${fullName}, החשבון של ${businessName} מוכן!\n\n` +
          `מה עכשיו? נכנסים ל-agent.call4li.com, פותחים נכס ראשון — ` +
          `ותוך דקות יש לו דף נחיתה עם וידאו, גלריה ומידע על השכונה.`,
          greenApiInstance.value(),
          greenApiToken.value()
        );
      } catch (err) {
        logger.error("welcome send failed (signup still ok):", err);
      }

      res.json({ok: true});
    } catch (err) {
      logger.error("submitWebSignup failed:", err);
      res.status(500).json({error: "internal"});
    }
  }
);
