/*
 * routes/profile.js — the agent profile completion form's backend.
 * Handles: /api/onboarding (GET), /api/onboarding/save, /api/onboarding/complete
 *
 * Replaces the signupGet / signupSave / signupComplete / signupUpload Cloud
 * Functions. The phone is taken from the session cookie, never from the body,
 * so an agent can only ever read and write their own profile. Portrait and logo
 * go through the shared /api/upload-urls flow (routes/intake.js) like every
 * other upload in the product — there is no separate base64 endpoint.
 */

const express = require("express");

const db = require("../db");
const onboarding = require("../profile-onboarding");

module.exports = function createProfileRouter(ctx) {
  const { requireAuth, authSecret } = ctx;

  const router = express.Router();

  // ── prefill ──
  router.get("/onboarding", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    try {
      const business = await db.getBusiness(phone);
      res.json({
        phone,
        already_complete: !!business && business.onboarding_state === "complete",
        profile: onboarding.readProfile(business),
      });
    } catch (err) {
      console.error("onboarding read failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── autosave (on blur) ──
  router.post("/onboarding/save", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const profile = onboarding.sanitizeProfile(req.body && req.body.profile);
    // No consent, nothing persisted — not even a partial.
    if (!profile.privacy_consent) return res.status(400).json({ error: "privacy_consent_required" });
    try {
      await db.setBusiness(phone, onboarding.buildPartialDoc(profile, new Date()));
      res.json({ ok: true, onboarding_pct: onboarding.completenessPct(profile) });
    } catch (err) {
      console.error("onboarding save failed:", err);
      res.status(500).json({ error: "save failed" });
    }
  });

  // ── finish ──
  router.post("/onboarding/complete", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const profile = onboarding.sanitizeProfile(req.body && req.body.profile);
    if (!profile.privacy_consent) return res.status(400).json({ error: "privacy_consent_required" });
    const missing = onboarding.missingEssentials(profile);
    if (missing.length) return res.status(400).json({ error: "missing_required_fields", need: missing });

    const now = new Date();
    try {
      const existing = await db.getBusiness(phone);
      await db.setBusiness(phone, onboarding.buildCompleteDoc(profile, phone, now, existing));
      // Starter quota, same shape the retired signupComplete wrote. Best-effort
      // for the same reason as the lead conversion below.
      try {
        // Trial bundle for every quota kind (see server/quota.js). Same flat
        // shape as before; walkthroughs stays at 4.
        await db.initQuota(phone, require("../quota").trialSeed(now));
      } catch (err) {
        console.error("quota init failed (profile still saved):", err.message);
      }
      // A prospect who signed up is no longer a lead. Best-effort: the profile
      // is saved either way, and a stale lead is not worth failing the form on.
      try {
        if (await db.getLead(phone)) await db.saveLead(phone, { status: "converted", converted_at: now });
      } catch (err) {
        console.error("lead conversion failed (profile still saved):", err.message);
      }
      res.json({ ok: true, onboarding_pct: onboarding.completenessPct(profile) });
    } catch (err) {
      console.error("onboarding complete failed:", err);
      res.status(500).json({ error: "save failed" });
    }
  });

  return router;
};
