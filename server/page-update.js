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
const PAGE_FIELDS = { price: "price", rooms: "rooms", size_sqm: "size_sqm", floor: "floor", parking: "parking",
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
  if (/כתובת/.test(text)) named.add("address");
  if (/עיר/.test(text)) named.add("city");
  if (!named.size || !deps.parseListing || !deps.extractAllowed(page.business_phone || "")) return null;
  let fields;
  try { fields = (await deps.parseListing(text)).fields || {}; } catch (err) { return null; }
  const current = {}, changes = {};
  for (const f of named) {
    const v = fields[f], now = page.property[PAGE_FIELDS[f]];
    current[f] = f === "deal" ? (now === "rent" ? "rent" : "sale") : now;
    if (PAGE_FIELDS[f] && v !== null && v !== undefined && v !== current[f]) changes[f] = v;
  }
  if (!Object.keys(changes).length) return null;
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
  if (input.event) return { handled: false, status: "not_ours", replies: [] };
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
      return { handled: true, status: "page_updated", draft: back || draft, replies: andBack([R.pageUpdated(pending.changes, draft.links[0].url)]) };
    }
    if (cmd === "no") return { handled: true, status: "page_kept", draft: back || draft, replies: andBack([R.kept()]) };
  }
  const kind = await openerOf(input.text, deps);
  if (kind === "update" || (kind && !back)) return h.openDraft(draft.phone, kind, input.text, deps, now, back);
  if (kind) return h.resumePrompt(back, { text: input.text }, now); // a new property, with a draft still open
  // Talk about something else: the hold ends (the waiting draft is back, n8n answers).
  return back ? { handled: false, status: "not_ours", replies: [], draft: back } : { handled: false, status: "not_ours", replies: [], del: true };
}

module.exports = { updatePage, updatingTurn, matchPage, proposeChanges };
