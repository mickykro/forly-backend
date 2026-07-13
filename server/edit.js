/*
 * Forly Nadlan — in-page text editing ("magic edit link") support.
 *
 * Each property page carries a random `edit_token`. Opening the page as
 * /p/{id}#edit={token} unlocks inline text editing (public-nadlan/p/edit.js);
 * saves land on POST /api/page/edit-text which uses buildEditPatch() below.
 *
 * Security model: the token is a 128-bit random secret stored on the page
 * doc, surfaced only on the agent-facing create/dashboard screens, compared
 * in constant time, and guarded by a per-page failed-attempt throttle.
 * Everything the endpoint can change is plain text behind a whitelist —
 * no assets, no numbers, no layout, no theme.
 */

const crypto = require("crypto");

// Template texts editable via the `texts` override map: key → max length.
// Keys match the data-edit="texts.*" attributes in public-nadlan/p/.
const TEXT_KEYS = {
  top_cta: 40, eyebrow: 80, hero_sub: 200, hero_btn1: 40, hero_btn2: 40,
  video_badge: 30, scroll_hint: 20,
  spec1_v: 30, spec1_l: 60, spec2_v: 30, spec2_l: 60,
  spec3_v: 30, spec3_l: 60, spec4_v: 30, spec4_l: 60,
  gallery_kicker: 40, gallery_title: 90, gallery_sub: 160,
  why_kicker: 40, why_title: 120, why_sub: 200,
  agent_cta: 40, agent_meta: 160,
  area_kicker: 40, area_title: 90, area_sub: 160,
  form_name_label: 30, form_phone_label: 30, form_or: 10, wa_button: 40,
  done_title: 60, done_sub: 160,
  footer_brand: 80, sticky_wa: 30, sticky_cta: 30,
};

const LIMITS = {
  hero_phrase: 120,
  agent: { name: 60, brand_name: 60, tagline: 120 },
  cta: { headline: 120, sub: 300, button_label: 40, bullet: 120, bullets_max: 5 },
  slide: { num: 6, title: 80, body: 400, tag: 40 },
  caption: 60,
  blurb: 1500,
  stop: { label: 60, minutes: 40 },
  stat: { value: 40, label: 120 },
};

function newEditToken() {
  return crypto.randomBytes(16).toString("hex");
}

function editTokenOk(page, token) {
  if (!page || !page.edit_token || typeof token !== "string" || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(String(page.edit_token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Brute-force guard: after FAILS_MAX bad tokens for a page within the window,
// ignore tokens for that page entirely (even a correct one) until it expires.
const fails = new Map(); // pageId → { start, count }
const FAILS_MAX = 10;
const FAILS_WINDOW_MS = 3600000;

function editThrottled(pageId) {
  const f = fails.get(pageId);
  return !!f && Date.now() - f.start < FAILS_WINDOW_MS && f.count >= FAILS_MAX;
}

function noteEditFail(pageId) {
  const f = fails.get(pageId);
  const now = Date.now();
  if (!f || now - f.start >= FAILS_WINDOW_MS) fails.set(pageId, { start: now, count: 1 });
  else f.count++;
}

const line = (v, cap) => String(v).replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, cap);
const multi = (v, cap) => String(v).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, cap);

// Turn a client `fields` object into a dot-path Firestore-style patch.
// Whitelist-only: unknown keys are dropped silently. Arrays merge by index
// onto the page's current arrays — no adding or removing items, and
// non-text properties (urls, source_url) are preserved.
function buildEditPatch(page, fields) {
  const patch = {};
  if (typeof fields.hero_phrase === "string") {
    patch["hero.phrase"] = multi(fields.hero_phrase, LIMITS.hero_phrase)
      .split("\n").slice(0, 2).join("\n");
  }
  if (fields.agent && typeof fields.agent === "object") {
    for (const k of ["name", "brand_name", "tagline"]) {
      if (typeof fields.agent[k] === "string") patch[`agent.${k}`] = line(fields.agent[k], LIMITS.agent[k]);
    }
  }
  if (fields.cta && typeof fields.cta === "object") {
    for (const k of ["headline", "sub", "button_label"]) {
      if (typeof fields.cta[k] === "string") patch[`cta.${k}`] = line(fields.cta[k], LIMITS.cta[k]);
    }
    if (Array.isArray(fields.cta.bullets)) {
      patch["cta.bullets"] = fields.cta.bullets.slice(0, LIMITS.cta.bullets_max)
        .map((b) => line(b, LIMITS.cta.bullet)).filter(Boolean);
    }
  }
  if (typeof fields.area_blurb === "string") {
    patch["area.blurb"] = multi(fields.area_blurb, LIMITS.blurb);
  }
  if (Array.isArray(fields.carousel_slides)) {
    patch["carousel.slides"] = ((page.carousel && page.carousel.slides) || []).map((s, i) => {
      const p = fields.carousel_slides[i] || {};
      return {
        num: typeof p.num === "string" ? line(p.num, LIMITS.slide.num) : s.num,
        title: typeof p.title === "string" ? line(p.title, LIMITS.slide.title) : s.title,
        body: typeof p.body === "string" ? line(p.body, LIMITS.slide.body) : s.body,
        tag: typeof p.tag === "string" ? line(p.tag, LIMITS.slide.tag) : s.tag,
      };
    });
  }
  if (Array.isArray(fields.gallery_captions)) {
    const byUrl = new Map(fields.gallery_captions
      .filter((c) => c && typeof c.url === "string" && typeof c.caption === "string")
      .map((c) => [c.url, c.caption]));
    patch["gallery.images"] = ((page.gallery && page.gallery.images) || []).map((img) =>
      byUrl.has(img.url) ? { ...img, caption: line(byUrl.get(img.url), LIMITS.caption) } : img);
  }
  if (Array.isArray(fields.area_stops)) {
    patch["area.stops"] = ((page.area && page.area.stops) || []).map((s, i) => {
      const p = fields.area_stops[i] || {};
      return {
        ...s,
        label: typeof p.label === "string" ? line(p.label, LIMITS.stop.label) : s.label,
        minutes: typeof p.minutes === "string" ? line(p.minutes, LIMITS.stop.minutes) : s.minutes,
      };
    });
  }
  if (Array.isArray(fields.area_stats)) {
    patch["area.stats"] = ((page.area && page.area.stats) || []).map((s, i) => {
      const p = fields.area_stats[i] || {};
      return {
        ...s,
        value: typeof p.value === "string" ? line(p.value, LIMITS.stat.value) : s.value,
        label: typeof p.label === "string" ? line(p.label, LIMITS.stat.label) : s.label,
      };
    });
  }
  if (fields.texts && typeof fields.texts === "object") {
    for (const [k, v] of Object.entries(fields.texts)) {
      if (TEXT_KEYS[k] && typeof v === "string") patch[`texts.${k}`] = line(v, TEXT_KEYS[k]);
    }
  }
  return patch;
}

module.exports = { newEditToken, editTokenOk, editThrottled, noteEditFail, buildEditPatch };
