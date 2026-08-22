/*
 * og.js — server-rendered Open Graph / Twitter meta tags for /p/:id.
 *
 * Facebook and WhatsApp crawlers don't execute JS, so a shared page link
 * previews blank without these. Built server-side for ACTIVE pages only (the
 * caller decides); values are HTML-escaped, and inject() uses a function
 * replacement so "$&" in a listing title can't corrupt the document.
 */

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function description(page) {
  const p = (page && page.property) || {};
  const facts = [];
  if (Number(p.rooms) > 0) facts.push(`${p.rooms} חדרים`);
  if (Number(p.size_sqm) > 0) facts.push(`${p.size_sqm} מ"ר`);
  if (Number(p.price) > 0) facts.push(`₪${Number(p.price).toLocaleString("en-US")}`);
  const loc = [p.neighborhood, p.city].filter(Boolean).join(", ");
  const agent = (page.agent && page.agent.name) || "";
  return [loc, facts.join(" · "), agent].filter(Boolean).join(" | ");
}

// The share-preview headline: built from the facts ("4 חדרים בבבלי, תל אביב
// · למכירה") rather than the page's internal title, falling back to it only
// when there are no facts to build from.
function ogTitle(page) {
  const p = (page && page.property) || {};
  const loc = [p.neighborhood, p.city].filter(Boolean).join(", ");
  const bits = [];
  if (Number(p.rooms) > 0) bits.push(`${p.rooms} חדרים`);
  if (loc) bits.push(bits.length ? `ב${loc}` : loc);
  let t = bits.join(" ");
  if (t) t += p.listing_type === "rent" ? " · להשכרה" : " · למכירה";
  return t || p.title || "נכס למכירה";
}

// Preview image: a gallery photo first (what the product owner wants shown),
// the video poster only as fallback.
function ogImage(page) {
  const imgs = (page && page.gallery && Array.isArray(page.gallery.images))
    ? page.gallery.images : [];
  return (imgs[0] && imgs[0].url) || ((page && page.hero) || {}).poster_url || null;
}

function buildOgTags(page, pageUrl) {
  const hero = (page && page.hero) || {};
  const title = ogTitle(page);
  const image = ogImage(page);
  const tag = (attr, name, content) =>
    content ? `<meta ${attr}="${esc(name)}" content="${esc(content)}">` : "";
  const lines = [
    tag("property", "og:type", "website"),
    tag("property", "og:title", title),
    tag("property", "og:description", description(page)),
    tag("property", "og:url", pageUrl),
    tag("property", "og:image", image),
    tag("property", "og:video", hero.video_url),
    hero.video_url ? tag("property", "og:video:type", "video/mp4") : "",
    tag("name", "twitter:card", image ? "summary_large_image" : "summary"),
    tag("name", "twitter:title", title),
    tag("name", "twitter:image", image),
  ];
  return lines.filter(Boolean).join("\n");
}

function inject(html, page, pageUrl) {
  const tags = buildOgTags(page, pageUrl);
  // Function replacement: a "$&" inside a title is content, not a pattern.
  return html.replace("</head>", () => `${tags}\n</head>`);
}

module.exports = { buildOgTags, inject, ogTitle, ogImage };
