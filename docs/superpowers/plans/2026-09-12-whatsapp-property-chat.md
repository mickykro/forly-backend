# WhatsApp Property Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent sends a listing link, listing text, photos or "נכס חדש" in the Forly WhatsApp chat and, after a short Hebrew Q&A, gets a property page.

**Architecture:** n8n (Business Handler2) forwards every registered-agent message to `POST /api/whatsapp/intake` and stops when the server answers `handled:true`. The server keeps one draft per agent in `property_drafts/{phone}`, runs a small state machine (`property-draft.js` pure helpers, `whatsapp-intake.js` turn handler), and sends every reply itself over Green API. Listing creation reuses `server/listing-create.js`; the n8n Property Page Builder still sends the "page is live" message.

**Tech Stack:** Node 22, Express 4, Firestore (firebase-admin) with the in-memory fallback in `server/db.js`, Green API (`utils.sendWhatsApp` / `utils.sendWhatsAppButtons`), plain-node `assert` tests run by `npm test` in `server/`.

**Spec:** `docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md`

## Global Constraints

- All chat copy is Hebrew and lives only in `server/whatsapp-replies.js`.
- Button texts are exactly the command words: `כן`, `לא`, `ביטול`, `דלג`, `ממשיכים`, `המשך`, `חדש`. Green API allows at most 3 buttons, 25 chars each.
- Required fields before building: `city`, `price`, `rooms`, and 3 photos (`MIN_PHOTOS` from `server/listing-create.js`).
- Ask order: `city, price, rooms, deal, size_sqm, floor, parking, neighborhood, description`.
- Pause after 2 h of silence (`PAUSE_MS = 2 * 60 * 60 * 1000`); `offered` / `resume_prompt` drafts older than 2 h are dropped on read.
- Photo batch timer: 20 s, in-process, per phone.
- Per-agent extraction cap: 20 per UTC day (`DailyLimit` from `server/routes/extract.js`).
- Every file stays under 500 lines. Tests are plain node scripts registered in `server/package.json` `scripts.test`.
- Never commit `.env`, secrets, or `.claude-flow/`.
- Commit messages end with the attribution trailer used on this branch:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015aittAWgQAjVdUXhQshKFM
  ```
- Work on branch `claude/whatsapp-link-property-page-7wm9xh`; run `cd server && npm test` before every commit.

## File map

| File | Status | Responsibility |
|---|---|---|
| `server/db.js` | modify | `getDraft`, `saveDraft`, `deleteDraft`; `mem.drafts` |
| `server/property-draft.js` | create | pure: constants, `findUrl`, `command`, `openerKind`, parsers, `newDraft`, `nextStep`, `isPaused`, `isExpiredPrompt`, `summary`, `toListingBody` |
| `server/property-draft.test.js` | create | tests for the above |
| `server/whatsapp-replies.js` | create | pure: every message as `fn(...) → { text, buttons? }` |
| `server/whatsapp-intake.js` | rewrite | `handleTurn(input, deps)`: claim rules + turn order, no I/O |
| `server/whatsapp-intake.test.js` | rewrite | turn tests with fake deps |
| `server/routes/whatsapp.js` | rewrite | endpoint: auth, load, `handleTurn`, persist, send, photo timer |
| `server/routes/pages.js` | modify | delete the draft when the page is created |
| `server/index.js` | modify | pass `sendButtons` to the router |
| `server/package.json` | modify | register the new test |

---

### Task 1: Confirm the Green API payload shape n8n will forward

The server never sees Green API's raw webhook; n8n maps it. This task pins the two field names the mapping depends on so Task 9 is not guesswork.

**Files:** none in the repo (record findings in the spec's "[Unverified]" paragraph).

- [ ] **Step 1: Capture an image message**

In n8n open **Call4li - Main Router** (`sIKcjzYee7viwk1e`) → Executions. Send a photo from a registered agent's phone to the Forly number. Open the newest execution → node `Code - Parse Webhook` → output. Note `fullData.messageData.typeMessage` and the key holding the download URL (expected `fullData.messageData.fileMessageData.downloadUrl`).

- [ ] **Step 2: Capture a button reply**

From any n8n Green API node (e.g. **Send Motion Question** in Business Handler2) send yourself an interactive-buttons message, tap a button, and open the resulting Main Router execution. Note `typeMessage` (expected `buttonsResponseMessage`) and the key holding the tapped text (expected `fullData.messageData.buttonsResponseMessage.selectedButtonText`).

- [ ] **Step 3: Record**

Replace the `[Unverified]` paragraph in `docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md` with the confirmed paths. If they differ from the expectations, adjust the expressions in Task 9 Step 2 accordingly (nothing in the server changes).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md
git commit -m "docs(spec): confirm Green API image and button payload paths"
```

---

### Task 2: Draft storage in db.js

**Files:**
- Modify: `server/db.js` (the `mem` object near line 11, a new section before `module.exports`, and the export list)
- Test: `server/db-drafts.test.js` (create)

**Interfaces:**
- Produces: `db.getDraft(phone) → Promise<draft|null>`, `db.saveDraft(draft) → Promise<void>` (whole-document set keyed by `draft.phone`), `db.deleteDraft(phone) → Promise<void>`.

- [ ] **Step 1: Write the failing test**

`server/db-drafts.test.js`:

```js
/* db.js — property draft helpers on the in-memory store. */
const assert = require("assert");
const db = require("./db");

(async () => {
  assert.equal(await db.getDraft("972500000001"), null);
  await db.saveDraft({ phone: "972500000001", status: "active", photos: [] });
  assert.equal((await db.getDraft("972500000001")).status, "active");
  await db.saveDraft({ phone: "972500000001", status: "building", photos: ["a"] });
  assert.deepEqual((await db.getDraft("972500000001")).photos, ["a"], "saveDraft replaces the whole doc");
  await db.deleteDraft("972500000001");
  assert.equal(await db.getDraft("972500000001"), null);
  await db.deleteDraft("972500000001"); // idempotent
  console.log("db-drafts.test.js ok");
})();
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd server && node db-drafts.test.js`
Expected: `TypeError: db.getDraft is not a function`

- [ ] **Step 3: Implement**

In `server/db.js`, add `drafts: new Map()` to the `mem` literal:

```js
const mem = { listings: new Map(), pages: new Map(), leads: new Map(), leadSubmissions: [], adminMessages: [], throttle: new Map(), otps: new Map(), portalEvents: [], connections: new Map(), distributions: new Map(), postActions: [], groupCatalog: [], shareSessions: new Map(), propertyGroups: new Map(), drafts: new Map() };
```

Add before `module.exports`:

```js
// ── property drafts (WhatsApp chat intake, see whatsapp-intake.js) ──
// One doc per agent phone; saveDraft replaces the whole doc on purpose so a
// cleared field (skipped, pending_opener: null) never lingers from a merge.
async function getDraft(phone) {
  if (db) { const d = await db.collection("property_drafts").doc(phone).get(); return d.exists ? d.data() : null; }
  return mem.drafts.get(phone) || null;
}

async function saveDraft(draft) {
  if (db) await db.collection("property_drafts").doc(draft.phone).set(draft);
  else mem.drafts.set(draft.phone, draft);
}

async function deleteDraft(phone) {
  if (db) await db.collection("property_drafts").doc(phone).delete();
  else mem.drafts.delete(phone);
}
```

Add to the export list: `getDraft, saveDraft, deleteDraft,`.

- [ ] **Step 4: Run the test**

Run: `cd server && node db-drafts.test.js`
Expected: `db-drafts.test.js ok`

- [ ] **Step 5: Register and commit**

In `server/package.json`, append ` && node db-drafts.test.js` to the `test` script (before `&& node ../public-agent/extract.test.js`). Run `npm test` (all green), then:

```bash
git add server/db.js server/db-drafts.test.js server/package.json
git commit -m "feat(db): property draft helpers for the WhatsApp intake"
```

---

### Task 3: property-draft.js — parsers and opener detection

**Files:**
- Create: `server/property-draft.js`
- Test: `server/property-draft.test.js`

**Interfaces:**
- Produces:
  - `REQUIRED = ["city","price","rooms"]`, `ASK_ORDER` (9 fields), `PAUSE_MS`, `MIN_PHOTOS`
  - `findUrl(text) → string|null`
  - `command(text) → "cancel"|"skip"|"continue"|"yes"|"no"|"resume"|"new"|null`
  - `openerKind(text) → "link"|"keyword"|"text"|null`
  - `parseAnswer(field, text) → value|null` for every field in `ASK_ORDER`
  - `isRequired(field) → boolean`

- [ ] **Step 1: Write the failing test**

`server/property-draft.test.js` (first half; Task 4 appends):

```js
/* property-draft.js — pure helpers behind the WhatsApp property chat. */
const assert = require("assert");
const D = require("./property-draft");

// ── links, commands, openers ──
assert.equal(D.findUrl("תראה https://www.yad2.co.il/item/abc."), "https://www.yad2.co.il/item/abc");
assert.equal(D.findUrl("(http://madlan.co.il/x?y=1)"), "http://madlan.co.il/x?y=1");
assert.equal(D.findUrl("no link"), null);
assert.equal(D.findUrl(null), null);

assert.equal(D.command(" ביטול "), "cancel");
assert.equal(D.command("דלג"), "skip");
assert.equal(D.command("ממשיכים!"), "continue");
assert.equal(D.command("כן"), "yes");
assert.equal(D.command("לא"), "no");
assert.equal(D.command("המשך"), "resume");
assert.equal(D.command("חדש"), "new");
assert.equal(D.command("כן בבקשה"), null);

assert.equal(D.openerKind("https://x.co/1"), "link");
assert.equal(D.openerKind("נכס חדש"), "keyword");
assert.equal(D.openerKind("דף נכס"), "keyword");
assert.equal(D.openerKind("למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת"), "text");
assert.equal(D.openerKind("היי מה שלומך"), null);
assert.equal(D.openerKind("3 חדרים"), null, "too short to be a listing");

// ── answer parsers ──
assert.equal(D.parseAnswer("price", "2,900,000"), 2900000);
assert.equal(D.parseAnswer("price", "2.9M"), 2900000);
assert.equal(D.parseAnswer("price", "2.9 מיליון"), 2900000);
assert.equal(D.parseAnswer("price", "890 אלף"), 890000);
assert.equal(D.parseAnswer("price", "12,000 לחודש"), 12000);
assert.equal(D.parseAnswer("price", "לא יודע"), null);
assert.equal(D.parseAnswer("rooms", "3.5"), 3.5);
assert.equal(D.parseAnswer("rooms", "4 חדרים"), 4);
assert.equal(D.parseAnswer("rooms", "הרבה"), null);
assert.equal(D.parseAnswer("size_sqm", "כ-85 מ״ר"), 85);
assert.equal(D.parseAnswer("floor", "קומה 3"), 3);
assert.equal(D.parseAnswer("floor", "קרקע"), 0);
assert.equal(D.parseAnswer("parking", "אין"), 0);
assert.equal(D.parseAnswer("parking", "2"), 2);
assert.equal(D.parseAnswer("deal", "להשכרה"), "rent");
assert.equal(D.parseAnswer("deal", "מכירה"), "sale");
assert.equal(D.parseAnswer("deal", "אולי"), null);
assert.equal(D.parseAnswer("city", "  תל אביב "), "תל אביב");
assert.equal(D.parseAnswer("city", "   "), null);
assert.equal(D.parseAnswer("neighborhood", "x".repeat(100)).length, 60);
assert.equal(D.parseAnswer("description", "y".repeat(3000)).length, 2000);
assert.equal(D.isRequired("city"), true);
assert.equal(D.isRequired("floor"), false);
assert.deepEqual(D.ASK_ORDER, ["city", "price", "rooms", "deal", "size_sqm", "floor", "parking", "neighborhood", "description"]);

console.log("property-draft.test.js (parsers) ok");
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd server && node property-draft.test.js`
Expected: `Cannot find module './property-draft'`

- [ ] **Step 3: Implement**

`server/property-draft.js`:

```js
/*
 * property-draft.js — pure helpers behind the WhatsApp property chat.
 *
 * No I/O. Everything the turn handler (whatsapp-intake.js) needs to decide
 * "is this message ours", "what do we ask next" and "what did the agent
 * answer" lives here so it can be unit-tested without Express or Firestore.
 */
const { SCHEMA } = require("./listing-extract");
const { MIN_PHOTOS } = require("./listing-create");
const { asMillis } = require("./utils");

const REQUIRED = ["city", "price", "rooms"];
const OPTIONAL = ["deal", "size_sqm", "floor", "parking", "neighborhood", "description"];
const ASK_ORDER = [...REQUIRED, ...OPTIONAL];
const PAUSE_MS = 2 * 60 * 60 * 1000;

const KEYWORDS = ["נכס חדש", "דף נכס", "דף חדש"];
const LISTING_HINTS = ["חדרים", "חד׳", "חד'", "מ״ר", "מ\"ר", "קומה", "למכירה", "להשכרה", "₪", "מחיר", "שכירות"];
const COMMANDS = { "ביטול": "cancel", "דלג": "skip", "ממשיכים": "continue", "כן": "yes", "לא": "no", "המשך": "resume", "חדש": "new" };

// First http(s) link in a chat message; trailing punctuation is not part of it.
const URL_RE = /https?:\/\/[^\s<>"']+/i;
function findUrl(text) {
  const m = URL_RE.exec(String(text || ""));
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?)\]]+$/, "");
  try { return new URL(url).href; } catch (e) { return null; }
}

const clean = (t) => String(t || "").trim().replace(/[!.?]+$/, "").trim();
function command(text) { return COMMANDS[clean(text)] || null; }
function isKeyword(text) { return KEYWORDS.includes(clean(text)); }
function looksLikeListing(text) {
  const t = String(text || "");
  return t.length >= 40 && LISTING_HINTS.filter((h) => t.includes(h)).length >= 2;
}
function openerKind(text) {
  if (findUrl(text)) return "link";
  if (isKeyword(text)) return "keyword";
  if (looksLikeListing(text)) return "text";
  return null;
}

// ── answer parsers (no LLM) ──
const firstNumber = (t) => { const m = /(\d+(?:[.,]\d+)*)/.exec(String(t || "")); return m ? Number(m[1].replace(/,/g, "")) : null; };
const num = (t) => { const n = firstNumber(t); return Number.isFinite(n) ? n : null; };
const int = (t) => { const n = num(t); return n === null ? null : Math.round(n); };
const text = (max) => (t) => { const s = String(t || "").trim(); return s ? s.slice(0, max) : null; };

function parsePrice(t) {
  const m = /(\d+(?:[.,]\d+)*)\s*(מיליון|מ'|m|אלף|k)?/i.exec(String(t || ""));
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = (m[2] || "").toLowerCase();
  if (/^(מיליון|מ'|m)$/.test(mult)) n *= 1e6;
  else if (/^(אלף|k)$/.test(mult)) n *= 1e3;
  return n > 0 ? Math.round(n) : null;
}
function parseDeal(t) {
  const s = String(t || "");
  if (/להשכרה|השכרה|שכירות/.test(s)) return "rent";
  if (/למכירה|מכירה/.test(s)) return "sale";
  return null;
}
function parseFloor(t) { return /קרקע/.test(String(t || "")) ? 0 : int(t); }
function parseParking(t) { return /^(אין|ללא|לא)$/.test(clean(t)) ? 0 : int(t); }

const PARSERS = {
  city: text(60), price: parsePrice, rooms: num, deal: parseDeal, size_sqm: num,
  floor: parseFloor, parking: parseParking, neighborhood: text(60), description: text(2000),
};
function parseAnswer(field, t) { return PARSERS[field] ? PARSERS[field](t) : null; }
function isRequired(field) { return REQUIRED.includes(field); }

module.exports = {
  REQUIRED, OPTIONAL, ASK_ORDER, PAUSE_MS, MIN_PHOTOS, SCHEMA,
  findUrl, command, openerKind, parseAnswer, isRequired, asMillis,
};
```

- [ ] **Step 4: Run the test**

Run: `cd server && node property-draft.test.js`
Expected: `property-draft.test.js (parsers) ok`

- [ ] **Step 5: Commit**

```bash
git add server/property-draft.js server/property-draft.test.js
git commit -m "feat(whatsapp): property-draft parsers and opener detection"
```

---

### Task 4: property-draft.js — draft state helpers

**Files:**
- Modify: `server/property-draft.js`
- Modify: `server/property-draft.test.js` (append)
- Modify: `server/package.json` (register test)

**Interfaces:**
- Produces:
  - `newDraft(phone, source, now) → draft` (shape per spec; `fields` has every `SCHEMA` key plus `description`, all `null`)
  - `nextStep(draft) → { kind:"ask", field } | { kind:"photos" } | { kind:"confirm" }`
  - `isPaused(draft, now) → boolean` (active + silent > PAUSE_MS)
  - `isExpiredPrompt(draft, now) → boolean` (offered/resume_prompt + older than PAUSE_MS)
  - `summary(draft) → { city, neighborhood, price, rooms, deal, size_sqm, floor, parking, photos }`
  - `toListingBody(draft) → body for listing-create.createListing`
  - `touch(draft, now) → draft` (sets `updated_at`)

- [ ] **Step 1: Append the failing tests**

Append to `server/property-draft.test.js` (before the final `console.log`, and change that log to `"property-draft.test.js ok"`):

```js
// ── draft state ──
const t0 = new Date("2026-09-12T10:00:00Z");
const d = D.newDraft("972501234567", "keyword", t0);
assert.equal(d.status, "active");
assert.equal(d.fields.city, null);
assert.equal(d.fields.description, null);
assert.ok("elevator" in d.fields, "fields carry every extractor key");
assert.deepEqual(D.nextStep(d), { kind: "ask", field: "city" });

d.fields.city = "חיפה"; d.fields.price = 1500000; d.fields.rooms = 4;
assert.deepEqual(D.nextStep(d), { kind: "ask", field: "deal" });
d.skipped.push("deal", "size_sqm", "floor", "parking", "neighborhood", "description");
assert.deepEqual(D.nextStep(d), { kind: "photos" });
d.photos.push("a", "b");
assert.deepEqual(D.nextStep(d), { kind: "photos" });
d.photos.push("c");
assert.deepEqual(D.nextStep(d), { kind: "confirm" });

assert.equal(D.isPaused(d, new Date(t0.getTime() + D.PAUSE_MS - 1)), false);
assert.equal(D.isPaused(d, new Date(t0.getTime() + D.PAUSE_MS + 1)), true);
assert.equal(D.isPaused({ ...d, status: "building" }, new Date(t0.getTime() + D.PAUSE_MS + 1)), false);
assert.equal(D.isExpiredPrompt({ ...d, status: "offered" }, new Date(t0.getTime() + D.PAUSE_MS + 1)), true);
assert.equal(D.isExpiredPrompt({ ...d, status: "offered" }, t0), false);
assert.equal(D.isExpiredPrompt(d, new Date(t0.getTime() + D.PAUSE_MS + 1)), false);

const s = D.summary(d);
assert.deepEqual([s.city, s.price, s.rooms, s.photos], ["חיפה", 1500000, 4, 3]);

d.fields.deal = "rent"; d.fields.size_sqm = 90; d.fields.elevator = true; d.fields.description = "נחמד";
const body = D.toListingBody(d);
assert.equal(body.listing_type, "rent");
assert.equal(body.size_sqm, 90);
assert.equal(body.elevator, true);
assert.equal(body.shabbat_elevator, false);
assert.equal(body.address, "");
assert.equal(body.description, "נחמד");
assert.deepEqual(body.photos_urls, ["a", "b", "c"]);
assert.equal(D.toListingBody({ ...d, fields: { ...d.fields, deal: null } }).listing_type, "sale");

const t1 = new Date(t0.getTime() + 1000);
assert.equal(D.touch(d, t1).updated_at, t1);
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && node property-draft.test.js`
Expected: `TypeError: D.newDraft is not a function`

- [ ] **Step 3: Implement**

Append to `server/property-draft.js` before `module.exports`, and add the new names to the export list:

```js
// ── draft state ──
function emptyFields() {
  const f = {};
  for (const k of Object.keys(SCHEMA)) f[k] = null;
  f.description = null;
  return f;
}

function newDraft(phone, source, now = new Date()) {
  return {
    phone, status: "active", source, fields: emptyFields(), skipped: [], photos: [],
    pending_opener: null, listing_id: null, created_at: now, updated_at: now,
  };
}

function touch(draft, now = new Date()) { draft.updated_at = now; return draft; }

function nextStep(draft) {
  for (const f of ASK_ORDER) {
    if (draft.fields[f] === null && !draft.skipped.includes(f)) return { kind: "ask", field: f };
  }
  if (draft.photos.length < MIN_PHOTOS) return { kind: "photos" };
  return { kind: "confirm" };
}

const silentFor = (draft, now) => now.getTime() - asMillis(draft.updated_at);
function isPaused(draft, now = new Date()) { return draft.status === "active" && silentFor(draft, now) > PAUSE_MS; }
function isExpiredPrompt(draft, now = new Date()) {
  return (draft.status === "offered" || draft.status === "resume_prompt") && silentFor(draft, now) > PAUSE_MS;
}

function summary(draft) {
  const f = draft.fields;
  return {
    city: f.city, neighborhood: f.neighborhood, price: f.price, rooms: f.rooms, deal: f.deal,
    size_sqm: f.size_sqm, floor: f.floor, parking: f.parking, photos: draft.photos.length,
  };
}

// Same shape the create form posts (see listing-create.validateListing).
function toListingBody(draft) {
  const f = draft.fields;
  return {
    city: f.city, price: f.price, rooms: f.rooms,
    address: f.address || "", neighborhood: f.neighborhood || "",
    listing_type: f.deal || "sale",
    size_sqm: f.size_sqm, size_built: f.sqm_built, size_balcony: f.sqm_balcony, size_garden: f.sqm_garden,
    floor: f.floor, parking: f.parking,
    storage: !!f.storage, elevator: !!f.elevator, shabbat_elevator: !!f.shabbat_elevator,
    description: String(f.description || "").slice(0, 2000),
    photos_urls: draft.photos.slice(),
  };
}
```

Export list becomes:

```js
module.exports = {
  REQUIRED, OPTIONAL, ASK_ORDER, PAUSE_MS, MIN_PHOTOS, SCHEMA,
  findUrl, command, openerKind, parseAnswer, isRequired, asMillis,
  newDraft, touch, nextStep, isPaused, isExpiredPrompt, summary, toListingBody,
};
```

Check `asMillis` in `server/utils.js` accepts a `Date` (it does: it handles Firestore timestamps, Dates and numbers).

- [ ] **Step 4: Run the test**

Run: `cd server && node property-draft.test.js`
Expected: `property-draft.test.js ok`

- [ ] **Step 5: Register and commit**

Append ` && node property-draft.test.js` to the `test` script in `server/package.json`. Run `npm test`.

```bash
git add server/property-draft.js server/property-draft.test.js server/package.json
git commit -m "feat(whatsapp): draft state machine helpers"
```

---

### Task 5: whatsapp-replies.js — all Hebrew copy

**Files:**
- Create: `server/whatsapp-replies.js`
- Test: `server/whatsapp-replies.test.js`

**Interfaces:**
- Produces functions returning `{ text: string, buttons?: string[] }` (button texts are command words):
  `offer(n)`, `opened(kind, fields)`, `ask(field)`, `invalid(field)`, `required(field)`, `askPhotos()`, `photosProgress(n)`, `photosSaved(n)`, `confirm(summary)`, `building(summary)`, `cancelled()`, `declined()`, `resumePrompt(summary)`, `sourceError(code, createUrl)`, `extractLimit(createUrl)`, `createFailed(createUrl)`, `noLinkHint(createUrl)`.
- `LABELS[field]` Hebrew field labels.

- [ ] **Step 1: Write the failing test**

`server/whatsapp-replies.test.js`:

```js
/* whatsapp-replies.js — every reply is a { text, buttons? } with command-word buttons. */
const assert = require("assert");
const R = require("./whatsapp-replies");
const COMMANDS = new Set(["כן", "לא", "ביטול", "דלג", "ממשיכים", "המשך", "חדש", "למכירה", "להשכרה"]);

const sum = { city: "חיפה", neighborhood: null, price: 1500000, rooms: 4, deal: "sale", size_sqm: 90, floor: 3, parking: 1, photos: 5 };
const all = [
  R.offer(4), R.opened("link", { rooms: 3.5, city: "תל אביב", neighborhood: "פלורנטין", price: 2900000 }),
  R.opened("keyword", {}), R.opened("text", { rooms: null, city: null, price: null }),
  ...["city", "price", "rooms", "deal", "size_sqm", "floor", "parking", "neighborhood", "description"].map(R.ask),
  R.invalid("price"), R.required("city"), R.askPhotos(), R.photosProgress(2), R.photosProgress(4), R.photosSaved(1),
  R.confirm(sum), R.building(sum), R.cancelled(), R.declined(), R.resumePrompt(sum),
  ...["page_unreadable", "facebook_not_connected", "extract_unavailable", "whatever"].map((c) => R.sourceError(c, "https://a/create.html")),
  R.extractLimit("https://a/create.html"), R.createFailed("https://a/create.html"), R.noLinkHint("https://a/create.html"),
];
for (const r of all) {
  assert.ok(r && typeof r.text === "string" && r.text.trim(), "every reply has text");
  for (const b of r.buttons || []) {
    assert.ok(COMMANDS.has(b), `button "${b}" must be a command word`);
    assert.ok(b.length <= 25);
  }
  assert.ok(!r.buttons || r.buttons.length <= 3);
}
assert.deepEqual(R.offer(4).buttons, ["כן", "לא"]);
assert.deepEqual(R.confirm(sum).buttons, ["כן", "ביטול"]);
assert.deepEqual(R.resumePrompt(sum).buttons, ["המשך", "חדש"]);
assert.deepEqual(R.photosProgress(4).buttons, ["ממשיכים"]);
assert.equal(R.photosProgress(2).buttons, undefined, "under 3 photos: ask for more, no continue button");
assert.deepEqual(R.ask("deal").buttons, ["למכירה", "להשכרה"]);
assert.match(R.ask("floor").text, /דלג/, "optional questions mention skip");
assert.doesNotMatch(R.ask("city").text, /דלג/, "required questions do not");
assert.match(R.confirm(sum).text, /1,500,000/);
assert.match(R.confirm(sum).text, /5 תמונות/);
assert.match(R.opened("link", { rooms: 3.5, city: "תל אביב", neighborhood: "פלורנטין", price: 2900000 }).text, /3\.5 חד׳ בפלורנטין/);
assert.equal(R.LABELS.size_sqm, "שטח במ״ר");
console.log("whatsapp-replies.test.js ok");
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && node whatsapp-replies.test.js`
Expected: `Cannot find module './whatsapp-replies'`

- [ ] **Step 3: Implement**

`server/whatsapp-replies.js`:

```js
/*
 * whatsapp-replies.js — every message the property chat sends, in one place.
 * Each function returns { text, buttons? }. Button texts ARE the command words
 * property-draft.command() understands, so a tap and a typed word behave the
 * same. Green API: max 3 buttons, 25 chars each (utils.sendWhatsAppButtons).
 */
const ils = (n) => `₪${Number(n).toLocaleString("en-US")}`;

const LABELS = {
  city: "עיר", price: "מחיר", rooms: "מספר חדרים", deal: "סוג עסקה", size_sqm: "שטח במ״ר",
  floor: "קומה", parking: "חניות", neighborhood: "שכונה", description: "תיאור",
};

const QUESTIONS = {
  city: "באיזו עיר הנכס?",
  price: "מה המחיר? (למשל 2,900,000 או 2.9 מיליון; לשכירות — לחודש)",
  rooms: "כמה חדרים? (אפשר גם 3.5)",
  deal: "למכירה או להשכרה?",
  size_sqm: "מה השטח במ״ר?",
  floor: "באיזו קומה? (קרקע = 0)",
  parking: "כמה חניות? (אין = 0)",
  neighborhood: "באיזו שכונה?",
  description: "רוצים להוסיף תיאור קצר לנכס? שלחו טקסט חופשי.",
};
const REQUIRED = new Set(["city", "price", "rooms"]);

function ask(field) {
  const optional = !REQUIRED.has(field);
  const r = { text: QUESTIONS[field] + (optional ? "\n(או דלג)" : "") };
  if (field === "deal") r.buttons = ["למכירה", "להשכרה"];
  return r;
}
function invalid(field) { return { text: `לא הצלחתי להבין את ה${LABELS[field]}. ${QUESTIONS[field]}` }; }
function required(field) { return { text: `${LABELS[field]} הוא שדה חובה לדף. ${QUESTIONS[field]}` }; }

function headline(f) {
  const where = f.neighborhood || f.city;
  const parts = [];
  if (f.rooms) parts.push(`${f.rooms} חד׳${where ? ` ב${where}` : ""}`);
  else if (where) parts.push(where);
  if (f.price) parts.push(ils(f.price));
  return parts.join(", ");
}

function opened(kind, fields) {
  if (kind === "keyword") return { text: "מתחילים דף נכס חדש 🏠 אשאל כמה שאלות קצרות." };
  const h = headline(fields || {});
  return { text: h ? `קראתי את המודעה: ${h}. אשלים איתך את מה שחסר.` : "קראתי את המודעה אבל לא מצאתי בה פרטים ברורים. נשלים ביחד." };
}

function offer(n) { return { text: `ערכתי ${n} תמונות ✨ לבנות מהן דף נכס?`, buttons: ["כן", "לא"] }; }
function askPhotos() { return { text: "עכשיו התמונות 📸 שלחו לפחות 3 תמונות של הנכס." }; }
function photosProgress(n) {
  if (n < 3) return { text: `יש לי ${n} תמונות. צריך לפחות 3 — שלחו עוד.` };
  return { text: `יש לי ${n} תמונות. עוד תמונות, או ממשיכים?`, buttons: ["ממשיכים"] };
}
function photosSaved(n) { return { text: `שמרתי ${n} תמונות לנכס.` }; }

function summaryLines(s) {
  const lines = [];
  if (s.rooms) lines.push(`${s.rooms} חד׳`);
  if (s.city) lines.push(s.neighborhood ? `${s.neighborhood}, ${s.city}` : s.city);
  if (s.price) lines.push(ils(s.price));
  if (s.deal) lines.push(s.deal === "rent" ? "להשכרה" : "למכירה");
  if (s.size_sqm) lines.push(`${s.size_sqm} מ״ר`);
  if (s.floor !== null && s.floor !== undefined) lines.push(`קומה ${s.floor}`);
  if (s.parking) lines.push(`${s.parking} חניות`);
  lines.push(`${s.photos} תמונות`);
  return lines.join(" · ");
}
function confirm(s) { return { text: `סיכום:\n${summaryLines(s)}\n\nלבנות את דף הנכס?`, buttons: ["כן", "ביטול"] }; }
function building(s) { return { text: `קיבלתי! 🏠 ${headline(s)}\nאני בונה את דף הנכס — אשלח לך קישור כשהוא מוכן (כמה דקות).` }; }
function cancelled() { return { text: "ביטלתי את הטיוטה. אפשר להתחיל מחדש עם קישור, טקסט או ״נכס חדש״." }; }
function declined() { return { text: "בסדר, לא בונים דף מהתמונות האלה." }; }
function resumePrompt(s) {
  return { text: `יש לך טיוטה פתוחה: ${summaryLines(s)}.\nלהמשיך אותה או להתחיל נכס חדש?`, buttons: ["המשך", "חדש"] };
}

const SOURCE_ERRORS = {
  facebook_not_connected: "כדי לקרוא פוסטים מפייסבוק צריך קודם לחבר את עמוד הפייסבוק בפאנל.",
  page_unreadable: "לא הצלחתי לקרוא את הדף בקישור. אולי המודעה פרטית או הוסרה.",
  extract_unavailable: "יש לי תקלה זמנית בקריאת מודעות.",
};
function sourceError(code, createUrl) {
  const why = SOURCE_ERRORS[code] || SOURCE_ERRORS.page_unreadable;
  return { text: `${why}\nאפשר להדביק כאן את טקסט המודעה, לשלוח תמונות, או למלא ידנית: ${createUrl}` };
}
function extractLimit(createUrl) { return { text: `הגעת למכסת הקישורים היומית. נסו מחר, או מלאו ידנית: ${createUrl}` }; }
function createFailed(createUrl) { return { text: `משהו השתבש ביצירת הדף. נסו שוב, או מלאו ידנית: ${createUrl}` }; }
function noLinkHint(createUrl) {
  return { text: `שלחו לי קישור למודעה (יד2, מדלן, פייסבוק), את טקסט המודעה, או כתבו ״נכס חדש״.\nאפשר גם ידנית: ${createUrl}` };
}

module.exports = {
  LABELS, ask, invalid, required, opened, offer, askPhotos, photosProgress, photosSaved,
  confirm, building, cancelled, declined, resumePrompt, sourceError, extractLimit, createFailed, noLinkHint,
};
```

- [ ] **Step 4: Run the test**

Run: `cd server && node whatsapp-replies.test.js`
Expected: `whatsapp-replies.test.js ok`

- [ ] **Step 5: Register and commit**

Append ` && node whatsapp-replies.test.js` to the `test` script. Run `npm test`.

```bash
git add server/whatsapp-replies.js server/whatsapp-replies.test.js server/package.json
git commit -m "feat(whatsapp): Hebrew reply copy for the property chat"
```

---

### Task 6: handleTurn — openers and the question loop

Rewrites `server/whatsapp-intake.js` from the link-only first cut into the turn handler. Photos, confirm/build, offer, pause/resume come in Tasks 7 and 8; this task makes link / text / keyword openers and the field questions work end to end.

**Files:**
- Rewrite: `server/whatsapp-intake.js`
- Rewrite: `server/whatsapp-intake.test.js`

**Interfaces:**
- Consumes: everything from `property-draft.js` (Tasks 3-4) and `whatsapp-replies.js` (Task 5).
- Produces:
  ```js
  handleTurn(input, deps) → Promise<Turn>
  input: { phone, text?: string, fileUrl?: string|null, event?: "photos_edited"|"photo_timer"|null,
           photos?: string[], draft: draft|null, now?: Date }
  deps:  { business: object|null, resolve, parseListing, importPhoto(url)→Promise<hostedUrl>,
           quota: { consume }|null, createListing(phone, body)→Promise<{listing_id}|{error}>,
           createUrl: string, extractAllowed(phone)→boolean }
  Turn:  { handled: boolean, status: string, replies: Reply[], draft?: draft (persist), del?: true (delete),
           listing_id?: string, armPhotoTimer?: true }
  ```
  A `Turn` with neither `draft` nor `del` leaves storage untouched.

- [ ] **Step 1: Write the failing tests**

Replace `server/whatsapp-intake.test.js` with:

```js
/* whatsapp-intake.js — handleTurn: claim rules and the conversation, with fake deps. */
const assert = require("assert");
const { handleTurn } = require("./whatsapp-intake");
const D = require("./property-draft");

const PHONE = "972501234567";
const CREATE = "https://agent/create.html";
const T0 = new Date("2026-09-12T10:00:00Z");
const FIELDS = { city: "תל אביב", price: 2900000, rooms: 3.5, address: null, neighborhood: "פלורנטין", deal: "sale",
  size_sqm: 80, sqm_built: null, sqm_balcony: null, sqm_garden: null, floor: 2, parking: 1, elevator: true, shabbat_elevator: null, storage: null };
const fail = (code) => { const e = new Error(code); e.code = code; return e; };

function deps(over = {}) {
  const calls = { created: [], consumed: [], imported: [] };
  const d = {
    business: { phone: PHONE },
    resolve: async ({ url }) => ({ source: "scrape", text: "t " + url, description: "desc",
      photos: [1, 2, 3].map((i) => ({ url: `https://c/${i}.jpg` })) }),
    parseListing: async () => ({ fields: { ...FIELDS }, missing: [] }),
    importPhoto: async (u) => { calls.imported.push(u); return "https://files/" + u.split("/").pop(); },
    quota: { consume: async (phone, kind, n, o) => { calls.consumed.push({ kind, n, source: o.source }); return { ok: true }; } },
    createListing: async (phone, body) => { calls.created.push({ phone, body }); return { listing_id: "L1" }; },
    createUrl: CREATE,
    extractAllowed: () => true,
    ...over,
  };
  return { d, calls };
}
// handleTurn mutates the draft it is given; clone so a test can branch from one draft.
const turn = (input, d) => handleTurn({ phone: PHONE, now: T0, ...input, draft: input.draft ? structuredClone(input.draft) : null }, d);
const texts = (t) => t.replies.map((r) => r.text).join("\n");

(async () => {
  // ── not ours ──
  let { d } = deps({ business: null });
  let t = await turn({ text: "https://x.co/1" }, d);
  assert.deepEqual([t.handled, t.status, t.replies.length], [false, "unknown_agent", 0]);

  ({ d } = deps());
  t = await turn({ text: "היי" }, d);
  assert.deepEqual([t.handled, t.status], [false, "not_ours"]);
  t = await turn({ fileUrl: "https://green/1.jpg" }, d);
  assert.equal(t.handled, false, "a photo with no draft goes to image editing");

  // ── link opener: extract, import photos, ask the first missing field ──
  let calls;
  ({ d, calls } = deps());
  t = await turn({ text: "תראה https://www.yad2.co.il/item/abc" }, d);
  assert.equal(t.handled, true);
  assert.equal(t.status, "asked:description", "every extractor field came from the link; only description is empty");
  assert.equal(t.draft.source, "link");
  assert.equal(t.draft.fields.city, "תל אביב");
  assert.deepEqual(t.draft.photos, ["https://files/1.jpg", "https://files/2.jpg", "https://files/3.jpg"]);
  assert.equal(t.draft.fields.description, "desc");
  assert.match(texts(t), /קראתי את המודעה: 3\.5 חד׳ בפלורנטין/);
  assert.match(texts(t), /תיאור/);

  // description answered → photos are already 3 → confirm
  let draft = t.draft;
  t = await turn({ text: "דירה מהממת", draft }, d);
  assert.equal(t.draft.fields.description, "דירה מהממת");
  assert.equal(t.status, "confirm");
  assert.deepEqual(t.replies[t.replies.length - 1].buttons, ["כן", "ביטול"]);

  // ── keyword opener: empty draft, ask city ──
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d);
  assert.deepEqual([t.handled, t.status, t.draft.source], [true, "asked:city", "keyword"]);
  draft = t.draft;
  t = await turn({ text: "חיפה", draft }, d);
  assert.equal(t.draft.fields.city, "חיפה");
  assert.equal(t.status, "asked:price");
  draft = t.draft;
  t = await turn({ text: "לא יודע", draft }, d);
  assert.equal(t.status, "invalid:price");
  assert.equal(t.draft.fields.price, null);
  t = await turn({ text: "דלג", draft }, d);
  assert.equal(t.status, "required:price", "cannot skip a required field");
  t = await turn({ text: "1.5 מיליון", draft }, d);
  assert.equal(t.draft.fields.price, 1500000);
  draft = t.draft;
  t = await turn({ text: "4", draft }, d); draft = t.draft;           // rooms
  t = await turn({ text: "להשכרה", draft }, d); draft = t.draft;     // deal (button text)
  assert.equal(draft.fields.deal, "rent");
  t = await turn({ text: "דלג", draft }, d); draft = t.draft;         // size_sqm skipped
  assert.deepEqual(draft.skipped, ["size_sqm"]);
  assert.equal(t.status, "asked:floor");

  // ── text opener with extraction failure keeps an empty draft open ──
  ({ d } = deps({ resolve: async () => { throw fail("page_unreadable"); } }));
  t = await turn({ text: "https://dead.link/1" }, d);
  assert.equal(t.handled, true);
  assert.equal(t.status, "source_error:page_unreadable");
  assert.equal(t.draft.fields.city, null);
  assert.match(texts(t), /לא הצלחתי לקרוא/);
  assert.match(texts(t), /באיזו עיר/);

  // ── daily extraction cap ──
  ({ d } = deps({ extractAllowed: () => false }));
  t = await turn({ text: "https://x.co/1" }, d);
  assert.deepEqual([t.handled, t.status, t.draft], [true, "extract_limit", undefined]);

  // ── listing-like text opener goes through the extractor with text ──
  ({ d, calls } = deps({ resolve: async (i) => { assert.equal(i.text.includes("חדרים"), true); return { source: "text", text: i.text, description: i.text, photos: [] }; } }));
  t = await turn({ text: "למכירה בפלורנטין 3 חדרים 70 מ״ר קומה 2 מחיר 2,200,000 ₪ משופצת" }, d);
  assert.equal(t.draft.source, "text");
  assert.equal(t.draft.photos.length, 0);

  console.log("whatsapp-intake.test.js (openers + questions) ok");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && node whatsapp-intake.test.js`
Expected: `TypeError: handleTurn is not a function`

- [ ] **Step 3: Implement**

Replace `server/whatsapp-intake.js` with:

```js
/*
 * whatsapp-intake.js — the property chat's turn handler.
 *
 * handleTurn(input, deps) takes one inbound event (text, photo, n8n event or
 * the photo timer) plus the agent's current draft, and returns what to reply,
 * whether the message was ours at all, and the draft to persist (or delete).
 * No I/O here except through deps, so whatsapp-intake.test.js drives whole
 * conversations without Express, Firestore or the network.
 *
 * Spec: docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md
 */
const D = require("./property-draft");
const R = require("./whatsapp-replies");

const MAX_PHOTOS = 12;

const notOurs = (status) => ({ handled: false, status, replies: [] });

// What to say for the step the draft is at.
function promptFor(draft) {
  const step = D.nextStep(draft);
  if (step.kind === "ask") return { status: `asked:${step.field}`, replies: [R.ask(step.field)] };
  if (step.kind === "photos") return { status: "photos", replies: [R.askPhotos()] };
  return { status: "confirm", replies: [R.confirm(D.summary(draft))] };
}

async function importAll(urls, importPhoto) {
  const settled = await Promise.allSettled(urls.slice(0, MAX_PHOTOS).map((u) => importPhoto(u)));
  return settled.filter((s) => s.status === "fulfilled" && s.value).map((s) => s.value);
}

// Link or listing text → fields + photos on a fresh draft. Errors keep the
// draft open and empty so the agent can paste text or send photos instead.
async function openFromSource(phone, kind, text, deps, now) {
  const draft = D.newDraft(phone, kind, now);
  if (!deps.extractAllowed(phone)) {
    return { handled: true, status: "extract_limit", replies: [R.extractLimit(deps.createUrl)] };
  }
  const input = kind === "link" ? { url: D.findUrl(text), userId: phone } : { text, userId: phone };
  let src, parsed;
  try {
    src = await deps.resolve(input);
    parsed = await deps.parseListing(src.text);
  } catch (err) {
    const code = err && err.code ? err.code : "page_unreadable";
    if (!err || !err.code) console.error("[whatsapp-intake] source failed:", err);
    const p = promptFor(draft);
    return { handled: true, status: `source_error:${code}`, draft, replies: [R.sourceError(code, deps.createUrl), ...p.replies] };
  }
  for (const [k, v] of Object.entries(parsed.fields)) if (k in draft.fields && v !== null) draft.fields[k] = v;
  draft.fields.description = String(src.description || src.text || "").trim().slice(0, 2000) || null;
  draft.photos = await importAll((src.photos || []).map((p) => p.url), deps.importPhoto);
  const p = promptFor(draft);
  return { handled: true, status: p.status, draft, replies: [R.opened(kind, draft.fields), ...p.replies] };
}

function openFromKeyword(phone, now) {
  const draft = D.newDraft(phone, "keyword", now);
  const p = promptFor(draft);
  return { handled: true, status: p.status, draft, replies: [R.opened("keyword"), ...p.replies] };
}

async function openDraft(phone, kind, text, deps, now) {
  return kind === "keyword" ? openFromKeyword(phone, now) : openFromSource(phone, kind, text, deps, now);
}

// One answer to the field currently being asked.
function answerField(draft, field, text, cmd) {
  if (cmd === "skip") {
    if (D.isRequired(field)) return { status: `required:${field}`, replies: [R.required(field)] };
    draft.skipped.push(field);
    const p = promptFor(draft);
    return { status: p.status, replies: p.replies, draft };
  }
  const value = D.parseAnswer(field, text);
  if (value === null) return { status: `invalid:${field}`, replies: [R.invalid(field)] };
  draft.fields[field] = value;
  const p = promptFor(draft);
  return { status: p.status, replies: p.replies, draft };
}

async function activeTurn(input, deps, draft, now) {
  const cmd = D.command(input.text);
  if (cmd === "cancel") return { handled: true, status: "cancelled", del: true, replies: [R.cancelled()] };
  const step = D.nextStep(draft);
  if (step.kind === "ask") {
    const r = answerField(draft, step.field, input.text, cmd);
    return { handled: true, ...r, draft: r.draft ? D.touch(r.draft, now) : undefined };
  }
  // photos + confirm arrive in Task 7
  return { handled: true, status: step.kind, replies: promptFor(draft).replies };
}

async function handleTurn(input, deps) {
  const now = input.now || new Date();
  const { phone } = input;
  if (!deps.business) return notOurs("unknown_agent");
  let draft = input.draft || null;
  let dropped = false;
  if (draft && D.isExpiredPrompt(draft, now)) { draft = null; dropped = true; }

  if (!draft) {
    const kind = D.openerKind(input.text);
    if (!kind) return { ...notOurs("not_ours"), ...(dropped ? { del: true } : {}) };
    return openDraft(phone, kind, input.text, deps, now);
  }
  if (draft.status === "active" && !D.isPaused(draft, now)) return activeTurn(input, deps, draft, now);
  // offered / resume_prompt / paused / building arrive in Task 8
  return notOurs("not_ours");
}

module.exports = { handleTurn, _test: { promptFor, answerField } };
```

- [ ] **Step 4: Run the test**

Run: `cd server && node whatsapp-intake.test.js`
Expected: `whatsapp-intake.test.js (openers + questions) ok`

- [ ] **Step 5: Commit**

`npm test` must be green (the old route still loads because `routes/whatsapp.js` imports `intake`, which no longer exists — Task 9 rewrites the route; until then, temporarily keep `module.exports.intake = async () => ({ status: "not_ours", reply: null })` at the bottom of `whatsapp-intake.js` so `index.js` boots). Then:

```bash
git add server/whatsapp-intake.js server/whatsapp-intake.test.js
git commit -m "feat(whatsapp): handleTurn with openers and the question loop"
```

---

### Task 7: handleTurn — photos, confirm, build

**Files:**
- Modify: `server/whatsapp-intake.js`
- Modify: `server/whatsapp-intake.test.js` (append)

**Interfaces:**
- Consumes: `deps.quota.consume(phone, "walkthroughs", 1, { source:"whatsapp", business, request })` returning `{ ok }` or `{ ok:false, message }`; `deps.createListing(phone, body)`.
- Produces: `Turn.armPhotoTimer === true` after a stored photo (the route arms a 20 s timer and then calls `handleTurn` with `event:"photo_timer"`); `Turn.listing_id` after a build.

- [ ] **Step 1: Append the failing tests**

Append inside the async block of `server/whatsapp-intake.test.js` (before its final `console.log`, which becomes `"whatsapp-intake.test.js ok"`):

```js
  // ── photos: silent accumulation, timer prompt, continue, confirm, build ──
  ({ d, calls } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  for (const [f, v] of [["city", "חיפה"], ["price", "1,500,000"], ["rooms", "4"]]) { t = await turn({ text: v, draft }, d); draft = t.draft; }
  for (let i = 0; i < 6; i++) { t = await turn({ text: "דלג", draft }, d); draft = t.draft; }
  assert.equal(t.status, "photos");
  t = await turn({ fileUrl: "https://green/a.jpg", draft }, d);
  assert.deepEqual([t.handled, t.replies.length, t.armPhotoTimer], [true, 0, true], "a photo is stored silently and arms the timer");
  draft = t.draft;
  assert.deepEqual(draft.photos, ["https://files/a.jpg"]);
  t = await turn({ event: "photo_timer", draft }, d);
  assert.equal(t.status, "photos_progress:1");
  assert.match(texts(t), /יש לי 1 תמונות/);
  assert.equal(t.replies[0].buttons, undefined);
  for (const n of ["b", "c", "d"]) { t = await turn({ fileUrl: `https://green/${n}.jpg`, draft }, d); draft = t.draft; }
  t = await turn({ text: "עוד אחת בדרך", draft }, d);
  assert.equal(t.status, "photos_progress:4", "any text during photos ends the batch and reports");
  assert.deepEqual(t.replies[0].buttons, ["ממשיכים"]);
  t = await turn({ text: "ממשיכים", draft }, d);
  assert.equal(t.status, "confirm");
  assert.equal(t.draft, undefined, "confirm prompt does not change the draft");

  // failed import is skipped, not counted
  ({ d } = deps({ importPhoto: async () => { throw new Error("404"); } }));
  t = await turn({ fileUrl: "https://green/bad.jpg", draft: { ...draft, photos: [] } }, d);
  assert.equal(t.draft.photos.length, 0);

  // photo while a question is open: stored, timer prompt says saved + repeats the question
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  t = await turn({ fileUrl: "https://green/z.jpg", draft }, d); draft = t.draft;
  assert.equal(draft.photos.length, 1);
  t = await turn({ event: "photo_timer", draft }, d);
  assert.match(texts(t), /שמרתי 1 תמונות/);
  assert.match(texts(t), /באיזו עיר/);

  // confirm: anything but כן / ביטול repeats the summary
  ({ d, calls } = deps());
  const ready = D.newDraft(PHONE, "keyword", T0);
  Object.assign(ready.fields, { city: "חיפה", price: 1500000, rooms: 4 });
  ready.skipped = ["deal", "size_sqm", "floor", "parking", "neighborhood", "description"];
  ready.photos = ["p1", "p2", "p3"];
  t = await turn({ text: "רגע", draft: ready }, d);
  assert.equal(t.status, "confirm");
  t = await turn({ text: "ביטול", draft: ready }, d);
  assert.deepEqual([t.status, t.del], ["cancelled", true]);
  t = await turn({ text: "כן", draft: ready }, d);
  assert.deepEqual([t.status, t.listing_id, t.draft.status, t.draft.listing_id], ["building", "L1", "building", "L1"]);
  assert.deepEqual(calls.consumed, [{ kind: "walkthroughs", n: 1, source: "whatsapp" }]);
  assert.equal(calls.created[0].body.city, "חיפה");
  assert.deepEqual(calls.created[0].body.photos_urls, ["p1", "p2", "p3"]);
  assert.match(texts(t), /אני בונה/);

  // quota blocked: ledger message, draft stays at confirm, כן can be retried
  ({ d, calls } = deps({ quota: { consume: async () => ({ ok: false, message: "נגמרה החבילה" }) } }));
  t = await turn({ text: "כן", draft: ready }, d);
  assert.deepEqual([t.status, texts(t), calls.created.length, t.del], ["quota_blocked", "נגמרה החבילה", 0, undefined]);
  ({ d } = deps({ quota: null }));
  t = await turn({ text: "כן", draft: ready }, d);
  assert.equal(t.status, "building", "no quota module (local dev) still builds");
  ({ d } = deps({ createListing: async () => ({ error: "x", code: 400 }) }));
  t = await turn({ text: "כן", draft: ready }, d);
  assert.equal(t.status, "create_failed");
  assert.equal(t.draft, undefined, "draft unchanged so כן can be retried");
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && node whatsapp-intake.test.js`
Expected: the first new assertion fails (`t.armPhotoTimer` is `undefined`).

- [ ] **Step 3: Implement**

In `server/whatsapp-intake.js`, add after `answerField`:

```js
// A photo is stored silently; the route arms a timer and calls back with
// event:"photo_timer" so the agent gets one progress message per batch.
async function storePhoto(draft, fileUrl, deps, now) {
  let hosted = null;
  try { hosted = await deps.importPhoto(fileUrl); } catch (err) { console.warn("[whatsapp-intake] photo import failed:", err.message); }
  if (hosted && draft.photos.length < MAX_PHOTOS) draft.photos.push(hosted);
  return { handled: true, status: "photo_stored", draft: D.touch(draft, now), replies: [], armPhotoTimer: true };
}

function photoTimer(draft) {
  const n = draft.photos.length;
  if (D.nextStep(draft).kind === "photos") return { handled: true, status: `photos_progress:${n}`, replies: [R.photosProgress(n)] };
  const p = promptFor(draft);
  return { handled: true, status: p.status, replies: [R.photosSaved(n), ...p.replies] };
}

async function build(draft, deps, now) {
  const { phone } = draft;
  const body = D.toListingBody(draft);
  if (deps.quota) {
    const q = await deps.quota.consume(phone, "walkthroughs", 1, {
      source: "whatsapp", business: deps.business,
      request: { city: body.city, price: body.price, rooms: body.rooms, photos: body.photos_urls.length, source: draft.source },
    });
    if (!q.ok) return { handled: true, status: "quota_blocked", replies: [{ text: q.message || R.createFailed(deps.createUrl).text }] };
  }
  const result = await deps.createListing(phone, body);
  if (result.error) {
    console.error("[whatsapp-intake] create failed:", result.error);
    return { handled: true, status: "create_failed", replies: [R.createFailed(deps.createUrl)] };
  }
  draft.status = "building";
  draft.listing_id = result.listing_id;
  return { handled: true, status: "building", listing_id: result.listing_id, draft: D.touch(draft, now), replies: [R.building(D.summary(draft))] };
}
```

Replace `activeTurn` with:

```js
async function activeTurn(input, deps, draft, now) {
  if (input.event === "photo_timer") return photoTimer(draft);
  if (input.fileUrl) return storePhoto(draft, input.fileUrl, deps, now);
  const cmd = D.command(input.text);
  if (cmd === "cancel") return { handled: true, status: "cancelled", del: true, replies: [R.cancelled()] };
  const step = D.nextStep(draft);
  if (step.kind === "ask") {
    const r = answerField(draft, step.field, input.text, cmd);
    return { handled: true, ...r, draft: r.draft ? D.touch(r.draft, now) : undefined };
  }
  if (step.kind === "photos") {
    // Text mid-upload ends the batch; "continue" with < 3 photos is the same message.
    const n = draft.photos.length;
    return { handled: true, status: `photos_progress:${n}`, replies: [R.photosProgress(n)] };
  }
  // confirm
  if (cmd === "yes") return build(draft, deps, now);
  if (cmd === "no") return { handled: true, status: "cancelled", del: true, replies: [R.cancelled()] };
  return { handled: true, status: "confirm", replies: [R.confirm(D.summary(draft))] };
}
```

Note: when the step is `photos` and the agent taps ממשיכים with 3+ photos, `nextStep` already returns `confirm`, so the confirm branch handles it. With fewer than 3 the photos branch re-reports the count. That is the intended behaviour.

- [ ] **Step 4: Run the test**

Run: `cd server && node whatsapp-intake.test.js`
Expected: `whatsapp-intake.test.js ok`

- [ ] **Step 5: Commit**

```bash
git add server/whatsapp-intake.js server/whatsapp-intake.test.js
git commit -m "feat(whatsapp): photo batches, confirmation and build in handleTurn"
```

---

### Task 8: handleTurn — photo offer, pause / resume, building state

**Files:**
- Modify: `server/whatsapp-intake.js`
- Modify: `server/whatsapp-intake.test.js` (append)

**Interfaces:**
- Consumes: `input.event === "photos_edited"` with `input.photos: string[]` (URLs from n8n's image gen, not yet Forly-hosted).
- Produces: drafts in status `offered` / `resume_prompt` with `pending_opener` per the spec.

- [ ] **Step 1: Append the failing tests**

Append inside the async block (before the final log):

```js
  // ── photos_edited offer ──
  ({ d, calls } = deps());
  t = await turn({ event: "photos_edited", photos: ["https://fal/1.jpg", "https://fal/2.jpg", "https://fal/3.jpg", "https://fal/4.jpg"] }, d);
  assert.deepEqual([t.handled, t.status, t.draft.status, t.draft.photos.length], [true, "offered", "offered", 4]);
  assert.deepEqual(t.replies[0].buttons, ["כן", "לא"]);
  assert.equal(calls.imported.length, 4, "edited photos are re-hosted on Forly");
  const offered = t.draft;
  t = await turn({ text: "בוקר טוב", draft: offered }, d);
  assert.equal(t.handled, false, "an offered draft does not hijack unrelated chat");
  t = await turn({ text: "לא", draft: offered }, d);
  assert.deepEqual([t.status, t.del], ["declined", true]);
  t = await turn({ text: "כן", draft: offered }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.source], ["asked:city", "active", "photos"]);
  // offer older than 2h is dropped; the message is then judged on its own
  t = await turn({ text: "בוקר טוב", draft: offered, now: new Date(T0.getTime() + D.PAUSE_MS + 1) }, d);
  assert.deepEqual([t.handled, t.del], [false, true]);

  // photos_edited while a draft is active: photos are added, current question repeated
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  t = await turn({ event: "photos_edited", photos: ["https://fal/1.jpg"], draft }, d);
  assert.equal(t.draft.photos.length, 1);
  assert.match(texts(t), /שמרתי 1 תמונות/);
  assert.match(texts(t), /באיזו עיר/);

  // ── pause: silent for 2h → ordinary messages are not ours, openers ask resume/new ──
  ({ d } = deps());
  t = await turn({ text: "נכס חדש" }, d); draft = t.draft;
  t = await turn({ text: "חיפה", draft }, d); draft = t.draft;
  const later = new Date(T0.getTime() + D.PAUSE_MS + 1000);
  t = await turn({ text: "1,500,000", draft, now: later }, d);
  assert.equal(t.handled, false, "paused draft does not claim plain text");
  t = await turn({ fileUrl: "https://green/x.jpg", draft, now: later }, d);
  assert.equal(t.handled, false, "paused draft does not claim photos");
  t = await turn({ text: "https://www.yad2.co.il/item/new", draft, now: later }, d);
  assert.deepEqual([t.handled, t.status, t.draft.status], [true, "resume_prompt", "resume_prompt"]);
  assert.deepEqual(t.replies[0].buttons, ["המשך", "חדש"]);
  assert.equal(t.draft.pending_opener.text, "https://www.yad2.co.il/item/new");
  const rp = t.draft;
  t = await turn({ text: "המשך", draft: rp, now: later }, d);
  assert.deepEqual([t.status, t.draft.status, t.draft.fields.city, t.draft.pending_opener], ["asked:price", "active", "חיפה", null]);
  t = await turn({ text: "חדש", draft: rp, now: later }, d);
  assert.deepEqual([t.draft.source, t.draft.fields.city], ["link", "תל אביב"], "new: the pending link is extracted into a fresh draft");
  t = await turn({ text: "מה?", draft: rp, now: later }, d);
  assert.equal(t.status, "resume_prompt", "anything else repeats the question");
  // resume prompt from a photos_edited event
  t = await turn({ event: "photos_edited", photos: ["https://fal/1.jpg"], draft, now: later }, d);
  assert.equal(t.status, "resume_prompt");
  t = await turn({ text: "חדש", draft: t.draft, now: later }, d);
  assert.deepEqual([t.draft.status, t.draft.source, t.draft.photos.length], ["offered", "photos", 1]);

  // ── building: only an opener replaces it ──
  ({ d } = deps());
  const bld = { ...ready, status: "building", listing_id: "L9" };
  t = await turn({ text: "תודה", draft: bld }, d);
  assert.equal(t.handled, false);
  t = await turn({ text: "נכס חדש", draft: bld }, d);
  assert.deepEqual([t.handled, t.draft.status, t.draft.listing_id], [true, "active", null]);
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && node whatsapp-intake.test.js`
Expected: fails at the first `photos_edited` assertion (`t.handled` is `false`).

- [ ] **Step 3: Implement**

In `server/whatsapp-intake.js` add after `build`:

```js
// n8n finished a bulk photo edit → offer a page from those photos.
async function photosEdited(input, deps, draft, now) {
  const { phone } = input;
  const hosted = await importAll(input.photos || [], deps.importPhoto);
  if (draft && draft.status === "active" && !D.isPaused(draft, now)) {
    draft.photos = draft.photos.concat(hosted).slice(0, MAX_PHOTOS);
    const p = promptFor(draft);
    return { handled: true, status: p.status, draft: D.touch(draft, now), replies: [R.photosSaved(draft.photos.length), ...p.replies] };
  }
  if (draft && draft.status === "active") return resumePrompt(draft, { photos: hosted }, now);
  const fresh = D.newDraft(phone, "photos", now);
  fresh.status = "offered";
  fresh.photos = hosted;
  return { handled: true, status: "offered", draft: fresh, replies: [R.offer(hosted.length)] };
}

function resumePrompt(draft, opener, now) {
  draft.status = "resume_prompt";
  draft.pending_opener = opener;
  return { handled: true, status: "resume_prompt", draft: D.touch(draft, now), replies: [R.resumePrompt(D.summary(draft))] };
}

async function offeredTurn(input, deps, draft, now) {
  const cmd = D.command(input.text);
  if (cmd === "no") return { handled: true, status: "declined", del: true, replies: [R.declined()] };
  if (cmd !== "yes") return notOurs("not_ours");
  draft.status = "active";
  const p = promptFor(draft);
  return { handled: true, status: p.status, draft: D.touch(draft, now), replies: p.replies };
}

async function resumeTurn(input, deps, draft, now) {
  const cmd = D.command(input.text);
  if (cmd === "resume") {
    draft.status = "active";
    draft.pending_opener = null;
    const p = promptFor(draft);
    return { handled: true, status: p.status, draft: D.touch(draft, now), replies: p.replies };
  }
  if (cmd === "new") {
    const o = draft.pending_opener || {};
    if (o.photos) {
      const fresh = D.newDraft(draft.phone, "photos", now);
      fresh.status = "offered";
      fresh.photos = o.photos;
      return { handled: true, status: "offered", draft: fresh, replies: [R.offer(fresh.photos.length)] };
    }
    return openDraft(draft.phone, D.openerKind(o.text), o.text, deps, now);
  }
  return { handled: true, status: "resume_prompt", replies: [R.resumePrompt(D.summary(draft))] };
}
```

Replace `handleTurn` with:

```js
async function handleTurn(input, deps) {
  const now = input.now || new Date();
  const { phone } = input;
  if (!deps.business) return notOurs("unknown_agent");
  let draft = input.draft || null;
  let dropped = false;
  if (draft && D.isExpiredPrompt(draft, now)) { draft = null; dropped = true; }
  const withDrop = (t) => (dropped && !t.draft ? { ...t, del: true } : t);

  if (input.event === "photos_edited") return withDrop(await photosEdited(input, deps, draft, now));

  if (!draft) {
    const kind = D.openerKind(input.text);
    if (!kind) return withDrop(notOurs("not_ours"));
    return openDraft(phone, kind, input.text, deps, now);
  }
  if (draft.status === "offered") return offeredTurn(input, deps, draft, now);
  if (draft.status === "resume_prompt") return resumeTurn(input, deps, draft, now);
  if (draft.status === "building" || D.isPaused(draft, now)) {
    if (input.event || input.fileUrl) return notOurs("not_ours");
    const kind = D.openerKind(input.text);
    if (!kind) return notOurs("not_ours");
    if (draft.status === "building") return openDraft(phone, kind, input.text, deps, now);
    return resumePrompt(draft, { text: input.text }, now);
  }
  return activeTurn(input, deps, draft, now);
}
```

Remove the temporary `module.exports.intake` stub if it was added in Task 6.

- [ ] **Step 4: Run the test**

Run: `cd server && node whatsapp-intake.test.js`
Expected: `whatsapp-intake.test.js ok`

Then `wc -l server/whatsapp-intake.js` — must be under 500 (expected ≈ 220).

- [ ] **Step 5: Commit**

```bash
git add server/whatsapp-intake.js server/whatsapp-intake.test.js
git commit -m "feat(whatsapp): photo offer, pause/resume and building state"
```

---

### Task 9: The route — persist, send, photo timer; page-builder hook; wiring

**Files:**
- Rewrite: `server/routes/whatsapp.js`
- Modify: `server/routes/pages.js` (after `await db.setListingPageId(body.listing_id, pageId);`, around line 287)
- Modify: `server/index.js` (the `createWhatsappRouter` block)
- Test: in-process script in the scratchpad (not committed) + `npm test`

**Interfaces:**
- Consumes: `handleTurn` (Tasks 6-8), `db.getDraft/saveDraft/deleteDraft` (Task 2), `importImage` + `DailyLimit` from `routes/extract.js`, `storeBuffer`, `createListing` from `listing-create.js`, `utils.sendWhatsApp` / `utils.sendWhatsAppButtons`.
- Produces: `POST /api/whatsapp/intake` per the spec; router ctx `{ n8nSecret, normalizeAuthPhone, signSession, authSecret, quota, sendWhatsApp|null, sendButtons|null, uploadDir, uploadPublicBase, remoteUploadBase, baseUrl, pipelineDeps }`.

- [ ] **Step 1: Rewrite the route**

`server/routes/whatsapp.js`:

```js
/*
 * routes/whatsapp.js — the WhatsApp chat as a property-page intake.
 *
 *   POST /api/whatsapp/intake                                n8n (x-forly-secret)
 *     { phone, message?, message_type?, file_url? }          one inbound message
 *     { phone, event: "photos_edited", photos: [url, ...] }  after a bulk photo edit
 *     → 200 { handled, status, reply, replied, listing_id }
 *     → 403 / 503 bad or unconfigured N8N_WEBHOOK_SECRET, 400 invalid_input
 *
 * n8n (Business Handler2) posts EVERY registered-agent message here first and
 * continues to its AI agent only when handled is false. The server keeps the
 * per-agent draft (db.getDraft), runs whatsapp-intake.handleTurn, persists,
 * and sends the replies itself over Green API. `replied:false` means Green API
 * is not configured here — n8n should then send `reply`.
 *
 * Photo batches: a stored photo arms a 20 s timer per phone (in-process; a
 * lost instance just means no progress message, and the agent's next text
 * triggers the same report). The "page is live" message comes later from the
 * n8n Property Page Builder, as for every page.
 */
const express = require("express");
const { constantTimeEqual } = require("../security");
const db = require("../db");
const { handleTurn } = require("../whatsapp-intake");
const { resolve } = require("../listing-sources");
const { parseListing } = require("../listing-extract");
const { createListing } = require("../listing-create");
const { importImage, DailyLimit } = require("./extract");
const { storeBuffer } = require("../upload-store");

const EXTRACT_CAP = 20;          // link/text extractions per agent per day
const PHOTO_BATCH_MS = 20000;
const MAX_TEXT = 4000;

module.exports = function createWhatsappRouter(ctx) {
  const { n8nSecret, normalizeAuthPhone, signSession, authSecret, quota, sendWhatsApp, sendButtons,
    uploadDir, uploadPublicBase, remoteUploadBase, baseUrl, pipelineDeps } = ctx;
  const router = express.Router();
  const limit = new DailyLimit(EXTRACT_CAP);
  const timers = new Map();

  function requireN8n(req, res, next) {
    if (!n8nSecret) return res.status(503).json({ error: "n8n_secret_not_configured" });
    if (!constantTimeEqual(req.get("x-forly-secret"), n8nSecret)) return res.status(403).json({ error: "forbidden" });
    next();
  }

  // Photos are re-hosted on Forly's store. The remote-store relay re-authorizes
  // with the caller's session; there is no browser here, so mint the agent's
  // own session for the hop (same trust as the agent uploading from the form).
  function importPhotoFor(phone) {
    const req = { headers: { cookie: `forly_session=${signSession(authSecret, phone)}` } };
    return async (url) => {
      const img = await importImage(url);
      await storeBuffer(img, { uploadDir, remoteUploadBase, req });
      return `${uploadPublicBase}/files/${img.fname}`;
    };
  }

  function depsFor(phone, business) {
    return {
      business, resolve, parseListing, quota,
      importPhoto: importPhotoFor(phone),
      createListing: (p, body) => createListing(p, body, null, { ...pipelineDeps, source: "whatsapp" }),
      createUrl: `${baseUrl}/create.html`,
      extractAllowed: (p) => limit.take(p),
    };
  }

  async function send(phone, reply) {
    if (reply.buttons && sendButtons) {
      try {
        await sendButtons(phone, { body: reply.text, buttons: reply.buttons.map((b, i) => ({ buttonId: String(i + 1), buttonText: b })) });
        return;
      } catch (err) { console.warn("[whatsapp] buttons failed, sending plain:", err.message); }
    }
    await sendWhatsApp(phone, reply.text);
  }

  async function persistAndSend(phone, turn) {
    if (turn.del) await db.deleteDraft(phone);
    else if (turn.draft) await db.saveDraft(turn.draft);
    let replied = false;
    if (turn.replies.length && sendWhatsApp) {
      try { for (const r of turn.replies) await send(phone, r); replied = true; }
      catch (err) { console.warn("[whatsapp] reply failed:", err.message); }
    }
    if (turn.armPhotoTimer) armTimer(phone);
    return replied;
  }

  function armTimer(phone) {
    clearTimeout(timers.get(phone));
    timers.set(phone, setTimeout(async () => {
      timers.delete(phone);
      try {
        const [business, draft] = await Promise.all([db.getBusiness(phone), db.getDraft(phone)]);
        if (!draft) return;
        const turn = await handleTurn({ phone, event: "photo_timer", draft }, depsFor(phone, business));
        if (turn.handled) await persistAndSend(phone, turn);
      } catch (err) { console.error("[whatsapp] photo timer failed:", err); }
    }, PHOTO_BATCH_MS));
  }

  router.post("/intake", requireN8n, async (req, res) => {
    const body = req.body || {};
    const phone = normalizeAuthPhone(body.phone || "");
    const text = String(body.message || "").slice(0, MAX_TEXT);
    const fileUrl = typeof body.file_url === "string" && body.file_url.trim() ? body.file_url.trim() : null;
    const event = body.event === "photos_edited" ? "photos_edited" : null;
    const photos = Array.isArray(body.photos) ? body.photos.filter((p) => typeof p === "string").slice(0, 12) : [];
    if (!phone || (!text.trim() && !fileUrl && !event)) return res.status(400).json({ error: "invalid_input" });
    try {
      const [business, draft] = await Promise.all([db.getBusiness(phone).catch(() => null), db.getDraft(phone)]);
      const turn = await handleTurn({ phone, text, fileUrl, event, photos, draft }, depsFor(phone, business));
      // A text that ends a photo batch must not be followed by the timer's report too.
      if (turn.handled && !turn.armPhotoTimer) { clearTimeout(timers.get(phone)); timers.delete(phone); }
      const replied = turn.handled ? await persistAndSend(phone, turn) : false;
      console.log(`[whatsapp] ${phone} → ${turn.status}${turn.listing_id ? ` ${turn.listing_id}` : ""}`);
      res.json({
        handled: turn.handled, status: turn.status,
        reply: turn.replies.map((r) => r.text).join("\n\n") || null,
        replied, listing_id: turn.listing_id || null,
      });
    } catch (err) {
      console.error("[whatsapp] intake failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  return router;
};
```

- [ ] **Step 2: Page-builder hook**

In `server/routes/pages.js`, right after `await db.setListingPageId(body.listing_id, pageId);`:

```js
      // A listing that came in over WhatsApp: its chat draft is done.
      if (listing && listing.source === "whatsapp") {
        db.deleteDraft(body.business_phone).catch((e) => console.warn("draft cleanup failed:", e && e.message));
      }
```

- [ ] **Step 3: Wiring in index.js**

Replace the `createWhatsappRouter` block's `sendWhatsApp` line so both senders are passed:

```js
  // null when Green API is unset so the response's `replied` is honest and n8n forwards `reply`.
  sendWhatsApp: GREENAPI_INSTANCE && GREENAPI_TOKEN
    ? (phone, msg) => sendWhatsApp(phone, msg, GREENAPI_INSTANCE, GREENAPI_TOKEN) : null,
  sendButtons: GREENAPI_INSTANCE && GREENAPI_TOKEN
    ? (phone, opts) => sendWhatsAppButtons(phone, opts, GREENAPI_INSTANCE, GREENAPI_TOKEN) : null,
```

and change the utils import near line 90 to `const { sendWhatsApp, sendWhatsAppButtons } = require("./utils");`.

- [ ] **Step 4: Boot and in-process check**

Run: `cd server && npm test && (node -e 'require("./index.js")' & sleep 3; kill %1)` — server boots without errors.

Write `/tmp/claude-0/.../scratchpad/route-e2e.js` (not committed) that mounts the router with a fake secret, stubs `listing-sources.resolve`, `listing-extract.parseListing`, `routes/extract.importImage`, `db.getBusiness`, records sent messages, and posts:

1. no secret → 403
2. `{ phone }` only → 400
3. unknown phone with a link → `{ handled:false, status:"unknown_agent" }`
4. known phone, "היי" → `handled:false`
5. known phone, "נכס חדש" → `handled:true`, one reply sent, `db.getDraft(phone).status === "active"`
6. same phone, "חיפה" → `handled:true`, draft city set
7. same phone, `file_url` → `handled:true`, 0 replies, then after 21 s one progress reply (use `PHOTO_BATCH_MS` by temporarily setting it via an env override is NOT supported; instead wait 21 s in the script)

Expected: all seven print as described. Run it, then delete it.

- [ ] **Step 5: Commit**

```bash
git add server/routes/whatsapp.js server/routes/pages.js server/index.js
git commit -m "feat(whatsapp): stateful intake route with replies, photo timer and draft cleanup"
```

---

### Task 10: n8n — forward every agent message and the edited-photo batch

Production workflow change; do it with the owner present, on the dev copy first if one exists.

**Files:** none in the repo. Workflow **Business Handler2** (`V44w39VTt691WGxK`).

- [ ] **Step 1: Add the intake call at the top**

Between `Extract Chat History1` and `Check Unsupported Media`, insert an **HTTP Request** node named `Forly Property Intake`:

- Method `POST`, URL `https://forly.srv1173890.hstgr.cloud/api/whatsapp/intake` (the same host `Create Property Page` in the Page Builder posts to)
- Header `x-forly-secret` = the value of `N8N_WEBHOOK_SECRET` on the server (store it as an n8n credential of type Header Auth; do not paste it into the node)
- Body (JSON):
  ```
  {
    "phone": "={{ $json.phone }}",
    "message": "={{ $json.customerMessage || $json.webhookData.fullData.messageData.buttonsResponseMessage?.selectedButtonText || '' }}",
    "message_type": "={{ $json.webhookData.messageType }}",
    "file_url": "={{ $json.webhookData.fullData.messageData.fileMessageData?.downloadUrl || null }}"
  }
  ```
  (use the paths confirmed in Task 1)
- Options: timeout `90000`, "Continue on fail" ON so a Forly outage never blocks the rest of the bot.

- [ ] **Step 2: Branch on handled**

Add an **IF** node `Handled by Forly?` with condition `{{ $json.handled }}` is true. True branch → nothing (end). False branch → `Check Unsupported Media` (the node that used to follow `Extract Chat History1`). Because "Continue on fail" returns an error item without `handled`, an outage falls to the false branch and the bot behaves as before.

- [ ] **Step 3: Offer after a bulk edit**

Find the node that ends the multi-image batch path (after `Call Image Gen` / `Extract Image Result` for the `burst` output of `Check Unsupported Media`). After the last edited image is sent, add an **HTTP Request** `Forly Photo Offer`, same URL and header, body:

```
{ "phone": "={{ $('Set Input Fields1').first().json.phone }}",
  "event": "photos_edited",
  "photos": {{ JSON.stringify($input.all().map(i => i.json.result_url)) }} }
```

Replace `result_url` with the field the image-gen result actually carries (read it off `Extract Image Result`'s output in a recent execution).

- [ ] **Step 4: Verify live**

From a registered agent's phone:

1. "היי" → the AI agent answers as before (n8n execution shows `handled:false`).
2. A Yad2 link → within ~30 s: "קראתי את המודעה…" and the first question. Answer through to the summary, tap כן, get "אני בונה", and a few minutes later the Page Builder's page link. Confirm the listing shows in the dashboard with `source: whatsapp`.
3. Three photos → they are edited as before, then the offer appears; tap כן and answer the questions.
4. Wait 2 h (or set `updated_at` back in Firestore) → "היי" is answered by the AI agent again; a new link asks המשך / חדש.

- [ ] **Step 5: Record**

Comment on issue #43 with what was applied and the execution ids of the four checks. Close the issue when all four pass.

---

### Task 11: Close out the repo side

**Files:**
- Modify: `docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md` (status line → implemented)
- Modify: `server/routes/whatsapp.js` header only if the n8n node names changed in Task 10

- [ ] **Step 1: Full suite and line counts**

Run: `cd server && npm test && wc -l whatsapp-intake.js property-draft.js whatsapp-replies.js routes/whatsapp.js`
Expected: every test prints its `ok` line; every file under 500 lines.

- [ ] **Step 2: Spec status**

Change the spec's `**Status:**` line to `implemented on claude/whatsapp-link-property-page-7wm9xh`.

- [ ] **Step 3: Commit and push**

```bash
git add docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md server/routes/whatsapp.js
git commit -m "docs(spec): WhatsApp property chat implemented"
git push -u origin claude/whatsapp-link-property-page-7wm9xh
```

---

## Self-review

**Spec coverage.** Entry points: link/text/keyword (Task 6), photo offer (Task 8). Ask all 8 + description with skip (Tasks 4, 6). Photo batching with 20 s timer and text ending a batch (Tasks 7, 9). Confirmation before quota (Task 7). 2 h pause with data kept, המשך / חדש, ביטול (Task 8). Ready message stays with the Page Builder (no task; Task 9 only deletes the draft). n8n contract (Tasks 9, 10). Errors: source errors keep the draft open (Task 6), failed photo import skipped (Task 7), Green API down → `reply` in the response (Task 9), unknown sender (Task 6). Extraction cap (Tasks 6, 9). Tests as listed in the spec (Tasks 2-8, in-process route check in Task 9).

**Placeholders.** None: every code step carries the code; Task 1 and Task 10 are manual procedures with exact node names and expressions, and the one field name that cannot be known from the repo (`result_url`) says where to read it.

**Type consistency.** `handleTurn` input/output shape is the same in Tasks 6-9. `deps.extractAllowed(phone)` is defined in Task 6 and provided in Task 9. `R.*` names used in Tasks 6-8 all exist in Task 5. `D.*` names used in Tasks 6-8 all exist in Tasks 3-4 (`findUrl, command, openerKind, parseAnswer, isRequired, newDraft, touch, nextStep, isPaused, isExpiredPrompt, summary, toListingBody, PAUSE_MS`). `db.getDraft/saveDraft/deleteDraft` match Task 2. `createListing(phone, body, agentOverride, deps)` matches the existing `server/listing-create.js`.
