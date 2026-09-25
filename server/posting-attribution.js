/*
 * posting-attribution.js — R4: campaign attribution is server-side.
 *
 * A campaign post's link carries only `?c=<click_id>`; the click id was
 * issued per attempt and its doc (click_ids/{click_id}: campaign_id,
 * attempt_key, page_id, group_id, issued_at, expires_at) was written in the
 * reservation's own transaction (posting-attempts.js).
 *
 *   GET /p/:id?c=  consumeClick(): a known, unexpired click issued for THIS
 *                  page records one portal_events {type:"group_visit"} (at
 *                  most one per visitor per click per 30 min, keyed by an
 *                  HMAC of click id + IP — the raw IP is never stored), maps a
 *                  random `fly_ref` to the click (attribution_refs/{ref}, 7 d)
 *                  and sets the cookie. The route then 302s to the page
 *                  without `c`. Anything else: nothing recorded, no cookie.
 *   lead routes    attributionFor(): fly_ref → attribution_refs → click_ids →
 *                  { campaign_id, attempt_key, group_id }. Request bodies and
 *                  query strings are never read for it.
 *
 * Also the two counts posting-metrics.js reads (db.js is over its cap).
 * Logs carry an error code only.
 */
const crypto = require("crypto");
const { firestore, runTx, hmacHex, toDate } = require("./posting-tx");
const attempts = require("./posting-attempts");

const REFS = "attribution_refs", VISITS = "click_visits";
const maps = { [REFS]: new Map(), [VISITS]: new Map() };
const REF_TTL_S = 7 * 86400;
const VISIT_WINDOW_MS = 30 * 60000;
const HEX32 = /^[0-9a-f]{32}$/;
const COOKIE = "fly_ref";

const clockOf = (deps) => (typeof deps.clock === "function" ? deps.clock : () => new Date());
const codeOf = (e) => (e && (e.code || e.name)) || "error";

function readCookie(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || "";
  for (const part of String(raw).split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const cookieHeader = (ref) => `${COOKIE}=${ref}; HttpOnly; Secure; SameSite=Lax; Max-Age=${REF_TTL_S}; Path=/`;
const clientIp = (req) => String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || "");

async function readDoc(col, id) {
  const fdb = firestore();
  if (fdb) { const d = await fdb.collection(col).doc(id).get(); return d.exists ? d.data() : null; }
  return maps[col].has(id) ? structuredClone(maps[col].get(id)) : null;
}

// A click that resolves: known, unexpired, and issued for this page.
async function validClick(c, pageId, now) {
  if (typeof c !== "string" || !HEX32.test(c)) return null;
  const k = await attempts.getClick(c);
  if (!k || k.page_id !== String(pageId) || !(Date.parse(k.expires_at) > now.getTime())) return null;
  return k;
}

// → true when `c` was a valid click for this page: the visit is recorded
// (rate-limited), fly_ref is set, and the caller must 302 without `c`.
async function consumeClick(req, res, pageId, deps = {}) {
  const c = req && req.query ? req.query.c : undefined;
  if (c === undefined) return false;
  try {
    const now = toDate(clockOf(deps)());
    const click = await validClick(c, pageId, now);
    if (!click) return false;
    const visitKey = hmacHex(`click_visit|${c}|${clientIp(req)}`, 32);
    const held = readCookie(req, COOKIE);
    const heldRef = held && HEX32.test(held) ? held : null;
    const fresh = crypto.randomBytes(16).toString("hex");
    const at = now.toISOString();
    const out = await runTx(maps, async (tx) => {
      const v = await tx.get(VISITS, visitKey);
      const cur = heldRef ? await tx.get(REFS, heldRef) : null;
      const reuse = !!cur && cur.click_id === c && Date.parse(cur.expires_at) > now.getTime();
      const record = !v || !(now.getTime() - Date.parse(v.at) < VISIT_WINDOW_MS);
      if (record) tx.set(VISITS, visitKey, { at, expire_at: new Date(now.getTime() + VISIT_WINDOW_MS) });
      if (!reuse) {
        tx.set(REFS, fresh, {
          click_id: c, created_at: at, expires_at: new Date(now.getTime() + REF_TTL_S * 1000).toISOString(),
          expire_at: new Date(now.getTime() + REF_TTL_S * 1000), // a Date: the TTL policy's field
        });
      }
      return { record, ref: reuse ? heldRef : fresh };
    });
    if (out.record) {
      await (deps.db || require("./db")).logPortalEvent({ type: "group_visit", attempt_key: click.attempt_key, campaign_id: click.campaign_id, group_id: click.group_id });
    }
    res.append("Set-Cookie", cookieHeader(out.ref));
    res.set("Cache-Control", "no-store");
    return true;
  } catch (e) {
    console.error(`attribution click: ${codeOf(e)}`);
    return false;
  }
}

// `path` with the request's query minus `c` — the canonical target of the 302.
function withoutClick(path, query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (k !== "c" && typeof v === "string") qs.append(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

// fly_ref → { campaign_id, attempt_key, group_id } for a lead on `pageId`,
// or null. Only the cookie is read; a click for another page attributes nothing.
async function attributionFor(req, pageId, deps = {}) {
  try {
    const ref = readCookie(req, COOKIE);
    if (!ref || !HEX32.test(ref) || !pageId) return null;
    const now = toDate(clockOf(deps)());
    const r = await readDoc(REFS, ref);
    if (!r || !(Date.parse(r.expires_at) > now.getTime())) return null;
    const k = await attempts.getClick(r.click_id);
    if (!k || k.page_id !== String(pageId) || typeof k.attempt_key !== "string") return null;
    return { campaign_id: k.campaign_id || null, attempt_key: k.attempt_key, group_id: k.group_id || null };
  } catch (e) {
    console.error(`attribution lead: ${codeOf(e)}`);
    return null;
  }
}

// ── the counts posting-metrics.js reads: { [attempt_key]: n } ──
function tally(rows, keyOf) {
  const out = {};
  for (const r of rows) { const k = keyOf(r); if (typeof k === "string" && k) out[k] = (out[k] || 0) + 1; }
  return out;
}
async function countGroupVisits(campaignId) {
  if (typeof campaignId !== "string" || !campaignId) return {};
  const fdb = firestore();
  const rows = fdb
    ? (await fdb.collection("portal_events").where("campaign_id", "==", campaignId).get()).docs.map((d) => d.data())
    : require("./db").mem.portalEvents.filter((e) => e && e.campaign_id === campaignId);
  return tally(rows.filter((e) => e.type === "group_visit"), (e) => e.attempt_key);
}
async function countLeadsByAttribution(campaignId) {
  if (typeof campaignId !== "string" || !campaignId) return {};
  const fdb = firestore();
  let rows;
  if (fdb) {
    let q = fdb.collection("lead_submissions").where("attribution.campaign_id", "==", campaignId);
    if (typeof q.select === "function") q = q.select("attribution"); // never the prospect's name or phone
    rows = (await q.get()).docs.map((d) => d.data());
  } else rows = require("./db").mem.leadSubmissions.filter((l) => l && l.attribution && l.attribution.campaign_id === campaignId);
  return tally(rows, (l) => l.attribution && l.attribution.attempt_key);
}

module.exports = {
  consumeClick, attributionFor, withoutClick, countGroupVisits, countLeadsByAttribution, readCookie,
  COOKIE, REF_TTL_S, VISIT_WINDOW_MS,
  _test: { reset() { for (const m of Object.values(maps)) m.clear(); }, maps, cookieHeader },
};
