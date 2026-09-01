/*
 * Unit tests for profile-onboarding.js — the "השלמת פרופיל" form's shaping,
 * validation and completeness maths. Pure functions: no Express, no Firestore.
 * Run: node server/profile-onboarding.test.js
 */
const assert = require("assert");
const {
  sanitizeProfile, missingEssentials, completenessPct,
  buildPartialDoc, buildCompleteDoc, readProfile, MAX_AREAS, MAX_COLORS,
} = require("./profile-onboarding");

const PORTRAIT = "https://cdn.example.com/files/a.jpg";
const full = () => ({
  full_name: "שיראל כהן", activity_areas: ["תל אביב"], portrait_url: PORTRAIT,
  specialty: "יוקרה", license_number: "12345", slogan: "הבית הבא שלך",
  tone: "luxury", gender_pref: "female", brand_colors: ["#0B1B3D"],
  logo_url: "https://cdn.example.com/files/b.png", site: "https://x.co",
  instagram: "@x", facebook: "fb.com/x", years_experience: 8, privacy_consent: true,
});

// ── sanitize is the trust boundary ──
{
  const p = sanitizeProfile({
    full_name: "  " + "א".repeat(200) + "  ",
    activity_areas: ["חיפה", "חיפה", "  ", "ב".repeat(99), ...Array(30).fill(0).map((_, i) => "עיר" + i)],
    portrait_url: "javascript:alert(1)",
    logo_url: "  https://cdn.example.com/files/b.png ",
    brand_colors: ["#0b1b3d", "not-a-colour", "#FFF", "#123456", "#abcdef", "#000000"],
    tone: "shouty", gender_pref: "female",
    years_experience: "999", slogan: "ס".repeat(500),
    privacy_consent: "true",
  });
  assert.equal(p.full_name.length, 60, "full_name is clamped");
  assert.equal(p.activity_areas.length, MAX_AREAS, "areas are capped");
  assert.equal(p.activity_areas[0], "חיפה");
  assert.equal(p.activity_areas.filter((a) => a === "חיפה").length, 1, "areas are deduped");
  assert.ok(p.activity_areas.every((a) => a.length <= 40), "each area is clamped");
  assert.equal(p.portrait_url, "", "a non-http url is not stored");
  assert.equal(p.logo_url, "https://cdn.example.com/files/b.png", "a real upload url survives, trimmed");
  assert.deepEqual(p.brand_colors, ["#0B1B3D", "#123456", "#ABCDEF"], "only 6-digit hex, capped and uppercased");
  assert.ok(p.brand_colors.length <= MAX_COLORS);
  assert.equal(p.tone, "", "an unknown tone is dropped, not stored");
  assert.equal(p.gender_pref, "female");
  assert.equal(p.years_experience, 60, "years are clamped to the 0-60 range");
  assert.equal(p.slogan.length, 80);
  assert.equal(p.privacy_consent, false, "consent must be a real boolean true, not a truthy string");

  assert.equal(sanitizeProfile({years_experience: -5}).years_experience, 0);
  assert.equal(sanitizeProfile({years_experience: "abc"}).years_experience, 0);
  assert.equal(sanitizeProfile(null).full_name, "", "a missing body is an empty profile, not a crash");
}

// ── the three essentials gate completion ──
{
  assert.deepEqual(missingEssentials(sanitizeProfile({})),
    ["full_name", "activity_areas", "portrait_url"]);
  assert.deepEqual(missingEssentials(sanitizeProfile({full_name: "דנה", activity_areas: ["חיפה"]})),
    ["portrait_url"]);
  assert.deepEqual(missingEssentials(sanitizeProfile(full())), []);
  // an unusable portrait url is a missing portrait, not a passing one
  assert.deepEqual(
    missingEssentials(sanitizeProfile({...full(), portrait_url: "ftp://nope"})), ["portrait_url"]);
}

// ── completeness: 60 for the essentials, 40 across the eleven optionals ──
{
  assert.equal(completenessPct(sanitizeProfile({})), 0);
  assert.equal(completenessPct(sanitizeProfile(full())), 100);
  const essentialsOnly = sanitizeProfile({
    full_name: "דנה", activity_areas: ["חיפה"], portrait_url: PORTRAIT, privacy_consent: true,
  });
  assert.equal(completenessPct(essentialsOnly), 60, "essentials alone are worth 60%");
  assert.equal(completenessPct(sanitizeProfile({full_name: "דנה"})), 20, "one of three essentials");
  assert.equal(completenessPct(sanitizeProfile({...essentialsOnly, specialty: "יוקרה"})), 64);
  // years_experience only counts once it is above zero
  assert.equal(completenessPct(sanitizeProfile({...essentialsOnly, years_experience: 0})), 60);
  assert.equal(completenessPct(sanitizeProfile({...essentialsOnly, years_experience: 3})), 64);
}

// ── autosave doc ──
{
  const now = new Date("2026-01-02T03:04:05Z");
  const doc = buildPartialDoc(sanitizeProfile(full()), now);
  assert.equal(doc.privacy_consent, true);
  assert.equal(doc.privacy_consent_at, now);
  assert.equal(doc.onboarding_partial.full_name, "שיראל כהן");
  assert.ok(!("privacy_consent" in doc.onboarding_partial),
    "consent is a top-level fact, not part of the partial payload");
  assert.ok(!("onboarding_state" in doc), "an autosave must never mark the profile complete");
}

// ── completion doc ──
{
  const now = new Date("2026-01-02T03:04:05Z");
  const created = new Date("2025-05-05T00:00:00Z");
  const doc = buildCompleteDoc(sanitizeProfile(full()), "972501234567", now, {created_at: created});
  assert.equal(doc.onboarding_state, "complete");
  assert.equal(doc.onboarding_pct, 100);
  assert.equal(doc.phone, "972501234567");
  assert.equal(doc.plan, "trial");
  assert.equal(doc.paid, false);
  assert.equal(doc.created_at, created, "an existing created_at is preserved");
  assert.equal(doc.full_name, "שיראל כהן", "fields are promoted to top level, not left in the partial");
  assert.ok(!("onboarding_partial" in doc));
  assert.equal(buildCompleteDoc(sanitizeProfile(full()), "9725", now, null).created_at, now,
    "a first-time profile is created now");
}

// ── prefill: top level wins, the WhatsApp bot's partial fills the gaps ──
{
  const p = readProfile({
    full_name: "דנה לוי",
    onboarding_partial: {full_name: "ישן", specialty: "מסחרי", activity_areas: ["רעננה"]},
    privacy_consent: true,
  });
  assert.equal(p.full_name, "דנה לוי", "the completed field wins");
  assert.equal(p.specialty, "מסחרי", "the partial fills what the top level lacks");
  assert.deepEqual(p.activity_areas, ["רעננה"]);
  assert.equal(p.privacy_consent, true);

  const empty = readProfile(null);
  assert.equal(empty.full_name, "");
  assert.deepEqual(empty.activity_areas, []);
  assert.equal(empty.privacy_consent, false);

  // an empty top-level array must not shadow the partial's answers
  assert.deepEqual(
    readProfile({activity_areas: [], onboarding_partial: {activity_areas: ["אילת"]}}).activity_areas,
    ["אילת"]);
}

console.log("profile-onboarding: all tests passed");
