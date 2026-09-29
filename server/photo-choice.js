/*
 * photo-choice.js — photos sent with no caption and no property draft open.
 *
 * n8n used to AI-edit every such photo (10 photos = 10 paid edits), though the
 * agent usually meant a property page. Now the burst is held (a "photo_choice"
 * draft, see D.isExpiredPrompt) and, once it goes quiet (the route's photo
 * timer), the agent is asked once:
 *   1 new page · 2 an existing page · 3 improve all · 4 improve 3 as a sample
 * Only 3/4, or an edit instruction typed instead, hand the photos to n8n:
 * { handled:false, edit_photos, edit_instruction } — n8n edits exactly those.
 *
 * whatsapp-intake.js routes here and passes its openers in `h` (openDraft,
 * openerOf, storePhoto, updatePage) so the two files don't require each other.
 */
const R = require("./whatsapp-replies");

const MAX_PHOTOS = 12;
const SAMPLE = 3;

function hold(draft, phone, urls, now) {
  const d = draft && draft.status === "photo_choice" ? draft : { phone, status: "photo_choice", photos: [], created_at: now };
  d.photos = [...new Set(d.photos.concat(urls))].slice(0, MAX_PHOTOS);
  d.updated_at = now;
  return { handled: true, status: `photo_choice:${d.photos.length}`, draft: d, replies: [], armPhotoTimer: true };
}

// The photo timer: the burst is over, ask with the real count.
function ask(draft) {
  return { handled: true, status: "photo_choice_asked", replies: [R.photoChoice(draft.photos.length)] };
}

const edit = (photos, instruction) =>
  ({ handled: false, status: "edit_photos", del: true, replies: [], edit_photos: photos, edit_instruction: instruction });

async function turn(input, deps, draft, now, h) {
  if (input.event) return { handled: false, status: "not_ours", replies: [] };
  const photos = input.fileUrls && input.fileUrls.length ? input.fileUrls : input.fileUrl ? [input.fileUrl] : null;
  if (photos) return hold(draft, draft.phone, photos, now);
  const text = String(input.text || "").trim();
  const n = /^[1-4]$/.test(text) ? Number(text) : null;
  if (n === 3) return edit(draft.photos, "");
  if (n === 4) return edit(draft.photos.slice(0, SAMPLE), "");
  const kind = n ? null : await h.openerOf(text, deps);
  if (n === 2 || kind === "update") {
    const t = await h.updatePage(draft.phone, text, deps, now);
    return t.handled ? t : { handled: true, status: "no_pages", replies: [R.noPages()] };
  }
  if (n === 1 || kind) {
    const opened = await h.openDraft(draft.phone, n === 1 ? "keyword" : kind, text, deps, now);
    if (!opened.draft) return opened;
    const s = await h.storePhoto(opened.draft, draft.photos, deps, now);
    return { ...opened, draft: s.draft, replies: [R.photosSaved(s.draft.photos.length), ...opened.replies] };
  }
  // "תעשי אותן מוארות": an instruction for these photos. One word ("היי") asks again.
  if (text.split(/\s+/).length >= 2) return edit(draft.photos, text);
  return ask(draft);
}

module.exports = { hold, ask, turn };
