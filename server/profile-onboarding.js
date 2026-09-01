/*
 * profile-onboarding.js — the 15-field agent profile ("השלמת פרופיל").
 *
 * Pure shaping and validation, no Express and no Firestore, so routes/profile.js
 * stays a thin wrapper and this is testable on its own (profile-onboarding.test.js).
 *
 * This used to live in Cloud Functions (signupGet/Save/Complete) behind
 * call4li.web.app, which took the phone from the request body — any caller could
 * read or overwrite any agent's profile. The routes here take the phone from the
 * session cookie instead; nothing in this file ever sees a caller-supplied phone.
 */

const TONE_VALUES = ["professional", "friendly", "energetic", "luxury"];
const GENDER_VALUES = ["male", "female", "neutral"];

// Optional fields that count toward the last 40% (see completenessPct).
const OPTIONAL_COUNT = 11;

const MAX_AREAS = 12;
const MAX_COLORS = 3;

const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

// Uploads come back from /api/upload-urls as absolute URLs; anything else is a
// client sending us something we did not mint, so it does not get stored.
function mediaUrl(v) {
  const s = str(v, 500);
  return /^https?:\/\//i.test(s) ? s : "";
}

function areas(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const a of v) {
    const s = str(a, 40);
    if (s && !out.includes(s)) out.push(s);
    if (out.length === MAX_AREAS) break;
  }
  return out;
}

function colors(v) {
  if (!Array.isArray(v)) return [];
  return v.map((c) => str(c, 7).toUpperCase())
    .filter((c) => /^#[0-9A-F]{6}$/.test(c))
    .slice(0, MAX_COLORS);
}

function years(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60) : 0;
}

/* Normalize whatever the form posted into the canonical profile shape.
   Every field is clamped here — this is the trust boundary. */
function sanitizeProfile(raw) {
  const p = raw || {};
  return {
    full_name: str(p.full_name, 60),
    activity_areas: areas(p.activity_areas),
    specialty: str(p.specialty, 60),
    license_number: str(p.license_number, 40),
    portrait_url: mediaUrl(p.portrait_url),
    slogan: str(p.slogan, 80),
    tone: TONE_VALUES.includes(String(p.tone)) ? String(p.tone) : "",
    gender_pref: GENDER_VALUES.includes(String(p.gender_pref)) ? String(p.gender_pref) : "",
    brand_colors: colors(p.brand_colors),
    logo_url: mediaUrl(p.logo_url),
    site: str(p.site, 200),
    instagram: str(p.instagram, 200),
    facebook: str(p.facebook, 200),
    years_experience: years(p.years_experience),
    privacy_consent: p.privacy_consent === true,
  };
}

/* The three essentials gate completion; they are worth 60% between them,
   the eleven optional fields share the remaining 40%. The form shows the
   same number live, so keep the two formulas in step. */
const ESSENTIALS = ["full_name", "activity_areas", "portrait_url"];

function missingEssentials(p) {
  return ESSENTIALS.filter((k) => (k === "activity_areas" ? !p[k].length : !p[k]));
}

function completenessPct(p) {
  const filled = ESSENTIALS.length - missingEssentials(p).length;
  const optional = [
    p.specialty, p.license_number, p.slogan, p.tone, p.gender_pref,
    p.site, p.instagram, p.facebook,
    p.brand_colors.length ? "x" : "", p.logo_url, p.years_experience > 0 ? "x" : "",
  ].filter(Boolean).length;
  return Math.round((filled / ESSENTIALS.length) * 60) + Math.round((optional / OPTIONAL_COUNT) * 40);
}

/* Autosave: parks everything under onboarding_partial, the same key the
   WhatsApp signup bot fills in, so both channels resume each other's work.
   Nothing is stored at all until the agent has consented. */
function buildPartialDoc(p, now) {
  const { privacy_consent: _consent, ...partial } = p;
  return {
    privacy_consent: true,
    privacy_consent_at: now,
    onboarding_partial: partial,
    updated_at: now,
  };
}

/* Completion: promotes the partial to top-level fields, which is where the
   rest of the product (pages, carousels, the bot) reads the profile from. */
function buildCompleteDoc(p, phone, now, existing) {
  const { privacy_consent: _consent, ...fields } = p;
  return {
    ...fields,
    phone,
    plan: "trial",
    paid: false,
    onboarding_state: "complete",
    onboarding_pct: completenessPct(p),
    privacy_consent: true,
    privacy_consent_at: now,
    updated_at: now,
    created_at: (existing && existing.created_at) || now,
  };
}

/* What the form prefills from: top-level wins, the partial fills the gaps,
   so an agent who answered half in WhatsApp sees those answers here. */
function readProfile(business) {
  const d = business || {};
  const partial = d.onboarding_partial || {};
  const pick = (k) => (d[k] != null && d[k] !== "" ? d[k] : partial[k]);
  return sanitizeProfile({
    full_name: pick("full_name"),
    activity_areas: d.activity_areas && d.activity_areas.length ? d.activity_areas : partial.activity_areas,
    specialty: pick("specialty"),
    license_number: pick("license_number"),
    portrait_url: pick("portrait_url"),
    slogan: pick("slogan"),
    tone: pick("tone"),
    gender_pref: pick("gender_pref"),
    brand_colors: d.brand_colors && d.brand_colors.length ? d.brand_colors : partial.brand_colors,
    logo_url: pick("logo_url"),
    site: pick("site"),
    instagram: pick("instagram"),
    facebook: pick("facebook"),
    years_experience: pick("years_experience"),
    privacy_consent: d.privacy_consent === true,
  });
}

module.exports = {
  TONE_VALUES, GENDER_VALUES, ESSENTIALS, OPTIONAL_COUNT, MAX_AREAS, MAX_COLORS,
  sanitizeProfile, missingEssentials, completenessPct,
  buildPartialDoc, buildCompleteDoc, readProfile,
};
