/*
 * routes/profile.js — the agent profile completion form's backend.
 * Handles: /api/onboarding (GET), /api/onboarding/save, /api/onboarding/complete,
 * /api/onboarding/update (edits after completion)
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
const { portfolioSlug } = require("../portfolio");

module.exports = function createProfileRouter(ctx) {
  const { requireAuth, authSecret } = ctx;

  const router = express.Router();

  // ── prefill ──
  router.get("/onboarding", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    try {
      const business = await db.getBusiness(phone);
      const slug = business && business.portfolio && business.portfolio.slug;
      res.json({
        phone,
        already_complete: !!business && business.onboarding_state === "complete",
        profile: onboarding.readProfile(business),
        portfolio_slug: slug || null,
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
    profile.extra_phones = profile.extra_phones.filter((p) => p !== phone);

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

  // ── edit a completed profile ──
  // Only the profile fields change: completing again would reset the plan and
  // re-seed the quota, so a completed agent edits through here instead.
  router.post("/onboarding/update", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const profile = onboarding.sanitizeProfile(req.body && req.body.profile);
    if (!profile.privacy_consent) return res.status(400).json({ error: "privacy_consent_required" });
    const missing = onboarding.missingEssentials(profile);
    if (missing.length) return res.status(400).json({ error: "missing_required_fields", need: missing });
    // The main phone is the login and is never an "additional" one.
    profile.extra_phones = profile.extra_phones.filter((p) => p !== phone);
    try {
      const existing = await db.getBusiness(phone);
      if (!existing || existing.onboarding_state !== "complete") return res.status(409).json({ error: "not_complete" });
      const doc = onboarding.buildUpdateDoc(profile, new Date());
      // The portfolio's address: a new one is reserved and the old one keeps
      // redirecting to it (portfolio_slugs), so shared links still work.
      const portfolio = existing.portfolio || null;
      const asked = req.body && typeof req.body.portfolio_slug === "string" ? req.body.portfolio_slug : null;
      let slug = portfolio && portfolio.slug;
      if (portfolio && portfolio.slug && asked !== null) {
        const next = portfolioSlug(asked);
        if (next !== portfolio.slug) {
          await db.reservePortfolioSlug(phone, next, portfolio.slug);
          doc.portfolio = { ...portfolio, slug: next };
          slug = next;
        }
      }
      await db.setBusiness(phone, doc);
      require("../business-cache").invalidate(phone);
      res.json({ ok: true, onboarding_pct: onboarding.completenessPct(profile), portfolio_slug: slug || null });
    } catch (err) {
      if (err && err.message === "slug_taken") return res.status(409).json({ error: "slug_taken" });
      console.error("onboarding update failed:", err);
      res.status(500).json({ error: "save failed" });
    }
  });

  return router;
};
