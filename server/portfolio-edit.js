/*
 * portfolio-edit.js — read, save and create one agent's portfolio.
 *
 * Shared by the agent's own editor (/api/my-portfolio, dashboard.js) and the
 * operator editing it for them (/api/admin/portfolio, routes/admin-portfolio.js),
 * so both write exactly the same shape. The caller decides whose phone it is.
 */
const db = require("./db");
const { portfolioSlug, normalizePortfolio } = require("./portfolio");
const businessCache = require("./business-cache");

const EMPTY_PROFILE = { business_name: "", full_name: "", city: "", license_number: "", logo_url: null };

async function getPortfolio(phone) {
  const business = await db.getBusiness(phone);
  if (!business) return { profile: EMPTY_PROFILE, portfolio: null, pages: [] };
  // Archived pages are out of the portfolio until restored — not even listed here.
  const pages = (await db.listPagesByPhone(phone, 100)).filter((p) => p.status !== "archived");
  const portfolio = business.portfolio || null;
  return {
    profile: {
      business_name: business.business_name || "",
      full_name: business.full_name || "",
      city: business.city || "",
      license_number: business.license_number || "",
      logo_url: business.logo_url || null,
    },
    portfolio: portfolio ? { ...portfolio, url: `/${portfolio.slug}` } : null,
    pages: pages.map((p) => ({
      page_id: p.page_id,
      title: p.property?.title || "",
      address: p.property?.address || "",
      status: p.status,
      public_slug: p.public_slug,
      portfolio_visible: p.portfolio_visible ?? true,
      portfolio_rank: p.portfolio_rank ?? null,
    })),
  };
}

/* → { portfolio_url } | null when the agent has no business doc. Throws "slug_taken". */
async function savePortfolio(phone, body) {
  const business = await db.getBusiness(phone);
  if (!business) return null;
  const existing = business.portfolio || {};

  // Business name change → slug reservation
  const newBizName = body.business_name?.trim() || business.business_name;
  let newSlug = existing.slug;
  if (newBizName !== business.business_name && existing.slug) {
    newSlug = portfolioSlug(newBizName);
    await db.reservePortfolioSlug(phone, newSlug, existing.slug);
  }

  const normalized = normalizePortfolio(body.portfolio || {}, existing);
  normalized.slug = newSlug || existing.slug;
  normalized.status = existing.status || "draft";

  await db.setBusiness(phone, {
    business_name: newBizName,
    full_name: body.full_name?.trim() || business.full_name,
    city: body.city?.trim() || business.city,
    license_number: body.license_number?.trim() || business.license_number,
    logo_url: body.logo_url ?? business.logo_url,
    portfolio: normalized,
  }, true);
  businessCache.invalidate(phone);

  // Page visibility/rank, only for this agent's own pages
  if (Array.isArray(body.portfolio?.properties)) {
    const pages = await db.listPagesByPhone(phone, 100);
    const pageMap = new Map(pages.map((p) => [p.page_id, p]));
    for (const prop of body.portfolio.properties) {
      if (!prop.page_id || !pageMap.has(prop.page_id)) continue;
      await db.updatePage(prop.page_id, {
        portfolio_visible: prop.portfolio_visible ?? true,
        portfolio_rank: prop.portfolio_rank ?? null,
      });
    }
  }
  return { portfolio_url: `/${normalized.slug}` };
}

/* → { created, portfolio_url }. Throws "slug_taken". */
async function createPortfolio(phone) {
  let business = await db.getBusiness(phone);
  if (!business) {
    await db.setBusiness(phone, { phone, created_at: new Date() }, true);
    businessCache.invalidate(phone);
    business = { phone };
  }
  if (business.portfolio?.slug) return { created: false, portfolio_url: `/${business.portfolio.slug}` };
  const slug = portfolioSlug(business.business_name || business.full_name || phone);
  await db.reservePortfolioSlug(phone, slug);
  const now = new Date();
  await db.setBusiness(phone, {
    portfolio: {
      slug,
      status: "open",
      hero: { headline: "", intro: "", portrait_url: null },
      about: { body: "" },
      area: { headline: "", body: "", locations: [] },
      testimonials: [],
      theme: { primary: null, accent: null, font_url: null },
      created_at: now,
      updated_at: now,
    },
  }, true);
  businessCache.invalidate(phone);
  return { created: true, portfolio_url: `/${slug}` };
}

module.exports = { getPortfolio, savePortfolio, createPortfolio };
