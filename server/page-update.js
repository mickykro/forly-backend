/*
 * page-update.js — "update the page on Dalyot 35" from the WhatsApp chat.
 * Split out of whatsapp-intake.js (which routes to it and holds the photos
 * that follow, see updatingTurn there).
 */
const R = require("./whatsapp-replies");

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
 * "Update the photos of the page on Dalyot 35" / "a new video for it": the page
 * editor already swaps photos, video and details, so the agent gets its link.
 * Photos sent right after are for that page, not for AI editing: an "updating"
 * draft holds them (D.isExpiredPrompt ends the hold) instead of passing them on
 * to n8n, which would edit every one of them.
 */
async function updatePage(phone, text, deps, now) {
  const pages = deps.listPages ? await deps.listPages(phone) : [];
  if (!pages.length) return { handled: false, status: "no_pages", replies: [] };
  const page = matchPage(pages, String(text || ""));
  const links = (page ? [page] : pages.slice(0, 5))
    .map((p) => ({ title: p.property.title || p.property.address || p.page_id, url: deps.editUrl(p.page_id) }));
  const draft = { phone, status: "updating", links, created_at: now, updated_at: now, hinted_at: now };
  return { handled: true, status: page ? "update_link" : "update_list", draft, replies: [R.editLinks(links)] };
}

module.exports = { updatePage, matchPage };
