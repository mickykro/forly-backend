/**
 * portfolio-render.js — server-side portfolio HTML rendering for SEO.
 * ponytail: pure functions, no Firestore access.
 */

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Render portfolio metadata and initial content into an HTML template.
 * @param {string} template - HTML string with <!--PORTFOLIO_HEAD--> and <!--PORTFOLIO_BODY--> markers
 * @param {object} data - { canonical_url, agent, portfolio, properties }
 * @returns {string} - rendered HTML
 */
function renderPortfolioDocument(template, data) {
  const { canonical_url, agent, portfolio, properties } = data;
  const title = escapeHtml(agent.brand_name || agent.name || "נכסים");
  const description = escapeHtml(portfolio?.hero?.intro || `נכסים של ${agent.name || agent.brand_name}`).slice(0, 155);
  const locations = (portfolio?.area?.locations || []).slice(0, 5).map(escapeHtml).join(", ");

  // Open Graph
  const ogImage = agent.logo_url || portfolio?.hero?.portrait_url || "";

  // JSON-LD RealEstateAgent schema
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "RealEstateAgent",
    "name": agent.brand_name || agent.name || "",
    "description": portfolio?.hero?.intro || "",
    "url": canonical_url,
    "areaServed": (portfolio?.area?.locations || []).map((loc) => ({
      "@type": "City",
      "name": loc,
    })),
  };
  if (agent.logo_url) jsonLd.image = agent.logo_url;
  if (agent.license) jsonLd.identifier = agent.license;

  // Property cards for initial render
  const propertyCards = (properties || []).map((p) => `
    <a href="${escapeHtml(p.url)}" class="property-card">
      ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.title)}" loading="lazy">` : ""}
      <h3>${escapeHtml(p.title)}</h3>
      <p>${escapeHtml(p.city)}${p.neighborhood ? `, ${escapeHtml(p.neighborhood)}` : ""}</p>
      ${p.price ? `<p class="price">${formatPrice(p.price, p.listing_type)}</p>` : ""}
    </a>
  `).join("");

  const head = `
    <title>${title}</title>
    <meta name="description" content="${description}">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${escapeHtml(canonical_url)}">
    <meta property="og:type" content="website">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${escapeHtml(canonical_url)}">
    ${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : ""}
    <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>
  `;

  const body = `
    <div id="portfolio-seo-content">
      <h1>${title}</h1>
      ${portfolio?.hero?.intro ? `<p>${escapeHtml(portfolio.hero.intro)}</p>` : ""}
      ${locations ? `<p>אזורי פעילות: ${locations}</p>` : ""}
      <div class="property-grid">${propertyCards}</div>
    </div>
  `;

  return template
    .replace("<!--PORTFOLIO_HEAD-->", head)
    .replace("<!--PORTFOLIO_BODY-->", body);
}

function formatPrice(price, listingType) {
  if (!price) return "";
  const formatted = new Intl.NumberFormat("he-IL").format(price);
  return listingType === "rent" ? `₪${formatted}/חודש` : `₪${formatted}`;
}

/**
 * Render XML sitemap for open portfolios.
 * @param {string[]} urls - array of canonical URLs
 * @returns {string} - XML sitemap
 */
function renderSitemap(urls) {
  const urlElements = urls.map((u) =>
    `  <url><loc>${escapeHtml(u)}</loc></url>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlElements}
</urlset>`;
}

module.exports = {
  renderPortfolioDocument,
  renderSitemap,
  escapeHtml,
};
