/**
 * portfolio.js — pure helpers for portfolio slugs, normalization, and visibility.
 * ponytail: no Firestore, no side effects, just deterministic transforms.
 */

// Hebrew-to-Latin transliteration (shared pattern from db.js)
const HE_LATIN = {
  "א": "a", "ב": "b", "ג": "g", "ד": "d", "ה": "h", "ו": "v", "ז": "z",
  "ח": "ch", "ט": "t", "י": "y", "כ": "k", "ך": "k", "ל": "l", "מ": "m",
  "ם": "m", "נ": "n", "ן": "n", "ס": "s", "ע": "a", "פ": "p", "ף": "f",
  "צ": "tz", "ץ": "tz", "ק": "k", "ר": "r", "ש": "sh", "ת": "t",
};

function transliterate(str) {
  return String(str || "").split("").map((c) => HE_LATIN[c] || c).join("");
}

const RESERVED_SEGMENTS = new Set(["api", "p", "portfolio", "legal", "assets", "favicon.ico", "robots.txt", "sitemap.xml"]);

/**
 * Generate a route-safe portfolio slug from a business/agent name.
 * @param {string} value - Hebrew or mixed business name
 * @returns {string} - lowercase a-z0-9 hyphenated slug, max 60 chars
 */
function portfolioSlug(value) {
  const latin = transliterate(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const slug = latin.slice(0, 60).replace(/-+$/g, "");
  if (!slug) return "my-portfolio"; // fallback for empty input
  if (RESERVED_SEGMENTS.has(slug)) return `agent-${slug}`;
  return slug;
}

/**
 * Generate a nested property slug from address + short code.
 * Format: {street3}{number}-{code}, e.g. "vyt23-a7k"
 * @param {string} address - Hebrew street address
 * @param {string} code - short random code
 * @returns {string} - max 48 chars
 */
function propertySlug(address, code) {
  const latin = transliterate(String(address || "")).toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  const words = latin.trim().split(/\s+/).filter(Boolean);
  const number = words.find((w) => /^\d+$/.test(w)) || "";
  const street = words.filter((w) => !/^\d+$/.test(w)).join("").slice(0, 3);
  const prefix = street || "property";
  return `${prefix}${number}-${code}`.slice(0, 48);
}

/**
 * Parse a public path into kind + slugs, rejecting reserved segments.
 * @param {string} path - e.g. "/kroitoro-nehasim/vyt23-a7k"
 * @returns {{ kind: "portfolio"|"property", portfolioSlug: string, propertySlug?: string } | null}
 */
function parsePublicPath(path) {
  const segments = (path || "").split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (RESERVED_SEGMENTS.has(segments[0])) return null;
  if (segments.length === 1) return { kind: "portfolio", portfolioSlug: segments[0] };
  if (segments.length === 2) return { kind: "property", portfolioSlug: segments[0], propertySlug: segments[1] };
  return null;
}

/**
 * Filter pages to those visible in the portfolio dashboard.
 * @param {Array<{ status: string, portfolio_visible?: boolean, portfolio_rank?: number|null }>} pages
 * @returns {Array} - sorted by rank (nulls last, then by newest)
 */
function visiblePortfolioPages(pages) {
  return pages
    .filter((p) => (p.status === "active" || p.status === "expiring") && p.portfolio_visible !== false)
    .sort((a, b) => (a.portfolio_rank ?? Infinity) - (b.portfolio_rank ?? Infinity));
}

/**
 * Normalize raw portfolio input against existing config.
 * @param {unknown} input - partial update from client
 * @param {object} existing - current PortfolioConfig
 * @returns {object} - merged normalized config
 */
function normalizePortfolio(input, existing) {
  const i = typeof input === "object" && input ? input : {};
  const e = existing || {};
  const now = new Date();
  return {
    slug: e.slug || "",
    status: e.status || "draft",
    hero: {
      headline: String(i.hero?.headline ?? e.hero?.headline ?? "").slice(0, 120),
      intro: String(i.hero?.intro ?? e.hero?.intro ?? "").slice(0, 500),
      portrait_url: i.hero?.portrait_url ?? e.hero?.portrait_url ?? null,
    },
    about: { body: String(i.about?.body ?? e.about?.body ?? "").slice(0, 1500) },
    area: {
      headline: String(i.area?.headline ?? e.area?.headline ?? "").slice(0, 120),
      body: String(i.area?.body ?? e.area?.body ?? "").slice(0, 1500),
      locations: (Array.isArray(i.area?.locations) ? i.area.locations : e.area?.locations || [])
        .slice(0, 20).map((l) => String(l).slice(0, 60)),
    },
    testimonials: (Array.isArray(i.testimonials) ? i.testimonials : e.testimonials || [])
      .slice(0, 6).map((t, idx) => ({
        id: t.id || `t${idx}-${Date.now()}`,
        quote: String(t.quote || "").slice(0, 500),
        attribution: String(t.attribution || "").slice(0, 80),
      })),
    theme: {
      primary: i.theme?.primary ?? e.theme?.primary ?? null,
      accent: i.theme?.accent ?? e.theme?.accent ?? null,
      font_url: i.theme?.font_url ?? e.theme?.font_url ?? null,
    },
    created_at: e.created_at || now,
    updated_at: now,
  };
}

// Status transition helpers
function reservationTarget(reservation) {
  return reservation?.current_slug || null;
}

function assertSlugAvailable(reservations, slug, phone) {
  const existing = reservations[slug];
  if (existing && existing.business_phone !== phone) throw new Error("slug_taken");
}

function nextPortfolioStatus(current, activeCount) {
  if (current === "closed") return "closed"; // only admin can reopen
  if (current === "draft" && activeCount >= 2) return "open";
  return current;
}

module.exports = {
  portfolioSlug,
  propertySlug,
  parsePublicPath,
  visiblePortfolioPages,
  normalizePortfolio,
  reservationTarget,
  assertSlugAvailable,
  nextPortfolioStatus,
  RESERVED_SEGMENTS,
};
