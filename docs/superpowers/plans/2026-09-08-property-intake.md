# Property Intake (free text, link, Facebook post) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent paste listing text or a link (Yad2, Madlan, any site, or a post on their connected Facebook Page) into step 1 of the create wizard, have Forly pre-fill the form, and ask only for what is still missing.

**Architecture:** One server endpoint `POST /api/properties/extract` resolves the input to text and photo URLs (plain text, Firecrawl scrape, or Facebook Graph), runs one LLM extraction through the existing `chat-provider.ask()`, and returns coerced fields plus a server-computed `missing` list. The wizard fills only empty inputs, moves the still-missing inputs into one card, and shows found photos as pre-ticked thumbnails that are imported server-side via `POST /api/photos/import-url` on Continue.

**Tech Stack:** Node 22, Express, plain `node` assertion tests (no framework), vanilla JS in `public-agent/`, Firecrawl REST API, Meta Graph API, Anthropic/Gemini/OpenAI via `server/chat-provider.js`.

**Spec:** `docs/superpowers/specs/2026-09-08-property-intake-design.md`

## Global Constraints

- Keep every file under 500 lines. `public-agent/create.html` is already 1344 lines, so new wizard logic goes in `public-agent/extract.js`, and only markup plus a thin wiring block goes into `create.html`.
- Tests are plain `node file.test.js` scripts using `assert`, registered in the `test` script of `server/package.json`. No test frameworks, no live network, no real API keys.
- Never guess extracted values: absent means `null`. `missing` is always computed on the server from `REQUIRED`, never taken from the model.
- Required set: `address, city, price, rooms, size_sqm, floor, deal, parking, neighborhood`. Demo mode adds agent name and phone on the client only.
- Field `deal` is `"sale"` or `"rent"` and maps to the existing hidden `#pType` select.
- External calls: 10 second timeout (`AbortSignal.timeout(10000)`), text input capped at 4000 characters, daily cap of 30 extract calls per account.
- Env vars: `FIRECRAWL_API_KEY`, `PROPERTY_PARSE_MODEL` (default `claude-haiku-4-5-20251001`). Document both in `server/.env.example`.
- Commit messages: no `Co-Authored-By` trailer (repo rule in `CLAUDE.md`). No deploys, no pushes to `main`.
- Run all server commands from `server/` (`cd server && npm test`).

---

## File map

| File | Responsibility |
|---|---|
| `server/listing-extract.js` (new) | Prompt, LLM call, coercion, `missing` computation |
| `server/listing-extract.test.js` (new) | Coercion, missing, reply parsing, prompt content |
| `server/listing-sources.js` (new) | URL routing, SSRF guard, Facebook post lookup, Firecrawl adapter, image filtering |
| `server/listing-sources.test.js` (new) | All of the above with stubbed `fetch`/`graphCall`/`getConnection` |
| `server/upload-store.js` (new) | `storeBuffer()` shared by the existing PUT upload and the new URL import |
| `server/routes/intake.js` (modify) | PUT `/upload/:fname` delegates to `storeBuffer()` |
| `server/routes/extract.js` (new) | `POST /properties/extract`, `POST /photos/import-url`, daily cap |
| `server/routes/extract.test.js` (new) | Body validation, error mapping, daily cap, image import checks |
| `server/index.js` (modify) | Mount the new router |
| `server/.env.example` (modify) | Document the two env vars |
| `server/package.json` (modify) | Register the four new test files |
| `public-agent/extract.js` (new) | Pure wizard helpers: `isUrl`, `fillFields`, `missingFor`, `errorKey` |
| `public-agent/extract.test.js` (new) | Those helpers with a fake DOM |
| `public-agent/create.html` (modify) | Step 1 markup, `#manualFields` wrapper, wiring block, script tag |
| `public-agent/form-i18n.js` (modify) | `ext_*` strings in `he` and `en` |
| `server/create-wizard.test.js` (modify) | Markers for the new markup and wiring |

---

### Task 1: LLM extraction module

**Files:**
- Create: `server/listing-extract.js`
- Test: `server/listing-extract.test.js`
- Modify: `server/package.json` (test script)

**Interfaces:**
- Consumes: `ask(model, system, messages, keys) -> Promise<{text, in, out}>` from `server/chat-provider.js`.
- Produces: `parseListing(text, {askFn?, model?, keys?}) -> Promise<{fields, missing}>`; `REQUIRED: string[]`; `MAX_INPUT: 4000`; errors carry `err.code === "extract_unavailable"`. `fields` always has every key of `SCHEMA`, `null` when unknown.

- [ ] **Step 1: Write the failing test**

Create `server/listing-extract.test.js`:

```js
/* listing-extract.js — coercion and "what is still missing" maths. The LLM
   call is stubbed; what matters is that nothing malformed or invented reaches
   the form and that `missing` is always computed here, never trusted. */
const assert = require("assert");
const { parseListing, REQUIRED, MAX_INPUT, _test } = require("./listing-extract");
const { coerce, missingOf, parseReply, SYSTEM } = _test;

// ── coerce: every key present, junk becomes null ──
const all = coerce({
  address: " דיזנגוף 40 ", city: "תל אביב", neighborhood: null, deal: "sale",
  price: "2,900,000", rooms: 3.5, size_sqm: "95", sqm_built: null, sqm_balcony: 12,
  sqm_garden: null, floor: "4", parking: 1.0, elevator: true, shabbat_elevator: "yes", storage: null,
  made_up: "dropped",
});
assert.equal(all.address, "דיזנגוף 40");
assert.equal(all.price, 2900000);
assert.equal(all.rooms, 3.5);
assert.equal(all.size_sqm, 95);
assert.equal(all.floor, 4);
assert.equal(all.parking, 1);
assert.equal(all.elevator, true);
assert.equal(all.shabbat_elevator, null);   // strings are not booleans
assert.equal(all.deal, "sale");
assert.equal("made_up" in all, false);
assert.equal(coerce({ deal: "lease" }).deal, null);
assert.equal(coerce({ price: "abc" }).price, null);
assert.equal(coerce(null).city, null);
assert.equal(coerce({ address: "x".repeat(400) }).address.length, 180);

// ── missingOf: only the agreed required set, only nulls ──
assert.deepEqual(missingOf(coerce({})), REQUIRED);
assert.deepEqual(
  missingOf(coerce({ address: "a", city: "b", price: 1, rooms: 2, size_sqm: 3, floor: 0, deal: "rent", parking: 0, neighborhood: "n" })),
  []);
assert.ok(REQUIRED.includes("deal") && REQUIRED.includes("neighborhood") && !REQUIRED.includes("elevator"));

// ── parseReply: tolerant of fences and prose around the object ──
assert.equal(parseReply('```json\n{"city":"חיפה"}\n```').city, "חיפה");
assert.equal(parseReply('Sure! {"rooms": 4}').rooms, 4);
assert.throws(() => parseReply("no json here"), (e) => e.code === "extract_unavailable");
assert.throws(() => parseReply("{not json"), (e) => e.code === "extract_unavailable");

// ── prompt keeps the model honest ──
assert.match(SYSTEM, /null/);
assert.match(SYSTEM, /Never guess/);
assert.match(SYSTEM, /מיליון/);
assert.match(SYSTEM, /"rent"/);

// ── parseListing: caps input, wires the stub, maps provider errors ──
(async () => {
  let seen;
  const askFn = async (model, system, messages) => {
    seen = { model, system, messages };
    return { text: '{"address":"הרצל 1","city":"נתניה","price":"1.5M"}', in: 1, out: 1 };
  };
  const out = await parseListing("x".repeat(5000), { askFn, model: "test-model", keys: {} });
  assert.equal(seen.model, "test-model");
  assert.equal(seen.messages[0].content.length, MAX_INPUT);
  assert.equal(out.fields.address, "הרצל 1");
  assert.equal(out.fields.price, null);          // "1.5M" is not a number; the prompt asks for numbers
  assert.deepEqual(out.missing, ["price", "rooms", "size_sqm", "floor", "deal", "parking", "neighborhood"]);

  await assert.rejects(
    parseListing("t", { askFn: async () => { throw new Error("ANTHROPIC_API_KEY is not set"); } }),
    (e) => e.code === "extract_unavailable");
  console.log("listing-extract.test.js ok");
})();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node listing-extract.test.js`
Expected: `Cannot find module './listing-extract'`

- [ ] **Step 3: Implement the module**

Create `server/listing-extract.js`:

```js
/*
 * listing-extract.js — turns pasted listing text into the wizard's fields.
 *
 * One LLM call through chat-provider.ask(). The model only extracts; the
 * server decides what is still missing (REQUIRED). Absent means null, never
 * a guess, and every value is coerced to the type the form input expects so
 * nothing the model invents can reach the page.
 */
const { ask } = require("./chat-provider");

const MODEL = process.env.PROPERTY_PARSE_MODEL || "claude-haiku-4-5-20251001";
const MAX_INPUT = 4000;

// Coercers: unusable → null.
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,\s₪]/g, "");
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};
const int = (v) => { const n = num(v); return n === null ? null : Math.round(n); };
const str = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 180) : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const deal = (v) => (v === "sale" || v === "rent" ? v : null);

const SCHEMA = {
  address: str, city: str, neighborhood: str, deal,
  price: num, rooms: num, size_sqm: num, sqm_built: num, sqm_balcony: num, sqm_garden: num,
  floor: int, parking: int, elevator: bool, shabbat_elevator: bool, storage: bool,
};
const REQUIRED = ["address", "city", "price", "rooms", "size_sqm", "floor", "deal", "parking", "neighborhood"];

const SYSTEM = `You extract real-estate listing facts from text written in Hebrew or English.
Return ONLY a JSON object with exactly these keys: ${Object.keys(SCHEMA).join(", ")}.
Rules:
- Use only what the text states explicitly. If a value is not stated, use null. Never guess.
- Numbers as JSON numbers, never strings. price in ILS: "2.9M" or "2.9 מיליון" → 2900000, "890 אלף" → 890000, "12,000 לחודש" → 12000.
- deal: "rent" if the text is about renting (להשכרה, שכירות, לחודש), "sale" if about buying (למכירה), else null.
- rooms may be fractional (3.5). floor is the apartment's floor, not the building height. parking is the number of spots (חניה = 1).
- elevator, shabbat_elevator, storage: true only if mentioned, otherwise null.
- address is street and number only; city and neighborhood go in their own keys.
No prose, no markdown fences.`;

function unavailable(msg) { const e = new Error(msg); e.code = "extract_unavailable"; return e; }

function coerce(raw) {
  const fields = {};
  for (const [k, fn] of Object.entries(SCHEMA)) fields[k] = raw && k in raw ? fn(raw[k]) : null;
  return fields;
}

function missingOf(fields) { return REQUIRED.filter((k) => fields[k] === null); }

function parseReply(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw unavailable("no json in reply");
  let raw;
  try { raw = JSON.parse(m[0]); } catch (e) { throw unavailable("bad json in reply"); }
  return coerce(raw);
}

async function parseListing(text, { askFn = ask, model = MODEL, keys = process.env } = {}) {
  const input = String(text || "").slice(0, MAX_INPUT);
  let reply;
  try { reply = await askFn(model, SYSTEM, [{ role: "user", content: input }], keys); }
  catch (err) { throw unavailable(err.message); }
  const fields = parseReply(reply && reply.text);
  return { fields, missing: missingOf(fields) };
}

module.exports = { parseListing, REQUIRED, MAX_INPUT, SCHEMA, _test: { coerce, missingOf, parseReply, SYSTEM } };
```

- [ ] **Step 4: Run the test**

Run: `cd server && node listing-extract.test.js`
Expected: `listing-extract.test.js ok`

- [ ] **Step 5: Register the test and commit**

In `server/package.json`, append ` && node listing-extract.test.js` to the end of the `"test"` script (before the closing quote; the script currently ends with `node login-leads.test.js `).

```bash
cd server && npm test
git add server/listing-extract.js server/listing-extract.test.js server/package.json
git commit -m "feat(extract): LLM listing extraction with server-side missing list"
```

---

### Task 2: Source resolvers (plain text, Firecrawl, Facebook)

**Files:**
- Create: `server/listing-sources.js`
- Test: `server/listing-sources.test.js`
- Modify: `server/package.json` (test script), `server/.env.example`

**Interfaces:**
- Consumes: `graphCall(pathname, {params, token, fetchFn})` from `server/distribution/meta.js`; `db.getConnection(phone) -> {page_id, page_token, ...} | null` from `server/db.js`.
- Produces: `resolve({text, url, userId}, deps) -> Promise<{source, text, description, photos: [{url, source}]}>` where `source` is `"text" | "facebook" | "scrape"`. Errors carry `err.code` in `invalid_input | facebook_not_connected | page_unreadable | extract_unavailable`. Also exports `isPublicUrl(url) -> Promise<boolean>` for reuse by the photo import route, and `_test` helpers.

- [ ] **Step 1: Write the failing test**

Create `server/listing-sources.test.js`:

```js
/* listing-sources.js — where an input goes and what comes back. No network:
   fetch, graphCall and getConnection are stubbed. */
const assert = require("assert");
const S = require("./listing-sources");
const { sourceFor, facebookPostId, listingImages, isPrivateIp } = S._test;

// ── routing by host ──
assert.equal(sourceFor({ text: "3 חדרים" }), "text");
assert.equal(sourceFor({ url: "https://www.facebook.com/golan.nadlan/posts/123" }), "facebook");
assert.equal(sourceFor({ url: "https://fb.watch/abc" }), "facebook");
assert.equal(sourceFor({ url: "https://www.yad2.co.il/item/abc" }), "scrape");
assert.equal(sourceFor({ url: "https://www.madlan.co.il/listings/x" }), "scrape");
assert.throws(() => sourceFor({ url: "ftp://x" }), (e) => e.code === "invalid_input");
assert.throws(() => sourceFor({}), (e) => e.code === "invalid_input");

// ── SSRF guard ──
assert.equal(isPrivateIp("127.0.0.1"), true);
assert.equal(isPrivateIp("10.1.2.3"), true);
assert.equal(isPrivateIp("172.20.0.1"), true);
assert.equal(isPrivateIp("192.168.1.1"), true);
assert.equal(isPrivateIp("169.254.169.254"), true);
assert.equal(isPrivateIp("::1"), true);
assert.equal(isPrivateIp("8.8.8.8"), false);

// ── facebook post id from the common URL shapes ──
assert.equal(facebookPostId("https://www.facebook.com/golan/posts/10159"), "10159");
assert.equal(facebookPostId("https://www.facebook.com/golan/posts/pfbid0abcDEF"), "pfbid0abcDEF");
assert.equal(facebookPostId("https://www.facebook.com/permalink.php?story_fbid=555&id=777"), "555");
assert.equal(facebookPostId("https://www.facebook.com/photo/?fbid=999&set=a.1"), "999");
assert.equal(facebookPostId("https://www.facebook.com/photo.php?fbid=888"), "888");
assert.equal(facebookPostId("https://www.facebook.com/golan"), null);

// ── image filtering from scraped markdown ──
const md = `# דירה
![](https://img.yad2.co.il/Pic/1.jpg)
![logo](https://cdn.site/logo.png)
![](https://cdn.site/icons/sprite.svg)
![](https://cdn.site/pixel.gif)
![](https://img.yad2.co.il/Pic/1.jpg)
![](https://img.yad2.co.il/Pic/2.jpeg?w=800)`;
assert.deepEqual(listingImages(md), ["https://img.yad2.co.il/Pic/1.jpg", "https://img.yad2.co.il/Pic/2.jpeg?w=800"]);
assert.equal(listingImages(Array.from({ length: 30 }, (_, i) => `![](https://c/${i}.jpg)`).join("\n")).length, 12);

(async () => {
  // ── plain text ──
  const t = await S.resolve({ text: "  3 חדרים בהרצל  " }, {});
  assert.deepEqual(t, { source: "text", text: "3 חדרים בהרצל", description: "3 חדרים בהרצל", photos: [] });

  // ── firecrawl: happy path ──
  let fcReq;
  const fetchOk = async (url, opts) => {
    fcReq = { url, opts };
    return { ok: true, json: async () => ({ success: true, data: { markdown: "דירת 4 חדרים\n![](https://c/a.jpg)", metadata: { description: "meta desc" } } }) };
  };
  const sc = await S.resolve({ url: "https://www.yad2.co.il/item/1" }, { fetchFn: fetchOk, firecrawlKey: "k", lookup: async () => [{ address: "1.2.3.4" }] });
  assert.equal(sc.source, "scrape");
  assert.equal(sc.text, "דירת 4 חדרים\n![](https://c/a.jpg)");
  assert.equal(sc.description, "meta desc");
  assert.deepEqual(sc.photos, [{ url: "https://c/a.jpg", source: "scrape" }]);
  assert.equal(fcReq.url, "https://api.firecrawl.dev/v1/scrape");
  assert.equal(fcReq.opts.headers.Authorization, "Bearer k");
  assert.equal(JSON.parse(fcReq.opts.body).url, "https://www.yad2.co.il/item/1");

  // ── firecrawl: blocked / empty → page_unreadable; no key → extract_unavailable; private host → invalid_input ──
  const fetchEmpty = async () => ({ ok: true, json: async () => ({ success: true, data: { markdown: "   " } }) });
  await assert.rejects(S.resolve({ url: "https://x.co/1" }, { fetchFn: fetchEmpty, firecrawlKey: "k", lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  const fetchFail = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(S.resolve({ url: "https://x.co/1" }, { fetchFn: fetchFail, firecrawlKey: "k", lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  await assert.rejects(S.resolve({ url: "https://x.co/1" }, { fetchFn: fetchOk, firecrawlKey: "", lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "extract_unavailable");
  await assert.rejects(S.resolve({ url: "http://169.254.169.254/latest" }, { fetchFn: fetchOk, firecrawlKey: "k", lookup: async () => [{ address: "169.254.169.254" }] }), (e) => e.code === "invalid_input");

  // ── facebook: connected page, post with attachments ──
  const graph = [];
  const graphCall = async (pathname, opts) => {
    graph.push({ pathname, opts });
    return {
      message: "למכירה 3 חדרים",
      attachments: { data: [
        { media: { image: { src: "https://scontent/a.jpg" } }, subattachments: { data: [
          { media: { image: { src: "https://scontent/b.jpg" } } },
          { media: { image: { src: "https://scontent/a.jpg" } } },
        ] } },
      ] },
    };
  };
  const fb = await S.resolve({ url: "https://www.facebook.com/golan/posts/123", userId: "0501234567" },
    { graphCall, getConnection: async () => ({ page_id: "777", page_token: "PT" }) });
  assert.equal(fb.source, "facebook");
  assert.equal(fb.text, "למכירה 3 חדרים");
  assert.equal(fb.description, "למכירה 3 חדרים");
  assert.deepEqual(fb.photos.map((p) => p.url), ["https://scontent/a.jpg", "https://scontent/b.jpg"]);
  assert.equal(graph[0].pathname, "/777_123");
  assert.equal(graph[0].opts.token, "PT");
  assert.match(graph[0].opts.params.fields, /attachments\{media,subattachments\{media\}\}/);

  // ── facebook: pfbid slugs are passed through untouched; numeric ids fall back to the bare id ──
  const graph2 = [];
  const graphCall2 = async (pathname) => { graph2.push(pathname); return { message: "x", attachments: { data: [] } }; };
  const fb2 = await S.resolve({ url: "https://www.facebook.com/golan/posts/pfbid0ABC", userId: "u" },
    { graphCall: graphCall2, getConnection: async () => ({ page_id: "777", page_token: "PT" }) });
  assert.deepEqual(graph2, ["/pfbid0ABC"]);           // pfbid is never prefixed
  assert.equal(fb2.text, "x");
  const graph3 = [];
  const graphCall3 = async (pathname) => {
    graph3.push(pathname);
    if (graph3.length === 1) { const e = new Error("no"); e.code = 100; throw e; }
    return { message: "y", attachments: { data: [] } };
  };
  await S.resolve({ url: "https://www.facebook.com/golan/posts/123", userId: "u" },
    { graphCall: graphCall3, getConnection: async () => ({ page_id: "777", page_token: "PT" }) });
  assert.deepEqual(graph3, ["/777_123", "/123"]);

  // ── facebook: not connected / no user / unparseable url / empty post ──
  await assert.rejects(S.resolve({ url: "https://www.facebook.com/golan/posts/123", userId: "u" }, { graphCall, getConnection: async () => null }), (e) => e.code === "facebook_not_connected");
  await assert.rejects(S.resolve({ url: "https://www.facebook.com/golan/posts/123" }, { graphCall, getConnection: async () => ({ page_token: "PT" }) }), (e) => e.code === "facebook_not_connected");
  await assert.rejects(S.resolve({ url: "https://www.facebook.com/golan", userId: "u" }, { graphCall, getConnection: async () => ({ page_id: "1", page_token: "PT" }) }), (e) => e.code === "page_unreadable");
  await assert.rejects(S.resolve({ url: "https://www.facebook.com/golan/posts/5", userId: "u" }, { graphCall: async () => ({}), getConnection: async () => ({ page_id: "1", page_token: "PT" }) }), (e) => e.code === "page_unreadable");
  console.log("listing-sources.test.js ok");
})();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node listing-sources.test.js`
Expected: `Cannot find module './listing-sources'`

- [ ] **Step 3: Implement the module**

Create `server/listing-sources.js`:

```js
/*
 * listing-sources.js — turns "what the agent pasted" into text + photo URLs.
 *
 *   text            → as is
 *   facebook.com    → Graph API with the agent's connected Page token
 *   any other URL   → Firecrawl scrape (markdown)
 *
 * Nothing here calls the LLM; listing-extract.js does that on the text we
 * return. Every error carries a stable `code` the route maps to a status.
 */
const dns = require("dns").promises;
const net = require("net");
const meta = require("./distribution/meta");
const db = require("./db");

const TIMEOUT_MS = 10000;
const MAX_PHOTOS = 12;
const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";
const FB_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.watch)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)(\?|$)/i;
const NOT_LISTING = /(logo|icon|sprite|pixel|avatar|badge|flag|banner|placeholder)/i;

function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

function parseUrl(url) {
  let u;
  try { u = new URL(String(url || "")); } catch (e) { throw fail("invalid_input", "bad url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw fail("invalid_input", "bad scheme");
  return u;
}

function sourceFor({ text, url }) {
  if (typeof text === "string" && text.trim()) return "text";
  if (!url) throw fail("invalid_input", "text or url required");
  return FB_HOSTS.test(parseUrl(url).hostname) ? "facebook" : "scrape";
}

// ── SSRF guard ──
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || /^::ffff:/i.test(ip) && isPrivateIp(ip.replace(/^::ffff:/i, ""));
  const p = ip.split(".").map(Number);
  if (p.length !== 4) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254);
}

async function isPublicUrl(url, lookup = (h) => dns.lookup(h, { all: true })) {
  let u;
  try { u = parseUrl(url); } catch (e) { return false; }
  if (u.hostname === "localhost") return false;
  if (net.isIP(u.hostname)) return !isPrivateIp(u.hostname);
  try {
    const addrs = await lookup(u.hostname);
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch (e) { return false; }
}

// ── images out of scraped markdown ──
function listingImages(markdown) {
  const out = [];
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(String(markdown || ""))) && out.length < MAX_PHOTOS) {
    const src = m[1];
    if (!IMAGE_EXT.test(src) || NOT_LISTING.test(src) || out.includes(src)) continue;
    out.push(src);
  }
  return out;
}

// ── facebook ──
function facebookPostId(url) {
  let u;
  try { u = parseUrl(url); } catch (e) { return null; }
  const q = u.searchParams;
  if (q.get("story_fbid")) return q.get("story_fbid");
  if (q.get("fbid")) return q.get("fbid");
  const m = u.pathname.match(/\/posts\/([A-Za-z0-9_]+)/) || u.pathname.match(/\/videos\/(\d+)/);
  return m ? m[1] : null;
}

function attachmentImages(post) {
  const urls = [];
  const walk = (list) => {
    for (const a of (list && list.data) || []) {
      const src = a && a.media && a.media.image && a.media.image.src;
      if (src && !urls.includes(src) && urls.length < MAX_PHOTOS) urls.push(src);
      if (a && a.subattachments) walk(a.subattachments);
    }
  };
  walk(post && post.attachments);
  return urls;
}

async function fromFacebook({ url, userId }, { graphCall = meta.graphCall, getConnection = db.getConnection }) {
  const conn = userId ? await getConnection(userId) : null;
  if (!conn || !conn.page_token || !conn.page_id) throw fail("facebook_not_connected");
  const id = facebookPostId(url);
  if (!id) throw fail("page_unreadable", "no post id in url");
  const fields = "message,attachments{media,subattachments{media}}";
  // Graph wants "<page>_<post>" for numeric post ids; pfbid slugs are global.
  const tries = /^\d+$/.test(id) ? [`/${conn.page_id}_${id}`, `/${id}`] : [`/${id}`];
  let post = null, lastErr = null;
  for (const pathname of tries) {
    try { post = await graphCall(pathname, { params: { fields }, token: conn.page_token, timeoutMs: TIMEOUT_MS }); break; }
    catch (err) { lastErr = err; if (meta.isAuthError(err)) throw err; }
  }
  if (!post) throw fail("page_unreadable", lastErr ? lastErr.message : "graph failed");
  const text = String(post.message || "").trim();
  const photos = attachmentImages(post).map((u) => ({ url: u, source: "facebook" }));
  if (!text && !photos.length) throw fail("page_unreadable", "empty post");
  return { source: "facebook", text, description: text, photos };
}

// ── firecrawl ──
async function fromFirecrawl({ url }, { fetchFn = fetch, firecrawlKey = process.env.FIRECRAWL_API_KEY, lookup }) {
  if (!(await isPublicUrl(url, lookup))) throw fail("invalid_input", "url not allowed");
  if (!firecrawlKey) throw fail("extract_unavailable", "FIRECRAWL_API_KEY is not set");
  let data;
  try {
    const r = await fetchFn(FIRECRAWL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${firecrawlKey}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw fail("page_unreadable", `firecrawl ${r.status}`);
    data = (await r.json()).data || {};
  } catch (err) {
    if (err.code) throw err;
    throw fail("page_unreadable", err.message);
  }
  const text = String(data.markdown || "").trim();
  if (!text) throw fail("page_unreadable", "empty page");
  const description = String((data.metadata && data.metadata.description) || "").trim() || text;
  return { source: "scrape", text, description, photos: listingImages(text).map((u) => ({ url: u, source: "scrape" })) };
}

async function resolve(input, deps = {}) {
  const kind = sourceFor(input);
  if (kind === "text") { const text = input.text.trim(); return { source: "text", text, description: text, photos: [] }; }
  if (kind === "facebook") return fromFacebook(input, deps);
  return fromFirecrawl(input, deps);
}

module.exports = { resolve, isPublicUrl, TIMEOUT_MS, _test: { sourceFor, facebookPostId, listingImages, isPrivateIp, attachmentImages } };
```

- [ ] **Step 4: Run the test**

Run: `cd server && node listing-sources.test.js`
Expected: `listing-sources.test.js ok`

- [ ] **Step 5: Document env, register test, commit**

Append to `server/.env.example` after the `ANTHROPIC_API_KEY` line:

```
# Property intake (paste text / link in the create wizard)
# FIRECRAWL_API_KEY=
# PROPERTY_PARSE_MODEL=claude-haiku-4-5-20251001
```

In `server/package.json`, append ` && node listing-sources.test.js` to the `test` script.

```bash
cd server && npm test
git add server/listing-sources.js server/listing-sources.test.js server/.env.example server/package.json
git commit -m "feat(extract): resolve pasted text, Firecrawl pages and Facebook posts to listing text and photos"
```

---

### Task 3: Shared upload store

**Files:**
- Create: `server/upload-store.js`
- Modify: `server/routes/intake.js:63-93` (the `router.put("/upload/:fname")` handler body)
- Test: `server/create-wizard.test.js` (add a marker) and a small inline check in `server/routes/extract.test.js` (Task 4)

**Interfaces:**
- Produces: `storeBuffer({fname, buffer, contentType}, {uploadDir, remoteUploadBase, fetchFn?}) -> Promise<{ok: true, remote: boolean}>`; throws `Error` with `.status = 502` when the remote relay fails.

- [ ] **Step 1: Create the helper**

Create `server/upload-store.js`:

```js
/*
 * upload-store.js — where an uploaded/imported binary ends up.
 * Local dev writes to uploadDir; a deployed instance relays to the upload
 * host (REMOTE_UPLOAD_BASE). Shared by the PUT /upload route and the
 * photo URL import so both behave identically.
 */
const fs = require("fs");
const path = require("path");

async function storeBuffer({ fname, buffer, contentType }, { uploadDir, remoteUploadBase, fetchFn = fetch }) {
  if (remoteUploadBase) {
    let r;
    try {
      r = await fetchFn(`${remoteUploadBase}/api/upload/${fname}`, {
        method: "PUT",
        headers: { "Content-Type": contentType || "application/octet-stream" },
        body: buffer,
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) { const e = new Error(`remote upload failed: ${err.message}`); e.status = 502; throw e; }
    if (!r.ok) { const e = new Error(`remote upload failed: ${r.status}`); e.status = 502; throw e; }
    return { ok: true, remote: true };
  }
  fs.writeFileSync(path.join(uploadDir, fname), buffer);
  return { ok: true, remote: false };
}

module.exports = { storeBuffer };
```

- [ ] **Step 2: Make the existing PUT route use it**

In `server/routes/intake.js`, add near the other requires at the top:

```js
const { storeBuffer } = require("../upload-store");
```

Replace the block inside `router.put("/upload/:fname", ...)` that starts at `if (remoteUploadBase) {` and ends with `res.json({ ok: true });` (currently lines 78-93) with:

```js
    try {
      res.json(await storeBuffer({ fname, buffer: req.body, contentType: req.headers["content-type"] }, { uploadDir, remoteUploadBase }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
```

The `path` and `fs` requires in `intake.js` are still used by other handlers (font download, delete); leave them.

- [ ] **Step 3: Add a marker test and run the suite**

In `server/create-wizard.test.js`, after the existing marker loop, add:

```js
const intakeRoutes = fs.readFileSync(path.join(__dirname, "routes", "intake.js"), "utf8");
assert.match(intakeRoutes, /require\("\.\.\/upload-store"\)/);
assert.match(intakeRoutes, /storeBuffer\(\{ fname, buffer: req\.body/);
```

Run: `cd server && node create-wizard.test.js && npm test`
Expected: all pass (`create-wizard.test.js` is not in the npm script; run it directly).

- [ ] **Step 4: Commit**

```bash
git add server/upload-store.js server/routes/intake.js server/create-wizard.test.js
git commit -m "refactor(upload): share the store step between PUT upload and URL import"
```

---

### Task 4: Extract router, photo import, mounting

**Files:**
- Create: `server/routes/extract.js`
- Test: `server/routes/extract.test.js`
- Modify: `server/index.js` (mount after the intake router, around line 105), `server/package.json`

**Interfaces:**
- Consumes: `parseListing` (Task 1), `resolve`, `isPublicUrl` (Task 2), `storeBuffer` (Task 3), `requireAuth(secret)` from `server/auth.js`.
- Produces: `POST /api/properties/extract` and `POST /api/photos/import-url` as in the spec. `_test` exports: `validateBody(body) -> {text?} | {url?}`, `statusFor(code) -> number`, `DailyLimit`, `importImage(url, deps) -> Promise<{fname, buffer, contentType}>`.

- [ ] **Step 1: Write the failing test**

Create `server/routes/extract.test.js`:

```js
/* routes/extract.js — request validation, error → status mapping, the daily
   cap and the image import guard. Express is not exercised; the handlers'
   pure parts are. */
const assert = require("assert");
const { _test } = require("./extract");
const { validateBody, statusFor, DailyLimit, importImage, IMAGE_TYPES } = _test;

// ── body: exactly one of text/url, trimmed, capped ──
assert.deepEqual(validateBody({ text: "  שלום  " }), { text: "שלום" });
assert.deepEqual(validateBody({ url: " https://x.co/1 " }), { url: "https://x.co/1" });
assert.equal(validateBody({}), null);
assert.equal(validateBody({ text: "a", url: "https://x" }), null);
assert.equal(validateBody({ text: "   " }), null);
assert.equal(validateBody({ url: "not a url" }), null);
assert.equal(validateBody({ text: "x".repeat(9000) }).text.length, 4000);
assert.equal(validateBody(null), null);

// ── error codes → http status ──
assert.equal(statusFor("invalid_input"), 400);
assert.equal(statusFor("facebook_not_connected"), 409);
assert.equal(statusFor("page_unreadable"), 422);
assert.equal(statusFor("extract_limit"), 429);
assert.equal(statusFor("extract_unavailable"), 503);
assert.equal(statusFor("anything_else"), 500);

// ── daily cap: per key, per UTC day ──
const lim = new DailyLimit(2);
const day1 = new Date("2026-09-08T10:00:00Z");
assert.equal(lim.take("a", day1), true);
assert.equal(lim.take("a", day1), true);
assert.equal(lim.take("a", day1), false);
assert.equal(lim.take("b", day1), true);
assert.equal(lim.take("a", new Date("2026-09-09T00:00:01Z")), true);

// ── image import: public url, image type, size cap ──
(async () => {
  const png = Buffer.from("89504e47", "hex");
  const fetchOk = async () => ({ ok: true, headers: new Map([["content-type", "image/png"]]), arrayBuffer: async () => png });
  const img = await importImage("https://c/a.png", { fetchFn: fetchOk, lookup: async () => [{ address: "1.2.3.4" }] });
  assert.match(img.fname, /^[0-9a-f-]{36}\.png$/);
  assert.equal(img.contentType, "image/png");
  assert.equal(img.buffer.length, png.length);

  await assert.rejects(importImage("http://127.0.0.1/x.png", { fetchFn: fetchOk }), (e) => e.code === "invalid_input");
  const fetchHtml = async () => ({ ok: true, headers: new Map([["content-type", "text/html"]]), arrayBuffer: async () => png });
  await assert.rejects(importImage("https://c/a", { fetchFn: fetchHtml, lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  const fetchBig = async () => ({ ok: true, headers: new Map([["content-type", "image/jpeg"]]), arrayBuffer: async () => big });
  await assert.rejects(importImage("https://c/a.jpg", { fetchFn: fetchBig, lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  const fetch404 = async () => ({ ok: false, status: 404, headers: new Map() });
  await assert.rejects(importImage("https://c/a.jpg", { fetchFn: fetch404, lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  assert.deepEqual(Object.keys(IMAGE_TYPES), ["image/jpeg", "image/png", "image/webp"]);
  console.log("routes/extract.test.js ok");
})();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node routes/extract.test.js`
Expected: `Cannot find module './extract'`

- [ ] **Step 3: Implement the router**

Create `server/routes/extract.js`:

```js
/*
 * routes/extract.js — "paste text or a link, Forly fills the form".
 * Handles: POST /api/properties/extract, POST /api/photos/import-url
 *
 * Auth mirrors the upload routes: an x-demo-key header passes (the demo
 * wizard has no login), otherwise a signed session. The Facebook source needs
 * a real user (its Page token), so demo callers get facebook_not_connected.
 */
const express = require("express");
const crypto = require("crypto");
const { parseListing, MAX_INPUT } = require("../listing-extract");
const { resolve, isPublicUrl, TIMEOUT_MS } = require("../listing-sources");
const { storeBuffer } = require("../upload-store");

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DAILY_CAP = 30;

const STATUS = { invalid_input: 400, facebook_not_connected: 409, page_unreadable: 422, extract_limit: 429, extract_unavailable: 503 };
function statusFor(code) { return STATUS[code] || 500; }

function validateBody(body) {
  const b = body || {};
  const text = typeof b.text === "string" ? b.text.trim() : "";
  const url = typeof b.url === "string" ? b.url.trim() : "";
  if ((text && url) || (!text && !url)) return null;
  if (text) return { text: text.slice(0, MAX_INPUT) };
  try { new URL(url); } catch (e) { return null; }
  return { url };
}

// ponytail: in-process counter, approximate across Cloud Run instances.
// Move to a Firestore counter if abuse ever shows up.
class DailyLimit {
  constructor(cap) { this.cap = cap; this.counts = new Map(); }
  take(key, now = new Date()) {
    const k = `${key}|${now.toISOString().slice(0, 10)}`;
    const n = (this.counts.get(k) || 0) + 1;
    if (n > this.cap) return false;
    this.counts.set(k, n);
    if (this.counts.size > 5000) this.counts.clear();
    return true;
  }
}

async function importImage(url, { fetchFn = fetch, lookup } = {}) {
  const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };
  if (!(await isPublicUrl(url, lookup))) throw fail("invalid_input", "url not allowed");
  let r;
  try { r = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" }); }
  catch (err) { throw fail("page_unreadable", err.message); }
  if (!r.ok) throw fail("page_unreadable", `fetch ${r.status}`);
  const ct = String(r.headers.get("content-type") || "").split(";")[0].trim();
  const ext = IMAGE_TYPES[ct];
  if (!ext) throw fail("page_unreadable", `not an image: ${ct}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw fail("page_unreadable", "bad size");
  return { fname: `${crypto.randomUUID()}.${ext}`, buffer, contentType: ct };
}

module.exports = function createExtractRouter(ctx) {
  const { requireAuth, authSecret, uploadDir, uploadPublicBase, remoteUploadBase } = ctx;
  const router = express.Router();
  const limit = new DailyLimit(DAILY_CAP);

  function auth(req, res, next) {
    if ("x-demo-key" in req.headers) return next();
    return requireAuth(authSecret)(req, res, next);
  }
  const keyFor = (req) => (req.user && req.user.userId) || `demo:${req.ip}`;
  const sendError = (res, err) => {
    const code = err.code || "internal";
    if (!err.code) console.error("[extract]", err);
    res.status(statusFor(code)).json({ error: code });
  };

  router.post("/properties/extract", auth, async (req, res) => {
    const input = validateBody(req.body);
    if (!input) return res.status(400).json({ error: "invalid_input" });
    if (!limit.take(keyFor(req))) return res.status(429).json({ error: "extract_limit" });
    try {
      const src = await resolve({ ...input, userId: req.user && req.user.userId });
      const { fields, missing } = await parseListing(src.text);
      res.json({ source: src.source, fields, missing, description: src.description.slice(0, 2000), photos: src.photos });
    } catch (err) { sendError(res, err); }
  });

  router.post("/photos/import-url", auth, async (req, res) => {
    const url = req.body && typeof req.body.url === "string" ? req.body.url.trim() : "";
    if (!url) return res.status(400).json({ error: "invalid_input" });
    try {
      const img = await importImage(url);
      await storeBuffer(img, { uploadDir, remoteUploadBase });
      res.json({ url: `${uploadPublicBase}/files/${img.fname}` });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      sendError(res, err);
    }
  });

  return router;
};

module.exports._test = { validateBody, statusFor, DailyLimit, importImage, IMAGE_TYPES };
```

- [ ] **Step 4: Run the test**

Run: `cd server && node routes/extract.test.js`
Expected: `routes/extract.test.js ok`

- [ ] **Step 5: Mount the router**

In `server/index.js`, directly after the `app.use("/api", createIntakeRouter({ ... }));` block (ends around line 105), add:

```js
// ── paste text / link → pre-filled create form ──
const createExtractRouter = require("./routes/extract");
app.use("/api", createExtractRouter({
  requireAuth, authSecret: AUTH_SECRET,
  uploadDir: UPLOAD_DIR, uploadPublicBase: UPLOAD_PUBLIC_BASE, remoteUploadBase: REMOTE_UPLOAD_BASE,
}));
```

Note that `express.json()` must already be applied globally before this point (it is, since `/properties/create` reads `req.body`). Verify with:

Run: `cd server && grep -n "express.json" index.js`
Expected: one line, above line 90.

- [ ] **Step 6: Smoke the route locally**

Run (from `server/`, with the local `.env` loaded the way `npm run local` does; `ANTHROPIC_API_KEY` must be set for a 200, otherwise expect 503):

```bash
cd server && (node index.js & echo $! > /tmp/forly-pid; sleep 3; \
 curl -s -X POST localhost:8787/api/properties/extract -H 'content-type: application/json' -H 'x-demo-key: smoke' \
  -d '{"text":"למכירה 3 חדרים בדיזנגוף 40 תל אביב, קומה 4, 95 מ״ר, 2.9 מיליון, חניה"}'; echo; \
 curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8787/api/properties/extract -H 'content-type: application/json' -H 'x-demo-key: smoke' -d '{}'; \
 kill $(cat /tmp/forly-pid))
```

Expected: first call prints JSON with `"source":"text"`, `fields.address` containing `דיזנגוף 40`, `price` 2900000, and `missing` containing `"neighborhood"` (or `{"error":"extract_unavailable"}` with no key). Second prints `400`.

- [ ] **Step 7: Register the test and commit**

In `server/package.json`, append ` && node routes/extract.test.js` to the `test` script.

```bash
cd server && npm test
git add server/routes/extract.js server/routes/extract.test.js server/index.js server/package.json
git commit -m "feat(extract): /api/properties/extract and /api/photos/import-url"
```

---

### Task 5: Wizard helpers (pure, testable)

**Files:**
- Create: `public-agent/extract.js`
- Test: `public-agent/extract.test.js`
- Modify: `server/package.json` (test script; the existing `dist-tags.test.js` shows the `../public-agent/...` pattern)

**Interfaces:**
- Produces a global `FlyExtract` in the browser (and `module.exports` under Node) with:
  - `isUrl(s) -> boolean`
  - `FIELD_MAP: {fieldName: "#inputId"}` covering every key of the server `SCHEMA`
  - `fillFields(fields, byId) -> string[]` writes only into empty inputs, returns the ids it changed; `byId(selector)` returns an element-like object or `null`
  - `missingFor(missing, byId, isDemo) -> string[]` selectors of inputs still empty, in display order, with `#agName`/`#agPhone` prepended in demo mode
  - `errorKey(status, code) -> string` i18n key for a failed extract
  - `formatPrice(n) -> string` `"2,900,000"`

- [ ] **Step 1: Write the failing test**

Create `public-agent/extract.test.js`:

```js
/* extract.js — the wizard-side helpers that decide what gets written into
   which input. A fake element map stands in for the DOM. */
const assert = require("assert");
const X = require("./extract");

// ── isUrl ──
assert.equal(X.isUrl("https://www.yad2.co.il/item/1"), true);
assert.equal(X.isUrl("  http://x.co "), true);
assert.equal(X.isUrl("3 חדרים ברחוב הרצל"), false);
assert.equal(X.isUrl("www.yad2.co.il/item/1 3 חדרים"), false);

// ── formatPrice ──
assert.equal(X.formatPrice(2900000), "2,900,000");
assert.equal(X.formatPrice(12000), "12,000");

// fake DOM: {value|checked, type, events[]}
function dom(init) {
  const els = {};
  for (const [id, spec] of Object.entries(init)) {
    els[id] = Object.assign({ events: [], dispatchEvent(e) { this.events.push(e.type); } }, spec);
  }
  return { byId: (sel) => els[sel] || null, els };
}
const fresh = () => dom({
  "#pAddress": { value: "", type: "text" }, "#pCity": { value: "", type: "text" }, "#pHood": { value: "", type: "text" },
  "#pType": { value: "sale", type: "select-one" }, "#pPrice": { value: "", type: "text" }, "#pRooms": { value: "", type: "number" },
  "#pSqm": { value: "", type: "number" }, "#pSqmBuilt": { value: "", type: "number" }, "#pSqmBalcony": { value: "", type: "number" },
  "#pSqmGarden": { value: "", type: "number" }, "#pFloor": { value: "", type: "number" }, "#pParking": { value: "", type: "number" },
  "#pElevator": { checked: false, type: "checkbox" }, "#pShabbatElevator": { checked: false, type: "checkbox" }, "#pStorage": { checked: false, type: "checkbox" },
  "#agName": { value: "", type: "text" }, "#agPhone": { value: "", type: "tel" },
});

// ── fillFields writes only empty inputs, formats price, toggles checkboxes, fires events ──
{
  const d = fresh();
  d.els["#pCity"].value = "חיפה";                     // typed by hand → must survive
  const changed = X.fillFields({
    address: "הרצל 1", city: "תל אביב", price: 2900000, rooms: 3.5, floor: 4, deal: "rent",
    elevator: true, storage: null, parking: null, neighborhood: null,
  }, d.byId);
  assert.equal(d.els["#pAddress"].value, "הרצל 1");
  assert.equal(d.els["#pCity"].value, "חיפה");
  assert.equal(d.els["#pPrice"].value, "2,900,000");
  assert.equal(d.els["#pRooms"].value, "3.5");
  assert.equal(d.els["#pFloor"].value, "4");
  assert.equal(d.els["#pType"].value, "rent");
  assert.equal(d.els["#pElevator"].checked, true);
  assert.equal(d.els["#pStorage"].checked, false);
  assert.deepEqual(changed.sort(), ["#pAddress", "#pElevator", "#pFloor", "#pPrice", "#pRooms", "#pType"].sort());
  assert.deepEqual(d.els["#pPrice"].events, ["input", "change"]);
  assert.deepEqual(d.els["#pType"].events, ["change"]);
  assert.deepEqual(d.els["#pCity"].events, []);
}
// deal is never "empty" (select has a default) — only written when the server says so
{
  const d = fresh();
  X.fillFields({ deal: null }, d.byId);
  assert.equal(d.els["#pType"].value, "sale");
}
// unknown keys and missing elements are ignored
{
  const d = fresh();
  assert.deepEqual(X.fillFields({ nope: 1, address: "x" }, () => null), []);
}

// ── missingFor: only still-empty inputs, in display order, demo agent first ──
{
  const d = fresh();
  d.els["#pAddress"].value = "הרצל 1";
  const sel = X.missingFor(["address", "city", "neighborhood", "deal", "floor"], d.byId, false);
  assert.deepEqual(sel, ["#pType", "#pCity", "#pHood", "#pFloor"]);   // display order, address dropped (filled)
  assert.deepEqual(X.missingFor(["city"], d.byId, true), ["#agName", "#agPhone", "#pCity"]);
  d.els["#agName"].value = "רון";
  assert.deepEqual(X.missingFor([], d.byId, true), ["#agPhone"]);
}

// ── errorKey ──
assert.equal(X.errorKey(409, "facebook_not_connected"), "ext_err_fb_connect");
assert.equal(X.errorKey(422, "page_unreadable"), "ext_err_unreadable");
assert.equal(X.errorKey(429, "extract_limit"), "ext_err_limit");
assert.equal(X.errorKey(503, "extract_unavailable"), "ext_err_unavailable");
assert.equal(X.errorKey(500, "whatever"), "ext_err_unavailable");
assert.equal(X.errorKey(0, null), "ext_err_unavailable");
console.log("extract.test.js ok");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node ../public-agent/extract.test.js`
Expected: `Cannot find module './extract'`

- [ ] **Step 3: Implement the helpers**

Create `public-agent/extract.js`:

```js
/* Forly create wizard — "paste text or a link" helpers.
   Pure functions over an element lookup so they run under node for tests and
   in the browser as window.FlyExtract. The wiring (button, fetch, card) lives
   in create.html. */
(function (root) {
  "use strict";

  // server field → input, in the order the card should show them
  var FIELD_MAP = {
    deal: "#pType", address: "#pAddress", city: "#pCity", neighborhood: "#pHood",
    price: "#pPrice", rooms: "#pRooms", size_sqm: "#pSqm", floor: "#pFloor", parking: "#pParking",
    sqm_built: "#pSqmBuilt", sqm_balcony: "#pSqmBalcony", sqm_garden: "#pSqmGarden",
    elevator: "#pElevator", shabbat_elevator: "#pShabbatElevator", storage: "#pStorage",
  };
  var ORDER = Object.keys(FIELD_MAP);

  function isUrl(s) { return /^https?:\/\/\S+$/.test(String(s || "").trim()); }
  function formatPrice(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  function fire(el, type) {
    var ev = (typeof Event === "function") ? new Event(type, { bubbles: true }) : { type: type };
    el.dispatchEvent(ev);
  }
  function isEmpty(el) {
    if (el.type === "checkbox") return !el.checked;
    if (el.type === "select-one") return true;             // has a default; server decides
    return !String(el.value == null ? "" : el.value).trim();
  }

  // Writes only into empty inputs. Returns the selectors it changed.
  function fillFields(fields, byId) {
    var changed = [];
    ORDER.forEach(function (key) {
      var v = fields ? fields[key] : null;
      if (v === null || v === undefined) return;
      var el = byId(FIELD_MAP[key]);
      if (!el || !isEmpty(el)) return;
      if (el.type === "checkbox") { if (v !== true) return; el.checked = true; fire(el, "change"); }
      else if (el.type === "select-one") { if (el.value === v) return; el.value = v; fire(el, "change"); }
      else { el.value = key === "price" ? formatPrice(v) : String(v); fire(el, "input"); fire(el, "change"); }
      changed.push(FIELD_MAP[key]);
    });
    return changed;
  }

  // Selectors of inputs the card should show: server-missing ∩ still-empty, display order.
  function missingFor(missing, byId, isDemo) {
    var out = [];
    if (isDemo) ["#agName", "#agPhone"].forEach(function (sel) {
      var el = byId(sel); if (el && isEmpty(el)) out.push(sel);
    });
    ORDER.forEach(function (key) {
      if ((missing || []).indexOf(key) < 0) return;
      var el = byId(FIELD_MAP[key]);
      if (!el) return;
      if (key === "deal" || isEmpty(el)) out.push(FIELD_MAP[key]);
    });
    return out;
  }

  function errorKey(status, code) {
    if (code === "facebook_not_connected") return "ext_err_fb_connect";
    if (code === "page_unreadable") return "ext_err_unreadable";
    if (code === "extract_limit") return "ext_err_limit";
    return "ext_err_unavailable";
  }

  var api = { FIELD_MAP: FIELD_MAP, isUrl: isUrl, formatPrice: formatPrice, fillFields: fillFields, missingFor: missingFor, errorKey: errorKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FlyExtract = api;
})(typeof window !== "undefined" ? window : this);
```

- [ ] **Step 4: Run the test**

Run: `cd server && node ../public-agent/extract.test.js`
Expected: `extract.test.js ok`

- [ ] **Step 5: Register and commit**

In `server/package.json`, append ` && node ../public-agent/extract.test.js` to the `test` script.

```bash
cd server && npm test
git add public-agent/extract.js public-agent/extract.test.js server/package.json
git commit -m "feat(wizard): pure helpers for filling the form from extracted fields"
```

---

### Task 6: Wizard markup, strings and wiring

**Files:**
- Modify: `public-agent/create.html` (markup at lines 130-243, script tag after line 446, wiring inside the IIFE near `addFiles` at line 838)
- Modify: `public-agent/form-i18n.js` (`he` and `en` dictionaries)
- Modify: `server/create-wizard.test.js` (markers)

**Interfaces:**
- Consumes: `window.FlyExtract` (Task 5), `POST /api/properties/extract` and `POST /api/photos/import-url` (Task 4), existing in-page `photos[]`, `updateLivePreview()`, `syncDealButtons()`, `FT(key)`, `uploadHeaders`, `isDemo`, `$`.
- Produces: `window.__forlyExtract` is not needed; nothing outside `create.html` depends on this task.

- [ ] **Step 1: Add the markers test first**

In `server/create-wizard.test.js`, add to the marker array (inside the existing `[ ... ].forEach`):

```js
  'id="extractBlock"',
  'id="extractInput"',
  'id="extractBtn"',
  'id="extractManual"',
  'id="extractCard"',
  'id="extractCardList"',
  'id="extractShowAll"',
  'id="extractPhotos"',
  'id="manualFields"',
  '<script src="/extract.js"></script>',
  "function runExtract()",
  "function showMissingCard(",
  "function addImportedPhoto(",
  "/api/properties/extract",
  "/api/photos/import-url",
```

And after the loop:

```js
const i18n = fs.readFileSync(path.join(__dirname, "..", "public-agent", "form-i18n.js"), "utf8");
["ext_title", "ext_ph", "ext_btn", "ext_working", "ext_manual", "ext_missing_title", "ext_all_set", "ext_show_all",
 "ext_photos_found", "ext_err_unavailable", "ext_err_unreadable", "ext_err_fb_connect", "ext_err_limit"]
  .forEach((k) => assert.equal((i18n.match(new RegExp(`"${k}":`, "g")) || []).length >= 2, true, `i18n key ${k} in he and en`));
```

Run: `cd server && node create-wizard.test.js`
Expected: fails on `id="extractBlock"`.

- [ ] **Step 2: Add the strings**

In `public-agent/form-i18n.js`, add to the `"he"` object (anywhere inside it, keep the one-line style):

```js
"ext_title":"תארו את הנכס במילים שלכם, או הדביקו קישור","ext_ph":"למשל: למכירה 3 חדרים בדיזנגוף 40 תל אביב, קומה 4, 95 מ״ר, 2.9 מיליון, חניה ומעלית. או קישור ליד2 / מדלן / פוסט בדף הפייסבוק שלכם","ext_btn":"תנו לפורלי למלא","ext_working":"פורלי קוראת...","ext_manual":"או מלאו את הטופס ידנית","ext_missing_title":"פורלי צריכה עוד כמה פרטים","ext_all_set":"הכל מוכן, אפשר להמשיך לתמונות","ext_show_all":"הצגת כל הפרטים","ext_photos_found":"תמונות שנמצאו (בטלו סימון כדי לדלג)","ext_err_unavailable":"פורלי לא הצליחה לקרוא את זה, מלאו ידנית","ext_err_unreadable":"לא הצלחנו לקרוא את הדף, הדביקו את טקסט המודעה במקום","ext_err_fb_connect":"כדי לייבא מפייסבוק צריך לחבר את דף הפייסבוק שלכם, או להדביק את הטקסט","ext_err_limit":"הגעתם למכסה היומית, מלאו ידנית",
```

And to the `"en"` object:

```js
"ext_title":"Describe the property in your own words, or paste a link","ext_ph":"e.g. For sale, 3 rooms at Dizengoff 40 Tel Aviv, 4th floor, 95 sqm, 2.9M, parking and elevator. Or a Yad2 / Madlan link, or a post on your Facebook Page","ext_btn":"Let Forly fill it in","ext_working":"Forly is reading...","ext_manual":"Or fill the form manually","ext_missing_title":"Forly needs a few more details","ext_all_set":"All set, continue to photos","ext_show_all":"Show all details","ext_photos_found":"Photos found (untick to skip)","ext_err_unavailable":"Forly couldn't read that, fill in manually","ext_err_unreadable":"Couldn't read that page, paste the listing text instead","ext_err_fb_connect":"Connect your Facebook Page to import from it, or paste the text","ext_err_limit":"Daily limit reached, fill in manually",
```

Other languages fall back to Hebrew through `t()`.

- [ ] **Step 3: Add the markup**

In `public-agent/create.html`, right after the `section-intro` div that follows `<section class="wizard-panel" data-wizard-panel="1">` (line 131), insert:

```html
      <div id="extractBlock" class="extract-block">
        <label for="extractInput" data-i18n="ext_title">תארו את הנכס במילים שלכם, או הדביקו קישור</label>
        <textarea id="extractInput" rows="5" maxlength="4000" data-i18n-ph="ext_ph"></textarea>
        <div class="extract-actions">
          <button type="button" class="btn btn-gold" id="extractBtn" data-i18n="ext_btn">תנו לפורלי למלא</button>
          <button type="button" class="link-btn" id="extractManual" data-i18n="ext_manual">או מלאו את הטופס ידנית</button>
        </div>
        <p class="form-err" id="extractErr"></p>
      </div>
      <div id="extractCard" class="extract-card hidden">
        <div class="sec-title" id="extractCardTitle" data-i18n="ext_missing_title">פורלי צריכה עוד כמה פרטים</div>
        <div id="extractCardList" class="grid-2"></div>
        <button type="button" class="link-btn" id="extractShowAll" data-i18n="ext_show_all">הצגת כל הפרטים</button>
      </div>
      <div id="extractPhotos" class="extract-photos hidden">
        <div class="sec-title" data-i18n="ext_photos_found">תמונות שנמצאו</div>
        <div id="extractPhotoGrid" class="thumbs"></div>
      </div>
      <div id="manualFields" class="hidden">
```

Then, immediately before the `<div class="wizard-actions form-actions">` line that holds `#nextStage1` (line 242 before the insert), close the wrapper:

```html
      </div><!-- /manualFields -->
```

Add to the page's `<style>` block (anywhere after the `.wizard-step` rules):

```css
  .extract-block{margin:0 0 18px}
  .extract-block textarea{width:100%;min-height:120px;resize:vertical}
  .extract-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px}
  .link-btn{border:0;background:transparent;color:var(--ink-soft);text-decoration:underline;cursor:pointer;font:inherit;padding:0}
  .extract-card{border:1px solid var(--gold);border-radius:12px;padding:16px;margin:0 0 18px}
  .extract-card.all-set{border-color:var(--pa-sage,#5c8a5c)}
  .extract-photos{margin:0 0 18px}
  .extract-photos .t.skip img{opacity:.35}
  #extractBtn[disabled]{opacity:.6;cursor:progress}
```

After `<script src="/form-i18n.js"></script>` (line 446), add:

```html
<script src="/extract.js"></script>
```

- [ ] **Step 4: Add the wiring**

Inside the IIFE in `create.html`, directly after the `addFiles` function (ends around line 872 after the markup insert shifts lines; search for `// ── listing type (sale / rent)` and insert before it):

```js
  // ── paste text / link → Forly fills the form (see extract.js for the pure parts) ──
  var X = window.FlyExtract;
  var importedPhotos = []; // {url, el, skip}
  function revealManual() { $("#manualFields").classList.remove("hidden"); }
  function showExtractErr(key) {
    var el = $("#extractErr"); el.textContent = FT(key); el.classList.add("show");
  }
  function showMissingCard(selectors) {
    var card = $("#extractCard"), list = $("#extractCardList");
    card.classList.remove("hidden");
    list.innerHTML = "";
    if (!selectors.length) {
      card.classList.add("all-set");
      $("#extractCardTitle").textContent = FT("ext_all_set");
      $("#nextStage1").focus();
      return;
    }
    card.classList.remove("all-set");
    $("#extractCardTitle").textContent = FT("ext_missing_title");
    selectors.forEach(function (sel) {
      var el = $(sel);
      // the deal toggle is the buttons, not the hidden select
      var wrap = sel === "#pType" ? document.querySelector(".deal-toggle") : (el && el.closest(".field"));
      if (wrap) list.appendChild(wrap);
    });
  }
  function addImportedPhoto(url) {
    if (importedPhotos.length >= 12) return;
    var t = FLY.el("div", "t", '<img src="' + url + '"><button class="x" type="button">✕</button>');
    var entry = { url: url, el: t, skip: false };
    t.querySelector(".x").addEventListener("click", function () {
      entry.skip = !entry.skip; t.classList.toggle("skip", entry.skip);
    });
    $("#extractPhotoGrid").appendChild(t);
    importedPhotos.push(entry);
    $("#extractPhotos").classList.remove("hidden");
  }
  // Called from validateStageOne's success path: turns ticked found-photos into
  // regular photo entries (server downloads them), then continues.
  function importTickedPhotos() {
    var todo = importedPhotos.filter(function (p) { return !p.skip && !p.done; });
    return Promise.all(todo.map(function (p) {
      p.done = true;
      return fetch("/api/photos/import-url", {
        method: "POST", credentials: "include",
        headers: Object.assign({ "content-type": "application/json" }, uploadHeaders),
        body: JSON.stringify({ url: p.url }),
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j || !j.url || photos.length >= 12) { FLY.toast(FT("err_photo_upload")); return; }
        var t = FLY.el("div", "t", '<img src="' + j.url + '"><button class="x" type="button">✕</button>');
        var entry = { file: null, el: t, publicUrl: j.url, previewUrl: j.url, removed: false, failed: false, uploadPromise: Promise.resolve(j.url) };
        t.querySelector(".x").addEventListener("click", function () {
          entry.removed = true;
          photos = photos.filter(function (q) { return q.el !== t; });
          t.remove(); FLY.deleteUpload(j.url, uploadHeaders); updateLivePreview();
        });
        $("#thumbs").appendChild(t); photos.push(entry); updateLivePreview();
      }).catch(function () { FLY.toast(FT("err_photo_upload")); });
    }));
  }
  function runExtract() {
    var raw = $("#extractInput").value.trim();
    if (!raw) { $("#extractInput").focus(); return; }
    var btn = $("#extractBtn");
    btn.disabled = true; btn.textContent = FT("ext_working");
    $("#extractErr").classList.remove("show");
    var body = X.isUrl(raw) ? { url: raw } : { text: raw };
    fetch("/api/properties/extract", {
      method: "POST", credentials: "include",
      headers: Object.assign({ "content-type": "application/json" }, uploadHeaders),
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, ok: r.ok, body: j }; });
    }).then(function (res) {
      if (!res.ok) {
        showExtractErr(X.errorKey(res.status, res.body.error));
        if (res.status === 422 || res.status === 409) $("#extractInput").focus(); else revealManual();
        return;
      }
      X.fillFields(res.body.fields, $);
      syncDealButtons(); updatePriceLabel(); renderPriceChips();
      if (!$("#pDesc").value.trim()) $("#pDesc").value = String(res.body.description || "").slice(0, 2000);
      (res.body.photos || []).forEach(function (p) { addImportedPhoto(p.url); });
      showMissingCard(X.missingFor(res.body.missing, $, isDemo));
      updateLivePreview();
    }).catch(function () {
      showExtractErr("ext_err_unavailable"); revealManual();
    }).then(function () {
      btn.disabled = false; btn.textContent = FT("ext_btn");
    });
  }
  $("#extractBtn").addEventListener("click", runExtract);
  $("#extractManual").addEventListener("click", function () { revealManual(); $("#pAddress").focus(); });
  $("#extractShowAll").addEventListener("click", revealManual);
```

Then hook the photo import into the step-1 → step-2 transition. The transition lives in `moveWizard` (search `function moveWizard(direction)`), which currently reads:

```js
  function moveWizard(direction) {
    if (direction > wizardStage) {
      if (wizardStage === 1 && !validateStageOne()) return;
      if (wizardStage === 2 && !validateStageTwo()) return;
    }
    setWizardStage(Math.max(1, Math.min(3, direction)), true);
  }
```

Replace it with:

```js
  function moveWizard(direction) {
    if (direction > wizardStage) {
      if (wizardStage === 1 && !validateStageOne()) return;
      if (wizardStage === 2 && !validateStageTwo()) return;
    }
    var go = function () { setWizardStage(Math.max(1, Math.min(3, direction)), true); };
    // leaving step 1 forward: pull the ticked found-photos in first so step 2 shows them
    if (wizardStage === 1 && direction > 1) importTickedPhotos().then(go);
    else go();
  }
```

`updatePriceLabel`, `renderPriceChips` and `syncDealButtons` are `function` declarations inside the same IIFE (lines ~706, ~765, ~881), so they are hoisted and callable from this block. `FT` is a `var` declared at line ~451, above this block.

- [ ] **Step 5: Verify markers and the whole suite**

Run: `cd server && node create-wizard.test.js && npm test`
Expected: both pass.

- [ ] **Step 6: Manual check in the browser**

Start the server (`cd server && npm run local`) and open the demo create page (`http://localhost:8787/create.html?key=<any demo key accepted locally>`; if no demo key is configured locally, log in and open `/create.html`). Check:

1. Step 1 shows the textarea and button; the old fields are hidden; "Or fill the form manually" reveals them.
2. Paste `למכירה 3 חדרים בדיזנגוף 40 תל אביב, קומה 4, 95 מ״ר, 2.9 מיליון, חניה ומעלית` and click the button. Address, city, price (`2,900,000`), rooms, sqm, floor, parking, elevator fill in. The card lists only Neighborhood (and agent name/phone in demo). The deal toggle shows "for sale".
3. Type a neighborhood, click Continue: step 2 opens, validation passes.
4. Type a city by hand first, re-run the parse with different text: the city is untouched.
5. With `FIRECRAWL_API_KEY` set, paste a Madlan listing URL: fields fill, "Photos found" shows thumbnails, untick one, Continue: the ticked ones appear in step 2's thumbs and the unticked one does not.
6. With no `ANTHROPIC_API_KEY`: the error line reads "Forly couldn't read that, fill in manually" and the fields appear.
7. Switch language to English via the flag: all new strings translate.

- [ ] **Step 7: Commit**

```bash
git add public-agent/create.html public-agent/form-i18n.js server/create-wizard.test.js
git commit -m "feat(wizard): paste text or a link and let Forly pre-fill the property form"
```

---

### Task 7: Line-count guard and final pass

**Files:**
- Check only: `public-agent/create.html`, `server/routes/extract.js`, `server/listing-sources.js`

- [ ] **Step 1: Confirm file sizes**

Run: `wc -l public-agent/create.html public-agent/extract.js server/routes/extract.js server/listing-sources.js server/listing-extract.js server/upload-store.js`
Expected: every new server file under 200 lines. `create.html` will exceed 500 lines as it already did (1344 before this work); the new logic added there is the wiring block only. If the wiring block grew past ~120 lines, move `importTickedPhotos` and `addImportedPhoto` into `public-agent/extract.js` behind a `bindPhotoImport({photos, $, FLY, FT, uploadHeaders, updateLivePreview})` function and re-run `create-wizard.test.js`.

- [ ] **Step 2: Full suite and spec status**

Run: `cd server && npm test && node create-wizard.test.js`
Expected: all green.

Edit the `**Status:**` line in `docs/superpowers/specs/2026-09-08-property-intake-design.md` to `implemented on claude/property-form-streamline-8909d7`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-08-property-intake-design.md
git commit -m "docs: mark property intake spec as implemented"
```

No deploy. Tell the user the branch is ready and which env vars production needs (`FIRECRAWL_API_KEY`, and `ANTHROPIC_API_KEY` already present for photo captions).
