# Agent Portfolios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents a public, editable portfolio at `/{agent-slug}` containing a filterable property dashboard; selecting a property opens its own page at `/{agent-slug}/{property-slug}` with the existing controlled lead flow.

**Architecture:** The Express server is the sole backend authority, while the existing Firebase Hosting `nadlan` target remains the static deployment target and 301 gateway to `nadlan.call4li.com`. Store portfolio configuration on `businesses/{phone}` and reserve every current and historical agent slug in `portfolio_slugs/{slug}` so renames produce permanent redirects. Keep per-property public visibility, ordering, and nested-path slug on `property_pages`; the portfolio reader loads at most 100 pages for one business and filters them in memory, avoiding a new Firestore composite index.

**Tech Stack:** Express 4, Node 20+, Firebase Hosting for `public-nadlan`, Firestore through `firebase-admin`, the existing local/public upload service, and vanilla HTML/CSS/JavaScript.

## Global Constraints

- Keep existing `/p/{page_id}` links working as permanent `301` redirects to the nested property URL.
- Generate portfolio and property slugs with ASCII Hebrew transliteration; never expose encoded Hebrew route segments.
- Create a portfolio automatically when the agent's second property page becomes active, or earlier when the agent clicks “Create portfolio” in the dashboard. Once created, it remains public with a general contact form when no properties are visible.
- An agent can edit hero/profile/about/area content, portrait, testimonials, property visibility, and property order; empty optional sections are omitted from the public page.
- Portfolio contact leads reuse `leads` and `lead_submissions`, use source `portfolio`, have `listing_id: null`, and retain `agent_phone`.
- Listings are visible by default only when their property page is `active` or `expiring`; the agent may hide an otherwise active listing.
- Admins alone can change a created portfolio between `open` and `closed`; a closed portfolio returns `404`, while its individual nested property pages remain public. Property pages omit the portfolio link unless the portfolio is open.
- Public portfolio pages ship with `index,follow`: search engines may list each open portfolio and crawl its property links. Draft and closed portfolios return `404` and must not emit indexable portfolio content.
- Render portfolio title, description, canonical URL, Open Graph tags, visible property links, and `RealEstateAgent` JSON-LD on the server; include open portfolios in `/sitemap.xml`.
- Show the testimonial legal warning before an agent saves testimonials. Testimonials publish immediately and are agent-provided content.
- Restrict portrait upload to JPEG, PNG, or WebP with a 10 MB maximum; use the existing authenticated `/api/upload-urls` flow.
- Do not add a new database, search provider, analytics product, custom domain system, or background-removal service.
- Keep the existing Firebase Hosting `nadlan` target and its broad 301 redirect to `https://nadlan.call4li.com/:path*`; do not create portfolio Firebase Functions or new Function rewrites.
- Treat `docs/agent-portfolio-example.html` as the visual source of truth for the public portfolio. Production must reproduce that composition, typography, spacing, colors, portrait treatment, cards, sections, contact form, modal, and responsive behavior; do not replace it with a generic dashboard design.

---

## File Structure

- Create: `server/portfolio.js` — standalone pure helpers for slug construction, portfolio normalization, and public-page filtering.
- Create: `server/portfolio.test.js` — Node assertions for the standalone pure helpers.
- Create: `server/portfolio-render.js` — escaped server-side portfolio metadata, initial content, and JSON-LD rendering.
- Create: `server/scripts/backfill-portfolios.js` — idempotent Firestore migration for current businesses, pages, and historical route mappings.
- Create: `public-nadlan/portfolio/index.html` — buyer-facing RTL portfolio shell.
- Create: `public-nadlan/portfolio/portfolio.css` — responsive portfolio styling using supplied dynamic portfolio colors/fonts with safe defaults.
- Create: `public-nadlan/portfolio/portfolio.js` — API loading, filterable property-dashboard rendering, lead submission, and `index,follow` metadata.
- Create: `public-nadlan/portfolio/fonts/Discovery_Fs-Light.woff` and `public-nadlan/portfolio/fonts/Discovery_Fs-Bold.woff` — production copies of the supplied prototype fonts.
- Create: `public-agent/portfolio.html` — authenticated portfolio editor page.
- Create: `public-agent/portfolio.js` — editor state, uploads, save, testimonial warning, visibility/order controls.
- Modify: `server/db.js` — portfolio slug reservation helpers and page list/read helpers needed by Express.
- Modify: `server/routes/pages.js` — assign public property slugs, add portfolio context to property payloads, redirect legacy `/p/:id`, and accept portfolio leads.
- Modify: `server/routes/dashboard.js` — expose portfolio URL/settings and portfolio fields on property cards.
- Modify: `server/routes/admin.js` — add admin portfolio status action and portfolio URL/status to agent records.
- Modify: `server/leads.js` and `server/leads.test.js` — allow a lead submission with no property page while preserving existing property-lead behavior.
- Modify: `server/index.js` — serve the portfolio shell/editor and register portfolio routes.
- Modify: `server/package.json` — include portfolio rendering tests in `npm test`.
- Verify: `firebase.json` — retain the `nadlan` Hosting target, `public-nadlan` directory, cache headers, and 301 redirect to the Express-served branded domain.
- Modify: `public-agent/index.html` and `public-agent/admin.html` — add a portfolio entry point and current public URL.
- Modify: `public-nadlan/p/page.js` and `public-nadlan/p/index.html` — resolve nested property routes and show the “all agent properties” link.

## Data Contract

Use this persisted structure on `businesses/{business_phone}`:

```ts
type PortfolioStatus = "draft" | "open" | "closed";

interface PortfolioConfig {
  slug: string;
  status: PortfolioStatus;
  hero: { headline: string; intro: string; portrait_url: string | null };
  about: { body: string };
  area: { headline: string; body: string; locations: string[] };
  testimonials: Array<{ id: string; quote: string; attribution: string }>;
  theme: { primary: string | null; accent: string | null; font_url: string | null };
  created_at: Date;
  updated_at: Date;
}
```

Add these fields to every `property_pages/{page_id}` document:

```ts
interface PublicPropertyFields {
  public_slug: string;             // e.g. "vyt23-a7k"
  portfolio_visible: boolean;      // true by default for a new active page
  portfolio_rank: number | null;   // null means newest-first after ranked pages
}
```

Use `portfolio_slugs/{slug}` as an immutable route reservation:

```ts
interface PortfolioSlugReservation {
  business_phone: string;
  current_slug: string;
  created_at: Date;
}
```

An old slug document points to the same business and its new `current_slug`, allowing `301` redirects without making old names reusable.

## Public Portfolio UI/UX Specification

### Visual Source of Truth

Implement the public page to match `docs/agent-portfolio-example.html`. The prototype is not conceptual inspiration: it is the required visual contract. Move its markup and CSS into `public-nadlan/portfolio/index.html` and `public-nadlan/portfolio/portfolio.css`, replacing demonstration values with escaped portfolio data without redesigning the page. Preserve its square corners, restrained motion, generous whitespace, RTL editorial composition, and warm real-estate brand character.

Use the supplied local font files in production:

```css
@font-face {
  font-family: "Discovery";
  src: url("/portfolio/fonts/Discovery_Fs-Light.woff") format("woff");
  font-weight: 300 500;
  font-display: swap;
}
@font-face {
  font-family: "Discovery";
  src: url("/portfolio/fonts/Discovery_Fs-Bold.woff") format("woff");
  font-weight: 600 800;
  font-display: swap;
}
```

Discovery is the page typeface for headings and body copy. Use the browser sans-serif fallback only while it loads. Buttons and form controls may use the same Discovery face; do not introduce Inter, Roboto, Arial, a remote font, rounded cards, gradients unrelated to the prototype, or an alternate dark-mode treatment.

### Theme Tokens

The prototype palette is the safe default and the reference appearance for Kroitoro Properties:

```css
:root {
  --ink: #3f2819;
  --paper: #fffcf6;
  --sand: #f3e4cd;
  --sage: #98622f;
  --gold: #c48135;
  --muted: #846d5b;
  --line: #eadcc9;
}
```

Map `portfolio.theme.primary` to `--ink` and `portfolio.theme.accent` to `--gold`; derive `--sage`, `--sand`, `--muted`, and `--line` server-side from those values while preserving the prototype's contrast relationships. Missing or invalid theme colors use the exact defaults above. Validate that normal text reaches WCAG AA contrast; when an agent selects an unsafe color, adjust only the rendered tonal derivative rather than changing the stored value. The hero keeps the prototype's radial warm highlight over its paper-to-sand diagonal gradient, recolored through the derived tokens.

### Desktop Composition

- Keep the page `lang="he" dir="rtl"`, with a centered `1160px` maximum content width and `20px` side gutters.
- Header: `76px` high, transparent paper background, thin bottom rule, brand at the right and the single “יצירת קשר” anchor at the left. Show the uploaded logo when available; otherwise show the circular 38px brand mark containing the first character of `business_name`.
- Hero: use the exact two-column `1.15fr / .85fr` grid, `56px` gap, and `75px 0 56px` padding. The copy column contains eyebrow, large two-line headline with its emphasized phrase in the accent color, intro, primary “לנכסים שלנו” CTA, and outlined “דברו איתנו” CTA.
- Agent portrait: retain the prototype's rectangular editorial frame, minimum `545px` height, warm fallback background, and offset lower-left shadow. Render the uploaded portrait edge-to-edge with `object-fit: cover`, `object-position: center 22%`, and the same subtle saturation/contrast filter. Do not crop it into a circle and do not run background removal.
- Portrait overlay: preserve the bottom dark gradient, 22px inset, circular 58px logo, business name, agent name, licence number, and two-column definition list for area, property types, response, and accompaniment. All values come from portfolio/business data; omit an individual empty value without leaving an empty label.
- Properties: preserve `76px 0 90px` spacing, the large section title and active count, and a three-column grid with `20px` gaps. Cards remain white, square-cornered, with a one-pixel line border, 245px image, deal tag, location, title, three metadata values, and price in that order. Hover lifts the card by 5px, adds the prototype shadow, and scales only the image to `1.04` over 500ms.
- About: preserve the full-width sand background, `84px` vertical padding, `.9fr / 1.1fr` columns, and `80px` gap. The right-side title block has the 2px accent top rule; the copy column contains body paragraphs followed by the three-part credentials row for area, licence, and personal service.
- Testimonials: preserve the paper background, `84px` vertical padding, heading treatment, and three-column quote grid. Each square-cornered quote card has a minimum height of 250px, accent quotation mark, body, and attribution. Render at most three testimonials in the initial row and continue additional items in the same three-column grid.
- Contact: preserve the dark `--ink` full-width band, `72px` vertical padding, equal two-column grid, oversized heading, supporting text, and transparent outlined inputs. The submit button uses the warm accent fill and dark text.
- Footer: retain the compact centered-width line with business name, rights text, and “נבנה באמצעות Forly”.

### Property Filters and States

The filter controls are the only production addition not pictured in the static prototype. Place them inside the properties section between `.section-head` and `.grid`, so they do not create a separate dashboard-style panel. Use square-cornered paper inputs with `1px solid var(--line)`, Discovery text, and an accent focus border. Provide text search plus deal type, city/neighborhood, price, rooms, and size controls; on narrow screens collapse advanced controls behind “סינון נכסים”. Updating filters changes the visible count immediately without navigation and announces the count through an `aria-live="polite"` element.

Initially render six matching cards and use the prototype's centered outlined “לטעינת נכסים נוספים” button to reveal six more. Hide the button when every matching property is visible. A zero-result filter state stays inside the properties section, explains that no matching properties were found, and offers “ניקוי סינון” plus the contact CTA. An open portfolio with no visible properties renders the same section heading followed by a general contact prompt; it must not display sample cards.

### Conditional Sections and Content Mapping

- Header brand: `agent.logo_url`, `agent.brand_name`.
- Hero copy: `portfolio.hero.headline`, `portfolio.hero.intro`; use localized defaults only when those fields have never been configured.
- Portrait panel: `portfolio.hero.portrait_url`, `agent.logo_url`, `agent.name`, `agent.license`, `portfolio.area`, and the deal types represented by visible properties.
- Property cards: first property image, deal type, neighborhood/city, title, rooms, size, one additional useful attribute, and localized price. Each entire card links to `/{agentSlug}/{propertySlug}`.
- About: render only when `portfolio.about.body`, area, licence, or another credential exists. Do not render an empty colored band.
- Testimonials: render only when at least one saved testimonial exists. Never ship the prototype's demonstration quotes as fallback content.
- Contact and footer: always render for an open portfolio, including when there are no properties.

### Interaction and Responsive Behavior

Smooth-scroll internal anchors. Both hero contact CTA and zero-result contact CTA open the prototype modal; the bottom contact form stays inline. The modal uses the same paper panel over a dark brown translucent overlay, closes from its button, outside click, or `Escape`, traps focus while open, and restores focus to its opener. Disable a submitted form while pending, show an inline localized success state on success, and retain entered values with an inline error on failure.

At `760px` and below, exactly follow the prototype's mobile transformation: content gutters become 14px, header height becomes 64px, hero/about/contact grids become one column with 40px gaps, portrait height becomes at least 470px, property and testimonial grids become one column, section headings stack, property images become 260px high, and about/testimonial vertical padding becomes 60px. Keep CTAs large enough for touch, prevent horizontal scrolling at 320px width, preserve RTL reading order, and lazy-load below-the-fold property images without lazy-loading the hero portrait.

### Visual Acceptance

Capture production screenshots at `1440x1000`, `768x1024`, and `390x844` using the same Kroitoro fixture data as the prototype. Compare them side by side with `docs/agent-portfolio-example.html`. Acceptance requires the same section order, content hierarchy, typography, palette, column proportions, portrait treatment, card anatomy, and mobile stacking; dynamic filters may add height only inside the properties section. Functional correctness alone is not sufficient if the result visibly departs from the prototype.

## Public API Contract

```ts
GET  /api/portfolio?slug={agentSlug}
// 200: { portfolio, agent, properties, canonical_url }
// 301: Location: /{currentSlug} when slug is historical
// 404: unknown, draft, or closed portfolio

GET  /api/property-by-slug?portfolio_slug={agentSlug}&property_slug={propertySlug}
// 200: existing property-page payload plus { portfolio_url, property_url }
// 301: Location: /{currentSlug}/{propertySlug} when the portfolio slug is historical
// 404: unknown, archived, or inactive property page; portfolio status does not close a property

POST /api/portfolio-lead
// body: { slug, name, phone, message? }
// 200: { ok: true }; rate limited submissions intentionally return the same body

GET  /api/my-portfolio
POST /api/my-portfolio
// session-authenticated; POST body is the validated editable PortfolioConfig subset

POST /api/my-portfolio/create
// session-authenticated; creates a portfolio before the automatic second-property threshold

POST /api/admin/portfolio-status
// admin-session body: { business_phone, status: "open" | "closed" }
```

### Task 1: Define Slug and Portfolio Normalization Rules

**Files:**
- Create: `server/portfolio.js`
- Create: `server/portfolio.test.js`

**Interfaces:**
- Consumes: `business_name`, `full_name`, listing address, and existing property-page status.
- Produces: `portfolioSlug(value: string): string`, `propertySlug(address: string, code: string): string`, `normalizePortfolio(input: unknown, existing: PortfolioConfig): PortfolioConfig`, and `visiblePortfolioPages(pages: PropertyPage[]): PropertyPage[]`.

- [ ] **Step 1: Write failing standalone helper tests**

```js
const assert = require("assert");
const { portfolioSlug, propertySlug, visiblePortfolioPages } = require("./portfolio");

assert.equal(portfolioSlug("קרויטורו נכסים"), "kroitoro-nehasim");
assert.equal(propertySlug("ויצמן 23", "a7k"), "vyt23-a7k");
assert.equal(propertySlug("רחוב ללא מספר", "a7k"), "property-a7k");
assert.deepEqual(
  visiblePortfolioPages([
    { status: "active", portfolio_visible: true, portfolio_rank: 2 },
    { status: "archived", portfolio_visible: true, portfolio_rank: 1 },
    { status: "active", portfolio_visible: false, portfolio_rank: 0 },
  ]).map((p) => p.portfolio_rank),
  [2]
);
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run: `node server/portfolio.test.js`

Expected: failure because `server/portfolio.js` does not exist.

- [ ] **Step 3: Implement deterministic normalization and route-safe slugs**

```js
function propertySlug(address, code) {
  const latin = transliterate(String(address || "")).replace(/[^a-z0-9 ]/g, " ");
  const words = latin.trim().split(/\s+/).filter(Boolean);
  const number = words.find((word) => /^\d+$/.test(word)) || "";
  const street = words.filter((word) => !/^\d+$/.test(word)).join("").slice(0, 3);
  return `${street || "property"}${number}-${code}`;
}

function visiblePortfolioPages(pages) {
  return pages.filter((page) =>
    (page.status === "active" || page.status === "expiring") && page.portfolio_visible !== false
  ).sort((a, b) => (a.portfolio_rank ?? Infinity) - (b.portfolio_rank ?? Infinity));
}
```

Use a lowercase `[a-z0-9-]` result, collapse duplicate hyphens, cap agent slugs at 60 characters, cap property slugs at 48 characters, and reject reserved first segments: `api`, `p`, `portfolio`, `legal`, `assets`, `favicon.ico`.

- [ ] **Step 4: Run validation**

Run: `node server/portfolio.test.js`

Expected: all helper assertions pass.

- [ ] **Step 5: Commit**

```bash
git add server/portfolio.js server/portfolio.test.js
git commit -m "feat: define portfolio data and slug rules"
```

### Task 2: Persist Portfolio Settings, Route Reservations, and One-Time Backfill

**Files:**
- Modify: `server/db.js`
- Modify: `server/routes/pages.js`
- Create: `server/scripts/backfill-portfolios.js`

**Interfaces:**
- Consumes: Task 1 slug helpers; existing `businesses`, `listings`, and `property_pages` collections.
- Produces: `ensurePortfolioSlug(phone, business)`, `nextPortfolioStatus(currentStatus, activePageCount)`, `maybeOpenPortfolio(phone, activePageCount)`, `reservePortfolioSlug(phone, desiredSlug)`, `ensurePublicPropertyFields(page)`, and the `portfolio_slugs` collection.

- [ ] **Step 1: Write failing reservation and rename tests in `server/portfolio.test.js`**

```js
assert.equal(reservationTarget({ current_slug: "new-name" }), "new-name");
assert.throws(
  () => assertSlugAvailable({ "taken-name": { business_phone: "972500000000" } }, "taken-name", "972599999999"),
  /slug_taken/
);
assert.doesNotThrow(
  () => assertSlugAvailable({ "taken-name": { business_phone: "972500000000" } }, "taken-name", "972500000000")
);
assert.equal(nextPortfolioStatus("draft", 1), "draft");
assert.equal(nextPortfolioStatus("draft", 2), "open");
assert.equal(nextPortfolioStatus("closed", 3), "closed");
```

- [ ] **Step 2: Run the test and verify the reservation exports are absent**

Run: `node server/portfolio.test.js`

Expected: failure mentioning `reservationTarget` or `assertSlugAvailable`.

- [ ] **Step 3: Add atomic reservation behavior**

Reserve a slug in a Firestore transaction before changing `businesses/{phone}.portfolio.slug`.

```js
await db.runTransaction(async (tx) => {
  const nextRef = db.collection("portfolio_slugs").doc(nextSlug);
  const next = await tx.get(nextRef);
  if (next.exists && next.get("business_phone") !== phone) throw new Error("slug_taken");
  tx.set(nextRef, {business_phone: phone, current_slug: nextSlug, created_at: now}, {merge: true});
  if (oldSlug && oldSlug !== nextSlug) {
    tx.set(db.collection("portfolio_slugs").doc(oldSlug),
      {business_phone: phone, current_slug: nextSlug, created_at: now}, {merge: true});
  }
  tx.set(db.collection("businesses").doc(phone), {"portfolio.slug": nextSlug}, {merge: true});
});
```

When a property page is first created, generate a three-character base-30 suffix, set `public_slug`, `portfolio_visible: true`, and `portfolio_rank: null`. Do not regenerate `public_slug` when the property address changes; the stable suffix protects existing sharing links.

The first active property reserves the agent slug and creates default portfolio configuration with `status: "draft"`; its nested property URL is immediately usable. After saving the second active property, count active/expiring pages for the business and atomically change `portfolio.status` from `draft` to `open`. Never reopen a portfolio whose status is `closed`; only the admin action may reopen it. `POST /api/my-portfolio/create` changes `draft` to `open` at any property count, including zero.

- [ ] **Step 4: Implement the idempotent backfill script**

```js
for (const [phone, ownedPages] of pagesByBusiness) {
  const business = businessByPhone.get(phone);
  const slug = business.portfolio?.slug || portfolioSlug(business.business_name || business.full_name);
  const activeCount = ownedPages.filter((page) => page.status === "active" || page.status === "expiring").length;
  await ensurePortfolioAndReservation(phone, business, slug, activeCount >= 2 ? "open" : "draft");
  for (const page of ownedPages) await ensurePagePublicFields(page.ref, page.data());
}
```

Businesses with no property pages remain unchanged until the agent clicks “Create portfolio.” The script must accept `--dry-run`, print `{ businessesScanned, portfoliosChanged, pagesScanned, pagesChanged, collisions }`, and refuse to write when any collision exists. The real run must be executed with Firebase Admin credentials against the production project only after the dry-run has zero collisions.

- [ ] **Step 5: Run validation**

Run: `node server/portfolio.test.js && node server/scripts/backfill-portfolios.js --dry-run`

Expected: tests pass; dry run reports counts and no writes.

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/routes/pages.js server/scripts/backfill-portfolios.js server/portfolio.test.js
git commit -m "feat: persist portfolio routes and property slugs"
```

### Task 3: Public Portfolio, Nested Property Resolution, and Legacy Redirects

**Files:**
- Modify: `server/routes/pages.js`
- Modify: `server/index.js`
- Create: `public-nadlan/portfolio/index.html`
- Create: `public-nadlan/portfolio/portfolio.css`
- Create: `public-nadlan/portfolio/portfolio.js`
- Create: `public-nadlan/portfolio/fonts/Discovery_Fs-Light.woff`
- Create: `public-nadlan/portfolio/fonts/Discovery_Fs-Bold.woff`
- Create: `server/portfolio-render.js`
- Modify: `server/package.json`
- Modify: `public-nadlan/p/index.html`
- Modify: `public-nadlan/p/page.js`
- Verify: `firebase.json`

**Interfaces:**
- Consumes: `GET /api/portfolio`, `GET /api/property-by-slug`, and `PortfolioConfig` from Tasks 1-2.
- Produces: buyer pages at `/{agentSlug}` and `/{agentSlug}/{propertySlug}`, server-rendered portfolio SEO, `/sitemap.xml`, and permanent redirects from `/p/{pageId}` and historical portfolio slugs.

- [ ] **Step 1: Write failing route resolution tests**

```js
assert.deepEqual(
  parsePublicPath("/kroitoro-nehasim/vyt23-a7k"),
  { kind: "property", portfolioSlug: "kroitoro-nehasim", propertySlug: "vyt23-a7k" }
);
assert.deepEqual(parsePublicPath("/kroitoro-nehasim"), { kind: "portfolio", portfolioSlug: "kroitoro-nehasim" });
assert.equal(parsePublicPath("/api/portfolio"), null);
const { renderPortfolioDocument, renderSitemap } = require("./portfolio-render");
const template = '<html lang="he"><head><!--PORTFOLIO_HEAD--></head><body><!--PORTFOLIO_BODY--></body></html>';
const html = renderPortfolioDocument(template, {
  canonical_url: "https://nadlan.call4li.com/kroitoro-nehasim",
  agent: { name: "מיקי קרויטורו", brand_name: "קרויטורו נכסים", city: "כפר סבא" },
  portfolio: { hero: { intro: "ליווי אישי בכפר סבא" }, area: { locations: ["כפר סבא"] } },
  properties: [{ title: "דירה ברחוב ויצמן", url: "/kroitoro-nehasim/vyt23-a7k" }],
});
assert.match(html, /<meta name="robots" content="index,follow">/);
assert.match(html, /<link rel="canonical" href="https:\/\/nadlan\.call4li\.com\/kroitoro-nehasim">/);
assert.match(html, /RealEstateAgent/);
assert.match(html, /\/kroitoro-nehasim\/vyt23-a7k/);
const sitemap = renderSitemap(["https://nadlan.call4li.com/kroitoro-nehasim"]);
assert.match(sitemap, /<loc>https:\/\/nadlan\.call4li\.com\/kroitoro-nehasim<\/loc>/);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node server/portfolio.test.js`

Expected: failure because `parsePublicPath` is not exported.

- [ ] **Step 3: Implement public readers and resolvers**

`GET /api/portfolio` loads `portfolio_slugs/{slug}`, resolves a historical slug with HTTP `301`, reads the owning business, rejects any portfolio whose status is not `open`, then reads up to 100 property pages by `business_phone` and applies `isVisiblePortfolioPage` for the filterable dashboard.

```js
res.json({
  canonical_url: `${pageBaseUrl}/${portfolio.slug}`,
  agent: { name: business.full_name || "", brand_name: business.business_name || "", logo_url: business.logo_url || null, city: business.city || "", license: business.license_number || "" },
  portfolio,
  properties: pages.map((page) => ({
    title: page.property.title,
    property_slug: page.public_slug,
    url: `${pageBaseUrl}/${portfolio.slug}/${page.public_slug}`,
    listing_type: page.property.listing_type,
    city: page.property.city,
    neighborhood: page.property.neighborhood,
    price: page.property.price,
    rooms: page.property.rooms,
    size_sqm: page.property.size_sqm,
    image_url: page.gallery.images[0]?.url || page.hero.poster_url || null,
  })),
});
```

`GET /api/property-by-slug` must return the existing full property payload after checking that the page belongs to the business resolved by the agent slug and is active/expiring. It must not check `portfolio_visible` or portfolio status: those fields control the portfolio dashboard, not the property page itself. Add `portfolio_url` only when the portfolio is open, and always add the canonical nested `property_url`. `GET /p/:pageId` must look up its page and return `301 Location: /{currentPortfolioSlug}/{page.public_slug}`; preserve the query string only when it has no `edit` token.

- [ ] **Step 4: Render indexable portfolio documents and register Express routes**

Register these routes after `/api/*`, `/legal/*`, static assets, and explicit dashboard routes, but before the final 404 handler:

```js
router.get("/p/:pageId", redirectLegacyProperty);
router.get("/:agentSlug/:propertySlug", servePropertyShell);
router.get("/robots.txt", serveRobots);
router.get("/sitemap.xml", serveSitemap);
router.get("/:agentSlug", renderPortfolioPage);
```

Reject reserved first segments with Task 1's parser before serving either shell. `renderPortfolioPage` must call the same `loadPublicPortfolio(slug)` service as `GET /api/portfolio`, inject escaped title/description/canonical/Open Graph values, serialize the payload with `<` escaped as `\u003c`, emit `RealEstateAgent` JSON-LD, and include ordinary `<a href>` property cards in the initial HTML. This ensures useful search content exists before JavaScript runs. `portfolio.js` then hydrates that payload and provides interactive filters.

Update `public-nadlan/p/page.js` to parse two route segments and call `/api/property-by-slug`; retain `?id=` loading for local test tooling. Add a prominent portfolio link in the property header and agent strip that uses `portfolio_url`.

Build the public portfolio by extracting the HTML structure and CSS rules from `docs/agent-portfolio-example.html`, not from a blank template. Copy the supplied Discovery WOFF files from `docs/assets/` into `public-nadlan/portfolio/fonts/`, preserve all class-level styling described in **Public Portfolio UI/UX Specification**, and replace only hard-coded demonstration content with escaped server data and client rendering hooks. Add the specified filter row between `.section-head` and `.grid`; this is the only intentional structural addition to the prototype. The portfolio document must use `dir="rtl"`, emit `<meta name="robots" content="index,follow">`, render property-card anchors to nested pages in the initial HTML, omit empty optional sections, and show the designed empty-state contact prompt when the property array is empty.

`/sitemap.xml` must list current URLs for every open portfolio and every active/expiring property page, use XML escaping, and cache for 15 minutes. `/robots.txt` must allow crawling and advertise `https://nadlan.call4li.com/sitemap.xml`. Historical slugs must never appear in the sitemap.

Keep the existing `firebase.json` `hosting[target=nadlan]` configuration. Its `/:path*` redirect must continue forwarding Firebase-hosted URLs to the branded Express domain, preserving the full portfolio or property path. Do not add `/api/portfolio`, `/api/property-by-slug`, or `/api/portfolio-lead` Function rewrites.

- [ ] **Step 5: Run automated validation**

Run: `node server/portfolio.test.js && npm --prefix server test`

Expected: all tests pass. Start `npm --prefix server run local`, then confirm the portfolio and nested property shells load and `/p/{knownPageId}` returns `301`.

Open the Kroitoro fixture portfolio at desktop and mobile widths. Confirm the production page uses Discovery from local WOFF files, matches the prototype's section order and geometry, uses the uploaded portrait as an edge-to-edge rectangular hero image, and contains no demonstration testimonials or property data.

- [ ] **Step 6: Verify Firebase Hosting path preservation**

Run in terminal A: `firebase emulators:start --only hosting:nadlan`

Run in terminal B: `curl -I http://127.0.0.1:5000/kroitoro-nehasim/vyt23-a7k`

Expected: `301` with `Location: https://nadlan.call4li.com/kroitoro-nehasim/vyt23-a7k`. Stop the emulator after this check. No Firebase Function emulator is required.

- [ ] **Step 7: Commit**

```bash
git add server/routes/pages.js server/index.js server/portfolio-render.js server/portfolio.test.js server/package.json public-nadlan/portfolio public-nadlan/p/index.html public-nadlan/p/page.js
git commit -m "feat: serve public agent portfolios and nested property routes"
```

### Task 4: Portfolio Lead Capture and Event Attribution

**Files:**
- Modify: `server/leads.js`
- Modify: `server/leads.test.js`
- Modify: `server/routes/pages.js`
- Modify: `public-nadlan/portfolio/portfolio.js`

**Interfaces:**
- Consumes: resolved open portfolio, `normalizePhone`, and the existing lead throttle rule.
- Produces: `POST /api/portfolio-lead` and immutable `lead_submissions` records with `source: "portfolio"`.

- [ ] **Step 1: Write the failing generic lead test**

```js
await submitLead({
  context: { business_phone: "972500000000", agent: { name: "מיקי", brand_name: "קרויטורו נכסים" } },
  name: "ישראל ישראלי", phone: "972521234567", source: "portfolio", questions: [],
});
const submission = db.mem.leadSubmissions[0];
assert.equal(submission.source, "portfolio");
assert.equal(submission.listing_id, null);
assert.equal(submission.page_id, null);
assert.equal(submission.agent_phone, "972500000000");
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node server/leads.test.js`

Expected: failure because `submitLead` requires `page.page_id`.

- [ ] **Step 3: Generalize the shared server lead writer without changing property behavior**

```js
async function submitLead({ context, name, phone, source, questions }) {
  const page = context.page || null;
  const agent = page ? page.agent : context.agent;
  const agentPhone = page ? page.business_phone : context.business_phone;
  const ids = { page_id: page ? page.page_id : null, listing_id: page ? page.listing_id : null };
  // Persist leads/{phone} and lead_submissions with ids, then increment only when page exists.
}
```

The portfolio endpoint must validate `{ slug, name, phone, message? }`, resolve only an open portfolio, apply the same max-three-per-phone-per-hour rule, write `message` where storage supports it, and send the n8n payload with `source: "portfolio"`, `page_id: null`, `listing_id: null`, and the portfolio URL.

- [ ] **Step 4: Track portfolio page views separately**

Add `POST /api/portfolio-event` accepting only `view`, `filter_used`, and `lead_cta_click`. Write one daily metric document under `businesses/{phone}/portfolio_metrics/{YYYY-MM-DD}`. Never include raw visitor data in event documents.

- [ ] **Step 5: Run validation**

Run: `node server/leads.test.js && npm --prefix server test`

Expected: existing property-lead assertions still pass, the new portfolio lead assertion passes, and the full server suite exits `0`.

- [ ] **Step 6: Commit**

```bash
git add server/leads.js server/leads.test.js server/routes/pages.js public-nadlan/portfolio/portfolio.js
git commit -m "feat: capture portfolio leads and events"
```

### Task 5: Agent Portfolio Editor and Dashboard Entry Points

**Files:**
- Create: `public-agent/portfolio.html`
- Create: `public-agent/portfolio.js`
- Modify: `public-agent/index.html`
- Modify: `public-agent/api.js`
- Modify: `server/routes/dashboard.js`

**Interfaces:**
- Consumes: `GET/POST /api/my-portfolio`, `POST /api/my-portfolio/create`, existing `FLY.uploadFiles`, and dashboard property data.
- Produces: manual early portfolio creation, agent-only editor, `PortfolioConfig` updates, and `page_id` dashboard visibility/order updates.

- [ ] **Step 1: Write the failing editor-patch validation tests**

```js
assert.deepEqual(
  validatePortfolioPatch({ hero: { headline: "בית מתחיל בהקשבה" }, testimonials: [{ quote: "שירות נהדר", attribution: "דנה, כפר סבא" }] }),
  { hero: { headline: "בית מתחיל בהקשבה" }, testimonials: [{ id: "generated", quote: "שירות נהדר", attribution: "דנה, כפר סבא" }] }
);
assert.deepEqual(
  validatePortfolioPatch({ area: { headline: "מכירים את השרון", body: "התמחות מקומית", locations: ["כפר סבא", "רעננה"] } }).area.locations,
  ["כפר סבא", "רעננה"]
);
assert.throws(() => validatePortfolioPatch({ testimonials: Array(7).fill({ quote: "x", attribution: "y" }) }), /too_many_testimonials/);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node server/portfolio.test.js`

Expected: failure because `validatePortfolioPatch` is not exported.

- [ ] **Step 3: Implement authenticated editor APIs**

`GET /api/my-portfolio` returns the authenticated business profile, normalized portfolio settings, all property pages owned by the caller, their visibility/rank, and calculated current URLs.

`POST /api/my-portfolio` accepts only these fields and trims all strings:

```ts
{
  business_name?: string; full_name?: string; city?: string; license_number?: string;
  logo_url?: string | null;
  portfolio: {
    hero?: { headline?: string; intro?: string; portrait_url?: string | null };
    about?: { body?: string };
    area?: { headline?: string; body?: string; locations?: string[] };
    testimonials?: Array<{ id?: string; quote: string; attribution: string }>;
    theme?: { primary?: string | null; accent?: string | null; font_url?: string | null };
    properties?: Array<{ page_id: string; portfolio_visible: boolean; portfolio_rank: number | null }>;
  };
}
```

Limit hero headline to 120 characters, hero intro to 500, about body to 1,500, area headline to 120, area body to 1,500, each area location to 60, locations to 20, quote to 500, attribution to 80, and testimonials to six. Require the request owner to own every supplied `page_id`; reject the entire request with `403` if one does not. Changing `business_name` must call the Task 2 reservation transaction and return the new portfolio URL.

`POST /api/my-portfolio/create` must require the authenticated business, reserve its slug, populate defaults, set status to `open`, and return `{ portfolio_url, created: true }`. Repeated calls return the existing URL with `{ created: false }`. This endpoint is the only agent action that creates a portfolio before the second active property.

- [ ] **Step 4: Build the editor UI**

Before a portfolio exists or while it is `draft`, show a “יצירת דף נכסים” button in the dashboard. After manual or automatic creation, replace it with the public URL plus “צפייה” and “עריכה” actions. The editor contains:

```html
<section id="profileEditor"></section>
<section id="heroEditor"></section>
<section id="aboutEditor"></section>
<section id="areaEditor"></section>
<section id="testimonialsEditor"></section>
<section id="propertiesEditor"></section>
<p class="legal-warning">פרסום חוות דעת שאינן אמיתיות עלול להוות הפרת חוק ולחשוף אתכם לתביעה.</p>
```

Use `FLY.uploadFiles([file])` for portrait, logo, and custom font uploads. Before upload, reject files with a MIME type outside JPEG/PNG/WebP for images, reject image files above 10 MB, and reject font files outside WOFF/WOFF2/OTF/TTF. Render unsaved property visibility/order changes locally; persist only on the explicit save button. Do not permit the agent to close their portfolio.

- [ ] **Step 5: Run validation**

Run: `node server/portfolio.test.js && npm --prefix server test`

Expected: portfolio validation and all existing standalone tests pass.

- [ ] **Step 6: Commit**

```bash
git add public-agent/portfolio.html public-agent/portfolio.js public-agent/index.html public-agent/api.js server/routes/dashboard.js server/portfolio.js server/portfolio.test.js
git commit -m "feat: let agents edit their public portfolios"
```

### Task 6: Admin Close/Reopen Controls and Property Page Portfolio Link

**Files:**
- Modify: `server/routes/admin.js`
- Modify: `public-agent/admin.html`
- Modify: `public-agent/admin.js`
- Modify: `public-nadlan/p/page.js`
- Modify: `public-nadlan/p/page.css`
- Modify: `server/pages-auth.test.js`

**Interfaces:**
- Consumes: `portfolio.status`, admin phone/session verification, and `portfolio_url` in property payloads.
- Produces: admin close/reopen behavior and a buyer-facing link from every active property page to the owning portfolio.

- [ ] **Step 1: Write failing status authorization tests**

```js
assert.equal(canSetPortfolioStatus({ userId: "972500000000" }, "972500000000", "972599999999"), false);
assert.equal(canSetPortfolioStatus({ userId: "972500000000" }, "972500000000", "972500000000"), true);
assert.throws(() => normalizePortfolioStatus("paused"), /invalid_status/);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node server/pages-auth.test.js`

Expected: failure because portfolio status helpers do not exist.

- [ ] **Step 3: Add the admin-only status endpoint and controls**

Implement `POST /api/admin/portfolio-status` in the Express admin router. It must require an admin session, allow only `open` or `closed`, update `businesses/{phone}.portfolio.status`, and return `{ ok: true, status, portfolio_url }`. Include portfolio status and URL in the existing admin agent/listing records. The admin UI presents `סגירת דף נכסים` for open portfolios and `פתיחת דף נכסים` for closed ones, with a confirmation dialog that states the effect is immediate.

- [ ] **Step 4: Add the property-page portfolio CTA**

In `page.js`, render the link only when `portfolio_url` exists:

```js
var href = d.portfolio_url || "";
if (href) {
  portfolioLink.href = href;
  portfolioLink.hidden = false;
  portfolioLink.textContent = "לכל הנכסים של " + (d.agent.brand_name || d.agent.name || "המתווך");
}
```

The CTA must not expose an uncreated or closed portfolio; public property payload construction includes `portfolio_url` only when `portfolio.status === "open"`.

- [ ] **Step 5: Run validation**

Run: `node server/pages-auth.test.js && npm --prefix server test`

Expected: only admins pass the status guard and the full standalone test suite passes.

- [ ] **Step 6: Commit**

```bash
git add server/routes/admin.js public-agent/admin.html public-agent/admin.js public-nadlan/p/page.js public-nadlan/p/page.css server/pages-auth.test.js
git commit -m "feat: add portfolio administration and property links"
```

### Task 7: Migration, End-to-End Verification, and Release

**Files:**
- Modify: `docs/n8n/lead-handler-workflow.md`
- Modify: `docs/superpowers/plans/2026-09-02-agent-portfolios.md`
- Verify: `firebase.json`

**Interfaces:**
- Consumes: all previous tasks, production Firebase credentials, and the n8n lead handler.
- Produces: migrated portfolio routes, verified webhook payload compatibility, and a controlled public deployment.

- [ ] **Step 1: Verify the n8n lead contract before deployment**

Add this contract row to the lead-handler documentation:

```json
{
  "source": "portfolio",
  "page_id": null,
  "listing_id": null,
  "agent_phone": "972542045280",
  "portfolio_url": "https://nadlan.call4li.com/kroitoro-nehasim"
}
```

Confirm the workflow branches on `source === "portfolio"` before accessing property fields; send the same internal lead notification path used by property leads.

- [ ] **Step 2: Execute and inspect a non-writing migration**

Run: `node server/scripts/backfill-portfolios.js --dry-run`

Expected: zero collisions, every business owning at least one property page receives a candidate slug, agents with one active page receive `draft`, agents with at least two receive `open`, every page receives a candidate property slug, and no documents are written.

- [ ] **Step 3: Execute the approved backfill once**

Run: `node server/scripts/backfill-portfolios.js --apply`

Expected: output counts match the dry run; rerunning `--dry-run` immediately reports `portfoliosChanged: 0` and `pagesChanged: 0`.

- [ ] **Step 4: Run the complete automated suite**

Run: `npm --prefix server test && node server/portfolio.test.js`

Expected: all commands exit `0`.

- [ ] **Step 5: Run the manual acceptance matrix against the Express staging deployment**

Verify each case using a new test agent and then one migrated agent:

```text
1. First active page reserves the agent slug as draft; its nested property URL works and no public portfolio link appears.
2. Second active page opens the portfolio automatically; the dashboard shows its URL and no automated WhatsApp/SMS sends it.
3. With zero or one property, “Create portfolio” opens it manually and repeated clicks do not create duplicates.
4. Portfolio search and filters operate on cards inside /{agent}; selecting a card opens /{agent}/{street3number-code}.
5. Old /p/{pageId} returns 301 to the nested property page.
6. Renaming business changes the portfolio URL; old portfolio and nested property URLs return 301.
7. Hidden, archived, and deleted pages are absent from the portfolio dashboard, while a hidden active property remains directly reachable.
8. Portfolio with zero visible listings shows the contact form and remains 200.
9. Buyer filters combine text, deal type, city/neighborhood, price, rooms, and size correctly.
10. Portfolio form writes a portfolio lead with null page/listing ids and reaches n8n.
11. Agent cannot close a portfolio; admin can close/reopen; a closed portfolio returns 404 while nested active properties remain 200 and omit the portfolio link.
12. Empty portrait/about/area/testimonial sections do not leave blank layout blocks; open portfolios emit index,follow and a canonical current URL.
13. At 1440x1000, 768x1024, and 390x844, the Kroitoro portfolio matches docs/agent-portfolio-example.html in section order, Discovery typography, palette, spacing, hero proportions, portrait treatment, card anatomy, contact band, and mobile stacking.
14. Filters appear only between the property heading and cards, retain the prototype's square-cornered visual language, update the visible count, and do not turn the page into a generic application dashboard.
```

- [ ] **Step 6: Deploy only the Firebase Hosting target after the Express release is healthy**

Run: `firebase deploy --only hosting:nadlan`

Expected: the deployment summary contains Hosting only and does not build or deploy Functions. Confirm both `/kroitoro-nehasim` and `/kroitoro-nehasim/vyt23-a7k` preserve their paths when redirected to `https://nadlan.call4li.com`.

- [ ] **Step 7: Commit the release documentation**

```bash
git add docs/n8n/lead-handler-workflow.md docs/superpowers/plans/2026-09-02-agent-portfolios.md
git commit -m "docs: verify agent portfolio rollout"
```

## Plan Self-Review

**Coverage:** Tasks 1-3 cover stable public URLs, second-property automatic opening, manual early creation, redirects, `index,follow` and canonical metadata, empty portfolios, property-dashboard visibility, nested property routing, filters, property-to-portfolio links, and exact implementation of the approved prototype. Task 4 covers portfolio leads and events. Task 5 covers every requested agent-editable field, including area, and uploads. Task 6 covers the requested admin close control without disabling property pages. Task 7 covers migration, responsive visual comparison, and delivery verification.

**Scope:** The plan intentionally excludes Firebase Function changes, custom domains, public review collection, agent-side close controls, and automated background removal. Search indexing is included for open portfolios. Firebase Hosting remains the static deployment target and redirect gateway. Each exclusion keeps the first release independently deployable.

**Consistency:** `PortfolioConfig`, `area`, `public_slug`, `portfolio_visible`, `portfolio_rank`, `portfolio_slugs`, `portfolio_url`, `draft|open|closed`, and `source: "portfolio"` use the same names in persistence, APIs, UI, tests, and migration steps.
