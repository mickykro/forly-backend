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
const C = require("./draft-corrections");
const { updatePage, updatingTurn, duplicateCheck, duplicateTurn } = require("./page-update");
const { intentOf, openerOf } = require("./property-intent");
const { recoverFromChat } = require("./chat-recover");
const PC = require("./photo-choice"), { offerTimer, offeredDraft } = PC;

const MAX_PHOTOS = 54; // walkthrough: up to 6 clips × 9 reference photos
const { oneBubble } = R;

const notOurs = (status) => ({ handled: false, status, replies: [] });

// Multiple photos when n8n's burst debounce bundles them into one webhook
// (input.fileUrls), else the ordinary single photo (input.fileUrl); null
// when the turn carries no photo at all.
function photoUrlsOf(input) {
  if (Array.isArray(input.fileUrls) && input.fileUrls.length) return input.fileUrls;
  return input.fileUrl ? [input.fileUrl] : null;
}

// What to say for the step the draft is at. Reaching "confirm" sends a link
// to create.html, pre-filled from the draft, where the agent reviews the
// photos, edits anything, and builds the page themselves — see
// server/routes/whatsapp.js's /review and /draft routes.
function promptFor(draft, deps) {
  const step = D.nextStep(draft);
  if (step.kind === "ask") return { status: `asked:${step.field}`, replies: [R.ask(step.field)] };
  if (step.kind === "photos" && (draft.offered_photos || []).length) return { status: "use_edited", replies: [R.useEdited(draft.offered_photos.length)] };
  if (step.kind === "photos") return { status: "photos", replies: [R.askPhotos()] };
  if (step.kind === "choose") return { status: "choose", replies: [R.choose()] };
  if (step.kind === "create") return { status: "create", replies: [] }; // handleTurn builds it
  return { status: "confirm", replies: [R.reviewReady(deps.reviewLink(draft.phone), draft.skipped)] };
}

// Build the page straight from the draft (the agent chose "ליצור"). On failure
// the draft stays as is, so the next message retries.
async function build(draft, deps, now) {
  let res;
  try { res = await deps.createListing(D.listingBody(draft)); } catch (err) {
    console.error("[whatsapp-intake] create failed:", err);
    res = { error: "create_failed", code: 500 };
  }
  if (res.error) {
    const reply = res.code === 402 ? R.outOfQuota(res.message) : R.createFailed(deps.createUrl);
    return { handled: true, status: `create_failed:${res.code}`, draft: D.touch(draft, now), replies: [reply] };
  }
  draft.status = "building";
  draft.listing_id = res.listing_id;
  return { handled: true, status: "building", draft: D.touch(draft, now), replies: [R.building(draft.fields)] };
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
    const p = promptFor(draft, deps);
    return { handled: true, status: `source_error:${code}`, draft, replies: [R.sourceError(code, deps.createUrl), ...p.replies] };
  }
  for (const [k, v] of Object.entries(parsed.fields)) if (k in draft.fields && k !== "description" && v !== null) draft.fields[k] = v;
  // A scraped page's text isn't the agent's; pasted listing text is, and it is the description.
  if (kind === "text") draft.fields.description = D.parseAnswer("description", text);
  const extra = [];
  if (kind === "link") {
    // The agent's own words next to the link are newer than the listing: they win.
    const comment = String(text).replace(/https?:\/\/\S+/gi, " ").trim();
    if (C.hintedFields(comment).length) {
      try { C.apply(draft, pick((await deps.parseListing(comment)).fields)); } catch (err) { /* the link alone still counts */ }
    }
    if ((String(text).match(/https?:\/\//gi) || []).length > 1) extra.push(R.firstLinkOnly());
  }
  draft.photos = await importAll((src.photos || []).map((p) => p.url), deps.importPhoto);
  // The listing had photos but none could be kept: say so, or the agent assumes they're in.
  if ((src.photos || []).length && !draft.photos.length) extra.push(R.listingPhotosFailed());
  const p = promptFor(draft, deps);
  return { handled: true, status: p.status, draft, replies: [R.opened(kind, draft.fields), ...extra, ...p.replies] };
}

// Non-null extracted values for the fields a draft asks about (description stays the agent's).
function pick(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) if (v !== null && k !== "description" && k !== "template") out[k] = v;
  return out;
}

function openFromKeyword(phone, deps, now) {
  const draft = D.newDraft(phone, "keyword", now);
  const p = promptFor(draft, deps);
  return { handled: true, status: p.status, draft, replies: [R.opened("keyword"), ...p.replies] };
}

async function openDraft(phone, kind, text, deps, now, suspended = null) {
  if (kind === "update") return updatePage(phone, text, deps, now, suspended);
  if (kind === "intent") return openFromIntent(phone, text, deps, now);
  return kind === "keyword" ? openFromKeyword(phone, deps, now) : openFromSource(phone, kind, text, deps, now);
}

// The same message may already carry details ("סביון, 8 חדרים, 32 מיליון"): they fill the draft.
async function withDetails(t, text, deps, now) {
  if (!C.hintedFields(text).length || !deps.extractAllowed(t.draft.phone)) return t;
  const r = await C.smartAnswer(t.draft, text, deps, now, D.nextStep(t.draft).field || null, promptFor);
  return r ? { ...r, replies: [...t.replies.slice(0, -1), ...r.replies] } : t;
}

async function openFromIntent(phone, text, deps, now) {
  return withDetails(openFromKeyword(phone, deps, now), text, deps, now);
}

// One answer to the field currently being asked.
function answerField(draft, field, text, cmd, deps) {
  if (cmd === "skip") {
    if (D.isRequired(field)) return { status: `required:${field}`, replies: [R.required(field)], draft };
    draft.skipped.push(field);
    const p = promptFor(draft, deps);
    return { status: p.status, replies: p.replies, draft };
  }
  const value = D.parseAnswer(field, text);
  if (value === null) {
    const attempt = draft.retry && draft.retry.field === field ? draft.retry.n + 1 : 1;
    draft.retry = { field, n: attempt };
    return { status: `invalid:${field}`, replies: [R.invalid(field, attempt)], draft };
  }
  draft.retry = null;
  draft.fields[field] = value;
  if (field === "price") D.noteCurrency(draft, text);
  const p = promptFor(draft, deps);
  return { status: p.status, replies: p.replies, draft };
}

// A photo (or several, when n8n's burst debounce bundles them into one
// webhook) is stored silently; the route arms a timer and calls back with
// event:"photo_timer" so the agent gets one progress message per batch.
async function storePhoto(draft, fileUrlOrUrls, deps, now) {
  const raw = Array.isArray(fileUrlOrUrls) ? fileUrlOrUrls : [fileUrlOrUrls];
  // n8n can deliver the same burst twice (two debounce winners): skip sources already stored.
  const seen = draft.photo_sources || [];
  const urls = [...new Set(raw)].filter((u) => !seen.includes(u));
  draft.photo_sources = seen.concat(urls);
  if (draft.replace_next) { draft.photos = []; draft.replace_next = false; } // "תחליף את התמונות" came first
  const room = Math.max(0, MAX_PHOTOS - draft.photos.length);
  if (urls.length > room) draft.photos_dropped = (draft.photos_dropped || 0) + urls.length - room;
  const added = await importAll(urls.slice(0, room), deps.importPhoto);
  draft.photos.push(...added);
  PC.noteBatch(draft, added, now);
  return { handled: true, status: "photo_stored", draft: D.touch(draft, now), replies: [], armPhotoTimer: true };
}

/*
 * n8n just finished editing a photo → it may become a property page.
 * Business Handler edits photos one at a time, so this arrives once per photo:
 * pile them on a silent `offered` draft; the photo timer asks once the batch
 * has gone quiet, with the real count (offerTimer). A later batch after a sent
 * offer starts a fresh one — never mixing photos of two properties.
 */
async function photosEdited(input, deps, draft, now) {
  const { phone } = input;
  const hosted = await importAll(input.photos || [], deps.importPhoto);
  if (draft && draft.status === "edit_request" && draft.suspended && !draft.keep_apart) draft = draft.suspended;
  if (draft && draft.status === "active" && !D.isPaused(draft, now)) {
    draft.photos = draft.photos.concat(hosted).slice(0, MAX_PHOTOS);
    // Edits asked from inside the draft: one message when the last one is back, not one each.
    if (draft.editing > 0 && (draft.editing -= hosted.length) > 0) return { handled: true, status: `edits_pending:${draft.editing}`, draft: D.touch(draft, now), replies: [] };
    draft.editing = 0;
    const p = promptFor(draft, deps);
    return { handled: true, status: p.status, draft: D.touch(draft, now), replies: [R.photosSaved(draft.photos.length), ...p.replies] };
  }
  if (draft && draft.status === "active") return resumePrompt(draft, { photos: hosted }, now);
  // The resume question is already out (photos arrive one per call): keep piling
  // the batch onto the pending opener instead of starting a rival offered draft
  // over the paused one, which would silently throw the paused draft away.
  if (draft && draft.status === "resume_prompt") {
    const o = draft.pending_opener || {};
    draft.pending_opener = { ...o, photos: (o.photos || []).concat(hosted).slice(0, MAX_PHOTOS) };
    return { handled: true, status: `resume_pending:${draft.pending_opener.photos.length}`, draft: D.touch(draft, now), replies: [] };
  }
  // n8n's batch edit reports once, at the end, with every photo: that batch is the offer, now.
  if (input.batchDone) {
    const fresh = offeredDraft(phone, now);
    fresh.photos = hosted.slice(0, MAX_PHOTOS);
    if (!fresh.photos.length) return { handled: true, status: "batch_empty", replies: [] };
    fresh.offer_sent = true;
    return { handled: true, status: "offered", draft: fresh, replies: [R.offer(fresh.photos.length)] };
  }
  const target = draft && draft.status === "offered" && !draft.offer_sent ? draft : offeredDraft(phone, now);
  target.photos = target.photos.concat(hosted).slice(0, MAX_PHOTOS);
  D.touch(target, now);
  return { handled: true, status: `offer_pending:${target.photos.length}`, draft: target, replies: [], armPhotoTimer: true };
}

function resumePrompt(draft, opener, now) {
  draft.status = "resume_prompt";
  draft.pending_opener = opener;
  return { handled: true, status: "resume_prompt", draft: D.touch(draft, now), replies: [R.resumePrompt(D.summary(draft))] };
}

// "כן" — or a page asked for from these photos ("תבני מזה דף") — takes the
// offered photos. "נכס חדש", a listing or "אני רוצה לבנות דף" is a property of
// its own (the offered photos may be of another one): a fresh draft. Anything
// else ignores the offer, which is dropped.
const FROM_THESE = /מזה|מהן|מהם|מהתמונות|מאלה|איתן|איתם|עם התמונות|אותן/;
async function offeredTurn(input, deps, draft, now) {
  if (input.event === "photo_timer") return offerTimer(draft, now);
  if (input.event) return notOurs("not_ours");
  const photos = photoUrlsOf(input);
  if (photos) return PC.hold(null, draft.phone, photos, now);
  const cmd = D.command(input.text);
  if (cmd === "no") return { handled: true, status: "declined", del: true, replies: [R.declined()] };
  const kind = cmd === "yes" ? null : await openerOf(input.text, deps);
  if (cmd === "yes" || /^כן([\s,.!]|$)/.test(String(input.text || "").trim()) || (kind === "intent" && FROM_THESE.test(input.text))) {
    draft.status = "active";
    const p = promptFor(draft, deps);
    const t = { handled: true, status: p.status, draft: D.touch(draft, now), replies: p.replies };
    return kind ? withDetails(t, input.text, deps, now) : t;
  }
  if (kind) {
    // A new property right after an edit batch: the edited photos are offered again at the photos step.
    const t = await openDraft(draft.phone, kind, input.text, deps, now);
    if (t.draft && t.draft.status === "active" && !t.draft.photos.length) t.draft.offered_photos = draft.photos;
    return t;
  }
  return { ...notOurs("not_ours"), del: true };
}

async function resumeTurn(input, deps, draft, now) {
  const cmd = D.command(input.text);
  if (cmd === "cancel") return { handled: true, status: "cancelled", del: true, replies: [R.cancelled()] };
  if (cmd === "resume") {
    const o = draft.pending_opener || {};
    draft.status = "active";
    draft.pending_opener = null;
    // Photos sent while paused: stored now, the photo timer reports them with the next question.
    if (o.file_urls) return storePhoto(draft, o.file_urls, deps, now);
    // Photos edited while paused were sent for this property: they join it.
    const added = o.photos ? o.photos.filter((u) => !draft.photos.includes(u)) : [];
    if (added.length) draft.photos = draft.photos.concat(added).slice(0, MAX_PHOTOS);
    const p = promptFor(draft, deps);
    const replies = added.length ? [R.photosSaved(draft.photos.length), ...p.replies] : p.replies;
    return { handled: true, status: p.status, draft: D.touch(draft, now), replies };
  }
  if (cmd === "new") {
    const o = draft.pending_opener || {};
    if (o.photos) {
      const fresh = offeredDraft(draft.phone, now);
      fresh.photos = o.photos;
      if (fresh.photos.length < D.MIN_PHOTOS) {
        return { handled: true, status: `offer_pending:${fresh.photos.length}`, draft: fresh, replies: [] };
      }
      fresh.offer_sent = true;
      return { handled: true, status: "offered", draft: fresh, replies: [R.offer(fresh.photos.length)] };
    }
    const ed = o.text && !o.file_urls && PC.editRequest(o.text, draft.phone, now);
    if (ed) return { ...ed, handled: true, status: "edit_request", replies: [R.sendForEdit()] };
    // Whatever else the paused message was, "חדש" starts a new property from it (or empty).
    const t = await openDraft(draft.phone, D.openerKind(o.text) || "keyword", o.text, deps, now);
    if (o.file_urls && t.draft) {
      const s = await storePhoto(t.draft, o.file_urls, deps, now);
      return { ...t, draft: s.draft, armPhotoTimer: true };
    }
    return t;
  }
  return { handled: true, status: "resume_prompt", replies: [R.resumePrompt(D.summary(draft))] };
}

async function activeTurn(input, deps, draft, now) {
  if (input.event === "photo_timer") return PC.photoTimer(draft, deps, now, promptFor);
  if (input.videoUrl) return PC.storeVideo(draft, input.videoUrl, deps, now, promptFor);
  const photoUrls = photoUrlsOf(input);
  if (photoUrls) return storePhoto(draft, photoUrls, deps, now);
  const cmd = D.command(input.text);
  if (cmd === "cancel" || D.isRestart(input.text)) return { handled: true, status: "cancelled", del: true, replies: [R.cancelled()] };
  if (cmd === "new") return openDraft(draft.phone, "keyword", "", deps, now); // never an answer to the question
  const edit = PC.editInDraft(draft, input.text, now, false);
  if (edit) return edit;
  const dup = duplicateTurn(input, draft, now, (dr) => promptFor(dr, deps));
  if (dup) return dup;
  const slash = C.parseSlash(input.text);
  if (slash) return C.slashTurn(draft, slash, deps, now, promptFor);
  // A replacement was proposed last turn: כן applies it, anything else keeps the old values.
  if (draft.pending_changes) {
    const changes = draft.pending_changes;
    draft.pending_changes = null;
    if (cmd === "yes" || cmd === "no") {
      if (cmd === "yes") C.apply(draft, changes);
      const p = promptFor(draft, deps);
      const first = cmd === "yes" ? R.updated(changes, draft.fields.currency) : R.kept();
      return { handled: true, status: p.status, draft: D.touch(draft, now), replies: [oneBubble([first, ...C.withPriceCheck(draft, p.replies)])] };
    }
  }
  const swap = PC.swapTurn(input, draft, now, (dr) => promptFor(dr, deps).replies);
  if (swap) return swap;
  const step = D.nextStep(draft);
  // "אני רוצה לעדכן מחיר בנכס בותיקים" mid-draft is about another page: the draft waits
  // inside the update and comes back after it. Answers to a question are not checked
  // unless they name a page/property ("בנכס", "בדף"), which a description may: skipped.
  if (!cmd && step.field !== "description" && (step.kind !== "ask" || /(בנכס|בדף|לנכס|לדף)/.test(input.text || ""))) {
    const kind = await openerOf(input.text, deps);
    if (kind === "update") { const u = await updatePage(draft.phone, input.text, deps, now, draft); if (u.handled) return u; }
    if (kind === "intent") return resumePrompt(draft, { text: input.text }, now);
  }
  // "חסרים פרטים?" / "סיימת?" is a question, never the answer to the field being asked.
  // (Right after a failed answer, "מה זה?" is about that question: the retry example answers it.)
  if (step.kind === "ask" && !cmd && /\?\s*$/.test(String(input.text || "").trim()) && !C.hintedFields(input.text).length
    && !(draft.retry && draft.retry.field === step.field)) {
    return { handled: true, status: `question:${step.field}`, replies: [oneBubble([R.progress(D.missing(draft), draft.photos.length), ...promptFor(draft, deps).replies])] };
  }
  if (!cmd && C.needsExtraction(step.field || null, input.text) && deps.extractAllowed(draft.phone)) {
    const r = await C.smartAnswer(draft, input.text, deps, now, step.field, promptFor);
    if (r) return r;
  }
  if (step.kind === "ask") {
    const r = answerField(draft, step.field, input.text, cmd, deps);
    if (r.draft && (step.field === "price" || step.field === "deal")) r.replies = C.withPriceCheck(r.draft, r.replies);
    return { handled: true, ...r, draft: r.draft ? D.touch(r.draft, now) : undefined };
  }
  if (step.kind === "photos" && (draft.offered_photos || []).length && (cmd === "yes" || cmd === "no")) {
    if (cmd === "yes") draft.photos = draft.photos.concat(draft.offered_photos).slice(0, MAX_PHOTOS);
    draft.offered_photos = null;
    const p = promptFor(draft, deps);
    return { handled: true, status: p.status, draft: D.touch(draft, now), replies: cmd === "yes" ? [oneBubble([R.photosSaved(draft.photos.length), ...p.replies])] : p.replies };
  }
  if (step.kind === "photos") {
    return { handled: true, status: `photos_progress:${draft.photos.length}`, replies: [R.photosProgress(draft.photos.length)] };
  }
  if (step.kind === "choose" && !cmd && C.hintedFields(input.text).length) {
    return { handled: true, status: "field_list", replies: [R.fieldList(draft.fields)] }; // "לעדכן מחיר": how to, here
  }
  if (step.kind === "choose") {
    // "תראה תצוגה מקדימה", "תבני את הדף": the buttons' words inside a sentence count too.
    const t = String(input.text || "");
    const choice = cmd === "preview" || cmd === "create" ? cmd
      : /תצוגה|מקדימה|לצפות/.test(t) ? "preview" : /ליצור|תיצור|לבנות|תבנה|תבני/.test(t) ? "create" : null;
    if (!choice) return { handled: true, status: "choose", replies: [R.choose()] };
    draft.mode = choice;
    const p = promptFor(draft, deps);
    return { handled: true, status: p.status, draft: D.touch(draft, now), replies: p.replies };
  }
  // Preview was chosen: building happens on the review page, so any text —
  // "ליצור" included — (re)sends the link.
  if (cmd === "create") return { handled: true, status: "preview_only", replies: [R.previewOnly(deps.reviewLink(draft.phone))] };
  const p = promptFor(draft, deps);
  return { handled: true, status: p.status, replies: p.replies };
}

async function handleTurn(input, deps) {
  const now = input.now || new Date();
  const { phone } = input;
  if (!deps.business) return notOurs("unknown_agent");
  let draft = input.draft || null;
  // Options go out numbered (see the route's send): "2" is the second one.
  // An agent sometimes repeats the button's own word after the number
  // ("1.כן") — only strip the number when what follows actually is that word,
  // so a number with unrelated trailing text still falls through untouched.
  const digit = /^\s*([1-3])\s*[.)]?\s*(.*)$/.exec(input.text || ""); // "1", "1.", "1) כן"
  if (digit && draft && draft.last_buttons && draft.last_buttons[digit[1] - 1]) {
    const label = draft.last_buttons[digit[1] - 1];
    const rest = D.clean(digit[2]);
    if (rest === "" || rest === D.clean(label)) input = { ...input, text: label };
  }
  let dropped = false;
  if (draft && D.isExpiredPrompt(draft, now)) {
    draft = PC.resumeAfterEdit(draft, now); dropped = !draft;
  }
  const withDrop = (t) => (dropped && !t.draft ? { ...t, del: true } : t);

  if (input.event === "photos_edited") return withDrop(await photosEdited(input, deps, draft, now));
  if (draft && draft.status === "edit_request") {
    if (photoUrlsOf(input) && !input.text && !input.event) return PC.editWith(draft, photoUrlsOf(input), now);
    // Anything else ends it, judged on its own — against the draft that waited, if one did.
    const back = input.event ? draft : PC.resumeAfterEdit(draft, now);
    if (!back) { draft = null; dropped = true; } else if (back !== draft) {
      const t = await handleTurn({ ...input, draft: back }, deps);
      return t.draft || t.del ? t : { ...t, draft: back };
    }
  }

  // A turn that rejected the message ("invalid:price") or simply repeated
  // itself without storing anything ("choose") got nothing out of it.
  const didNotLand = (t) => !t.handled || t.status.startsWith("invalid:")
    || t.status === "not_ours" || (t.status === "choose" && !t.draft);

  // Voice note: transcribe and handle it as the typed message it stands for.
  if (input.audioUrl && !input.text) {
    let heard = null;
    try { heard = await deps.transcribe(input.audioUrl); } catch (err) { console.error("[whatsapp-intake] transcribe failed:", err.message); }
    if (!heard) {
      return draft && draft.status === "active" ? { handled: true, status: "voice_failed", replies: [R.voiceFailed()] } : notOurs("not_ours");
    }
    const before = draft ? structuredClone(draft) : null;
    let t = await handleTurn({ ...input, audioUrl: null, text: heard }, deps);
    // The transcription said nothing the turn could use. Before answering with
    // an error, see whether it was a mis-heard command: "דליק" for "דלג",
    // "תצאו גם מקדימה" for "תצוגה מקדימה". Only here, where the alternative is
    // a failure anyway, is a near match safe to act on.
    if (didNotLand(t)) {
      const cmd = D.spokenCommand(heard);
      if (cmd) t = await handleTurn({ ...input, audioUrl: null, text: D.CANONICAL[cmd], draft: before }, deps);
    }
    if (t.handled && t.replies.length) t.replies[0] = { ...t.replies[0], text: `${R.heard(heard)}\n\n${t.replies[0].text}` };
    return t;
  }
  // "עצור" / "אל תערוך שוב": n8n's edit loop checks the flag before each photo.
  if (D.isStop(input.text) && !(draft && draft.status === "active")) {
    if (deps.cancelEdits) await deps.cancelEdits(phone);
    return { handled: true, status: "stopped", del: !!draft && draft.status === "photo_choice", replies: [R.stopped()] };
  }
  const quoted = PC.quotedEdit(input);
  if (quoted) return quoted;
  if (input.text && photoUrlsOf(input) && !input.event) return textThenPhotos(input, deps, draft);

  const open = draft && (draft.status === "active" || draft.status === "offered");
  if (input.messageType === "documentMessage" && open) {
    // Whatever step the draft is at, the question it's waiting on comes right after.
    const pending = draft.status === "active" ? promptFor(draft, deps).replies : [];
    return { handled: true, status: "document", replies: [oneBubble([R.sendAsImage(), ...pending])] };
  }

  if (!draft) {
    if (photoUrlsOf(input) && !input.event) return PC.hold(null, phone, photoUrlsOf(input), now);
    const kind = await openerOf(input.text, deps);
    if (!kind) {
      const back = input.text && !input.event ? await recoverFromChat(phone, input.text, deps, now, openDraft) : null;
      if (back) return back;
      return withDrop(PC.editRequest(input.text, phone, now) || notOurs("not_ours"));
    }
    return openDraft(phone, kind, input.text, deps, now);
  }
  if (draft.status === "photo_choice") {
    if (input.event === "photo_timer") return PC.ask(draft);
    return PC.turn(input, deps, draft, now, { openDraft, openerOf, storePhoto, updatePage });
  }
  if (draft.status === "updating") return updatingTurn(input, deps, draft, now, { openDraft, promptFor, resumePrompt });
  if (draft.status === "offered") return offeredTurn(input, deps, draft, now);
  if (draft.status === "resume_prompt") return resumeTurn(input, deps, draft, now);
  if (draft.status === "building") {
    if (input.event) return notOurs("not_ours");
    if (photoUrlsOf(input)) return PC.hold(null, phone, photoUrlsOf(input), now);
    const kind = await openerOf(input.text, deps);
    if (!kind) return notOurs("not_ours");
    return openDraft(phone, kind, input.text, deps, now);
  }
  // Paused: any message brings the open draft back up (המשך / חדש / ביטול).
  if (D.isPaused(draft, now)) {
    if (input.event) return notOurs("not_ours");
    return PC.editInDraft(draft, input.text, now, true) || resumePrompt(draft, { text: input.text || null, file_urls: photoUrlsOf(input) }, now);
  }
  // A new link or "נכס חדש" while a draft is open is a different property: ask
  // instead of ignoring it. (Pasted listing text stays an answer — it fills fields.)
  const opener = D.openerKind(input.text);
  if (draft.status === "active" && !draft.dup_page && (opener === "link" || opener === "keyword")) return resumePrompt(draft, { text: input.text }, now);
  const t = await duplicateCheck(await activeTurn(input, deps, draft, now), deps);
  return t.status === "create" ? build(t.draft || draft, deps, now) : t;
}

// Text sent with a photo burst (the ad, an address) is a turn of its own, then the photos
// join whatever it opened. Unclaimed text is a caption: all of it goes to n8n's edit.
async function textThenPhotos(input, deps, draft) {
  // "תשנה את התמונות" bundled with the new photos: photos first, so the swap can ask about them.
  if (PC.isSwap(input.text) && draft && draft.status === "active") {
    const p = await handleTurn({ ...input, text: "", draft }, deps);
    const t = await handleTurn({ ...input, fileUrl: null, fileUrls: [], draft: p.draft || draft }, deps);
    return { ...t, status: `${p.status}+${t.status}`, replies: [...p.replies, ...t.replies] };
  }
  const t1 = await handleTurn({ ...input, fileUrl: null, fileUrls: [], draft }, deps);
  if (!t1.handled) return t1;
  const after = t1.del ? null : (t1.draft || draft);
  if (!after) return t1;
  const t2 = await handleTurn({ ...input, text: "", draft: after }, deps);
  if (!t2.handled) return t1;
  return { ...t2, status: `${t1.status}+${t2.status}`, replies: [...t1.replies, ...t2.replies], draft: t2.draft || after };
}

module.exports = { handleTurn, _test: { promptFor, answerField } };
