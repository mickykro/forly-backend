/*
 * page-update.js — "update the page on Dalyot 35" from the WhatsApp chat.
 * Split out of whatsapp-intake.js (which routes to it and holds the photos
 * that follow, see updatingTurn there).
 */
const R = require("./whatsapp-replies");
const D = require("./property-draft");
const C = require("./draft-corrections");
const { openerOf } = require("./property-intent");
const { inPlace } = require("./utils");

// Chat field → the page's property field (and the listing's, same names but deal).
const PAGE_FIELDS = { price: "price", currency: "currency", rooms: "rooms", size_sqm: "size_sqm", floor: "floor", parking: "parking",
  city: "city", address: "address", neighborhood: "neighborhood", deal: "listing_type" };
const autoTitle = (p) => `${p.rooms || ""} חד׳ ${inPlace(p.neighborhood || p.city)}`.trim();

// The page whose address / neighborhood / city / title shares the most words
// with the message; null on no match or a tie.
const GENERIC_WORDS = /^(רחוב|שכונת|שכונה|חד|דירה|דירת)$/;
function matchPage(pages, text) {
  const words = (p) => [...new Set([p.property.address, p.property.neighborhood, p.property.city, p.property.title]
    .join(" ").split(/[\s,.:'"׳״-]+/).filter((w) => w.length >= 2 && !GENERIC_WORDS.test(w)))];
  const scored = pages.map((p) => ({ p, n: words(p).filter((w) => text.includes(w)).length }));
  const best = Math.max(...scored.map((s) => s.n));
  const top = scored.filter((s) => s.n === best);
  return best > 0 && top.length === 1 ? top[0].p : null;
}

/*
 * "תעדכן את המחיר בדף של דליות 35 ל-1.39 מיליון": the values it names, as a
 * proposal the agent approves ("כן") before anything on the live page changes.
 * Only fields the message actually names count: "דליות 35" identifies the
 * page, it is not a new address — unless the message says "כתובת" / "עיר".
 * → null when nothing on the page would change.
 */
async function proposeChanges(page, text, deps) {
  const named = new Set(C.hintedFields(text));
  if (named.has("price")) named.add("currency"); // "המחיר ביורו" / "285,000 אירו" re-currencies the page
  if (/כתובת/.test(text)) named.add("address");
  if (/עיר/.test(text)) named.add("city");
  if (!named.size || !deps.parseListing || !deps.extractAllowed(page.business_phone || "")) return null;
  let fields;
  try { fields = (await deps.parseListing(text)).fields || {}; } catch (err) { return null; }
  const current = {}, changes = {};
  for (const f of named) {
    const v = fields[f], now = page.property[PAGE_FIELDS[f]];
    current[f] = f === "deal" ? (now === "rent" ? "rent" : "sale") : f === "currency" ? (now || "ILS") : now;
    if (PAGE_FIELDS[f] && v !== null && v !== undefined && v !== current[f]) changes[f] = v;
  }
  if (!Object.keys(changes).length) return null;
  current.currency = page.property.currency || "ILS"; // prices in the confirmation read in the page's currency
  const pagePatch = {}, listingPatch = {};
  for (const [f, v] of Object.entries(changes)) { pagePatch[`property.${PAGE_FIELDS[f]}`] = v; listingPatch[PAGE_FIELDS[f]] = v; }
  // An auto-built title ("4 חד׳ בפארק") follows its fields; a title the agent wrote stays.
  const after = { ...page.property, ...Object.fromEntries(Object.entries(changes).map(([f, v]) => [PAGE_FIELDS[f], v])) };
  if (page.property.title === autoTitle(page.property) && autoTitle(after) !== page.property.title) pagePatch["property.title"] = autoTitle(after);
  return { page_id: page.page_id, listing_id: page.listing_id || null, changes, current, pagePatch, listingPatch };
}

/*
 * "Update the photos of the page on Dalyot 35" / "a new video for it": the page
 * editor already swaps photos, video and details, so the agent gets its link.
 * Photos sent right after are for that page, not for AI editing: an "updating"
 * draft holds them (D.isExpiredPrompt ends the hold) instead of passing them on
 * to n8n, which would edit every one of them.
 */
async function updatePage(phone, text, deps, now, suspended = null) {
  const pages = deps.listPages ? await deps.listPages(phone) : [];
  if (!pages.length) return { handled: false, status: "no_pages", replies: [] };
  const page = matchPage(pages, String(text || ""));
  // Mid-draft, "לעדכן מחיר" that names no page is about the draft itself, not a live page.
  if (suspended && !page) return { handled: false, status: "no_page_named", replies: [] };
  const links = (page ? [page] : pages.slice(0, 5))
    .map((p) => ({ title: p.property.title || p.property.address || p.page_id, url: deps.editUrl(p.page_id) }));
  // An open property draft waits inside the update (suspended) and comes back after it.
  const draft = { phone, status: "updating", links, created_at: now, updated_at: now, hinted_at: now, suspended };
  // One page named: photos sent now can go straight into its gallery (after asking).
  if (page) draft.page = { page_id: page.page_id, listing_id: page.listing_id || null, gallery: ((page.gallery || {}).images || []).slice(0, 12) };
  const pending = page ? await proposeChanges(page, String(text || ""), deps) : null;
  if (pending) {
    draft.pending_page = pending;
    return { handled: true, status: "page_changes_proposed", draft, replies: [R.confirmPageChanges(links[0].title, pending.changes, pending.current)] };
  }
  return { handled: true, status: page ? "update_link" : "update_list", draft, replies: [R.editLinks(links)] };
}

// Photos while the hold lasts are the page's: held with a reminder. Text is a
// fresh ask or ends the hold. h: whatsapp-intake's openDraft / promptFor / resumePrompt.
async function updatingTurn(input, deps, draft, now, h) {
  const back = draft.suspended ? D.touch(draft.suspended, now) : null;
  const andBack = (replies) => (back ? [R.oneBubble([...replies, R.backToDraft(), ...h.promptFor(back, deps).replies])] : replies);
  // Photos for the named page: held, then (the burst over) replace or add — asked, written on the answer.
  if (input.event === "photo_timer" && (draft.held_photos || []).length) {
    draft.pending_photos = true;
    return { handled: true, status: "page_photos_asked", draft, replies: [R.pagePhotosAsk(draft.links[0].title, draft.page.gallery.length, draft.held_photos.length)] };
  }
  if (input.event) return { handled: false, status: "not_ours", replies: [] };
  const incoming = input.fileUrls && input.fileUrls.length ? input.fileUrls : input.fileUrl ? [input.fileUrl] : null;
  if (incoming && draft.page) {
    const settled = await Promise.allSettled(incoming.map((u) => deps.importPhoto(u)));
    const hosted = settled.filter((s) => s.status === "fulfilled" && s.value).map((s) => s.value);
    draft.held_photos = [...new Set((draft.held_photos || []).concat(hosted))].slice(0, 12);
    draft.updated_at = now;
    return { handled: true, status: `page_photos_held:${draft.held_photos.length}`, draft, replies: [], armPhotoTimer: true };
  }
  if (draft.pending_photos) {
    const text = String(input.text || "");
    const replace = /החלף|להחליף/.test(text), add = /הוסף|להוסיף/.test(text);
    if (replace || add) {
      const fresh = draft.held_photos.map((url) => ({ url, caption: "", description: "" }));
      const images = (replace ? fresh : draft.page.gallery.concat(fresh)).slice(0, 12);
      await deps.updatePageData({ page_id: draft.page.page_id, listing_id: draft.page.listing_id,
        pagePatch: { "gallery.images": images }, listingPatch: { photos_urls: images.map((i) => i.url) } });
      draft.page.gallery = images; draft.held_photos = []; draft.pending_photos = false;
      return { handled: true, status: "page_photos_updated", draft: back || draft, replies: andBack([R.pagePhotosDone(images.length, draft.links[0].url)]) };
    }
  }
  if ((input.fileUrls && input.fileUrls.length) || input.fileUrl || input.videoUrl) {
    // One reminder per burst, not per webhook.
    const quiet = now.getTime() - D.asMillis(draft.hinted_at) < 60000;
    if (!quiet) draft.hinted_at = now;
    draft.updated_at = now;
    return { handled: true, status: "update_held", draft, replies: quiet ? [] : [R.editHeld(draft.links)] };
  }
  const pending = draft.pending_page;
  if (pending) {
    const cmd = D.command(input.text);
    draft.pending_page = null;
    if (cmd === "yes") {
      await deps.updatePageData(pending);
      return { handled: true, status: "page_updated", draft: back || draft, replies: andBack([R.pageUpdated(pending.changes, draft.links[0].url, pending.current && pending.current.currency)]) };
    }
    if (cmd === "no") return { handled: true, status: "page_kept", draft: back || draft, replies: andBack([R.kept()]) };
  }
  const kind = await openerOf(input.text, deps);
  if (kind === "update" || (kind && !back)) return h.openDraft(draft.phone, kind, input.text, deps, now, back);
  if (kind) return h.resumePrompt(back, { text: input.text }, now); // a new property, with a draft still open
  // Talk about something else: the hold ends (the waiting draft is back, n8n answers).
  return back ? { handled: false, status: "not_ours", replies: [], draft: back } : { handled: false, status: "not_ours", replies: [], del: true };
}

/*
 * A new draft at an address that already has a live page (972546582548 rebuilt
 * "מבצע נחשון 74" — her page "נחשון 74"). Asked once, when the address is known:
 * update the existing page (the draft's photos go to it, replace/add asked) or a
 * new page after all.
 */
const addrWords = (s) => String(s || "").replace(/רחוב|שדרות|שד׳|[.,'"׳״-]/g, " ").split(/\s+/).filter(Boolean);
function sameAddress(a, b) {
  const x = addrWords(a), y = addrWords(b);
  const nx = x.find((w) => /^\d+$/.test(w)), ny = y.find((w) => /^\d+$/.test(w));
  if (!nx || nx !== ny) return false;
  const wx = x.filter((w) => w !== nx), wy = y.filter((w) => w !== ny);
  const [small, big] = wx.length <= wy.length ? [wx, wy] : [wy, wx];
  return small.length > 0 && small.every((w) => big.includes(w));
}
async function duplicateCheck(t, deps) {
  const d = t.draft;
  if (!t.handled || !d || d.status !== "active" || d.dup_checked || !d.fields.address || !deps.listPages) return t;
  d.dup_checked = true;
  let pages = [];
  try { pages = await deps.listPages(d.phone); } catch (err) { return t; }
  const page = pages.find((p) => sameAddress(p.property.address, d.fields.address));
  if (!page) return t;
  const title = page.property.title || page.property.address;
  d.dup_page = { page_id: page.page_id, listing_id: page.listing_id || null, title, url: deps.editUrl(page.page_id),
    gallery: ((page.gallery || {}).images || []).slice(0, 12) };
  return { ...t, status: "duplicate_asked", replies: [R.duplicatePage(title)] };
}
function duplicateTurn(input, draft, now, promptFor) {
  const dup = draft.dup_page;
  if (!dup) return null;
  const text = String(input.text || "");
  if (/לעדכן|קיים/.test(text)) {
    const n = draft.photos.length;
    const upd = { phone: draft.phone, status: "updating", links: [{ title: dup.title, url: dup.url }], created_at: now, updated_at: now, hinted_at: now,
      page: { page_id: dup.page_id, listing_id: dup.listing_id, gallery: dup.gallery }, held_photos: draft.photos, pending_photos: n > 0 };
    return { handled: true, status: "duplicate_update", draft: upd,
      replies: [n ? R.pagePhotosAsk(dup.title, dup.gallery.length, n) : R.editLinks(upd.links)] };
  }
  if (/חדש/.test(text)) {
    draft.dup_page = null;
    return { handled: true, status: "duplicate_new", draft: D.touch(draft, now), replies: promptFor(draft).replies };
  }
  return { handled: true, status: "duplicate_asked", replies: [R.duplicatePage(dup.title)] };
}

module.exports = { updatePage, updatingTurn, matchPage, proposeChanges, duplicateCheck, duplicateTurn, sameAddress };
