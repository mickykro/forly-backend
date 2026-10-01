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
const D = require("./property-draft");

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
  const m = /^([1-4])\s*[.)]?$/.exec(text); // "3", "3.", "3)"
  const n = m ? Number(m[1]) : null;
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

/*
 * A reply to an image with a comment ("תעשי אותה בהירה", quoting it): an edit of
 * that one image, handed to n8n like choice 3. Thanks/praise ("יפה!"), one word
 * and commands are not edit requests. → null when it isn't one.
 */
const PRAISE = /^(יפה|מהמם|מושלם|תודה|וואו|אהבתי|מעולה|אחלה|סבבה|מדהים|יופי|👍|❤️|🙏)/;
function quotedEdit(input) {
  const text = String(input.text || "").trim();
  if (!input.quotedImageUrl || D.command(text) || PRAISE.test(text) || text.split(/\s+/).length < 2) return null;
  return { ...edit([input.quotedImageUrl], text), del: false, status: "edit_quoted" };
}

/*
 * "תשנה את התמונות בנכס" in an open draft. Photos just sent (last batch, within
 * 5 min) → ask before replacing: "להחליף את 8 התמונות ב-2 החדשות, או להוסיף?".
 * Nothing new yet → the next photos replace the old ones (draft.replace_next,
 * applied in whatsapp-intake's storePhoto). → null when the text isn't about it.
 */
const SWAP_RE = /(תשנה|תשני|תחליף|תחליפי|להחליף|לשנות|תעדכן|תעדכני|לעדכן)\s+(את\s+)?ה?תמונות/;
const BATCH_MS = 5 * 60 * 1000;

// storePhoto calls this: photos within a minute of each other are one batch.
function noteBatch(draft, added, now) {
  const b = draft.last_batch;
  const same = b && now.getTime() - D.asMillis(b.at) < 60000;
  draft.last_batch = { at: now, photos: (same ? b.photos : []).concat(added) };
}

const isSwap = (text) => SWAP_RE.test(String(text || ""));

function swapTurn(input, draft, now, promptReplies) {
  const text = String(input.text || "").trim();
  const done = (first) => ({ handled: true, status: "photos_swapped", draft: D.touch(draft, now), replies: [R.oneBubble([first, ...promptReplies(draft)])] });
  if (draft.pending_swap) {
    draft.pending_swap = false;
    const fresh = (draft.last_batch && draft.last_batch.photos) || [];
    if (/החלף|להחליף/.test(text)) { draft.photos = draft.photos.filter((p) => fresh.includes(p)); return done(R.photosSaved(draft.photos.length)); }
    if (/הוסף|להוסיף/.test(text)) return done(R.photosSaved(draft.photos.length));
  }
  if (!SWAP_RE.test(text)) return null;
  const b = draft.last_batch;
  const recent = b && b.photos.length && now.getTime() - D.asMillis(b.at) < BATCH_MS && b.photos.length < draft.photos.length;
  if (recent) {
    draft.pending_swap = true;
    return { handled: true, status: "swap_asked", draft: D.touch(draft, now), replies: [R.swapPhotos(draft.photos.length - b.photos.length, b.photos.length)] };
  }
  draft.replace_next = true;
  return { handled: true, status: "replace_next", draft: D.touch(draft, now), replies: [R.sendReplacements(draft.photos.length)] };
}

/*
 * "אני רוצה להעלות 12 תמונות וננקה אותן, נמחק מלל…" and then the photos, with no
 * caption: the request is remembered ("edit_request" draft, 10 min, see
 * D.isExpiredPrompt) and the photos are edited with it — not asked 1/2/3/4, and
 * not the default enhancement. Any other text ends it.
 */
const EDIT_VERB = /(תנקה|תנקי|לנקות|ננקה|תערוך|תערכי|לערוך|נערוך|תשפר|תשפרי|לשפר|נשפר|תבהיר|להבהיר|נבהיר|תחדד|לחדד|נחדד|תסיר|תסירי|להסיר|נסיר|תמחק|תמחקי|למחוק|נמחק|תעצב|תעצבי|לעצב)/;
function editRequest(text, phone, now) {
  const t = String(text || "").trim();
  if (!/תמונ/.test(t) || !EDIT_VERB.test(t)) return null;
  return { handled: false, status: "not_ours", replies: [], draft: { phone, status: "edit_request", text: t.slice(0, 1000), created_at: now, updated_at: now } };
}
// "אני רוצה לערוך עוד תמונות לנכס אחר" says to edit, not how: n8n's default enhancement then.
const GENERIC_WORDS = new Set(["היי", "פורלי", "אני", "רוצה", "רוצים", "צריך", "צריכה", "בבקשה", "עוד", "את", "של", "גם", "כמה", "אלה", "האלה",
  "תמונות", "התמונות", "תמונה", "לנכס", "נכס", "לדירה", "אחר", "אחרת", "חדש", "חדשה", "שלי", "לי", "ל", "ה", "ו"]);
function instructionOf(text) {
  const rest = String(text || "").replace(/[.,!?:;״"'׳()\-]/g, " ").split(/\s+/).filter(Boolean)
    .filter((w) => !GENERIC_WORDS.has(w) && !EDIT_VERB.test(w));
  return rest.length ? text : "";
}
function editWith(draft, urls, now) {
  draft.updated_at = now; // the rest of the burst uses it too
  return { handled: false, status: "edit_requested", replies: [], draft, edit_photos: urls, edit_instruction: instructionOf(draft.text) };
}

// ── moved from whatsapp-intake.js (promptFor is its next-question) ──
// The agent's own video: re-hosted and used instead of a generated walkthrough.
async function storeVideo(draft, url, deps, now, promptFor) {
  let hosted = null;
  try { hosted = await deps.importVideo(url); } catch (err) { console.warn("[whatsapp-intake] video import failed:", err.message); }
  if (!hosted) return { handled: true, status: "video_failed", replies: [R.videoFailed()] };
  draft.video_url = hosted;
  const p = promptFor(draft, deps);
  return { handled: true, status: "video_stored", draft: D.touch(draft, now), replies: [R.oneBubble([R.videoSaved(), ...p.replies])] };
}

// One bubble: the photo count and whatever comes next, so photos sent mid-questions
// never look ignored. Reports (and clears) photos dropped over the 54 cap.
function photoTimer(draft, deps, now, promptFor) {
  const n = draft.photos.length;
  const dropped = draft.photos_dropped || 0;
  draft.photos_dropped = 0;
  // The draft is always returned (even when nothing but the buttons changed):
  // routes/whatsapp.js reads its reply's buttons off `turn.draft.last_buttons`
  // to resolve the agent's next "1"/"2" — dropping the draft here left that
  // stale, so a numbered reply to this exact message silently failed.
  const touched = D.touch(draft, now);
  if (D.nextStep(draft).kind === "photos") {
    const r = [R.photosProgress(n)];
    if (dropped) r.unshift(R.photosSaved(n, dropped));
    return { handled: true, status: `photos_progress:${n}`, draft: touched, replies: [R.oneBubble(r)] };
  }
  const p = promptFor(draft, deps);
  return { handled: true, status: p.status, draft: touched, replies: [R.oneBubble([R.photosSaved(n, dropped), ...p.replies])] };
}

module.exports = { hold, ask, turn, quotedEdit, noteBatch, swapTurn, isSwap, editRequest, editWith, storeVideo, photoTimer };
