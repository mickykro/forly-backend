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

// Multiple photos when n8n's burst debounce bundles them into one webhook
// (input.fileUrls), else the ordinary single photo (input.fileUrl); null
// when the turn carries no photo at all.
function photoUrlsOf(input) {
  if (Array.isArray(input.fileUrls) && input.fileUrls.length) return input.fileUrls;
  return input.fileUrl ? [input.fileUrl] : null;
}

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
  for (const [k, v] of Object.entries(parsed.fields)) if (k in draft.fields && k !== "description" && v !== null) draft.fields[k] = v;
  // ponytail: description left for user to provide in Q&A, not auto-filled from source
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
    if (D.isRequired(field)) return { status: `required:${field}`, replies: [R.required(field)], draft };
    draft.skipped.push(field);
    const p = promptFor(draft);
    return { status: p.status, replies: p.replies, draft };
  }
  const value = D.parseAnswer(field, text);
  if (value === null) return { status: `invalid:${field}`, replies: [R.invalid(field)], draft };
  draft.fields[field] = value;
  const p = promptFor(draft);
  return { status: p.status, replies: p.replies, draft };
}

// A photo (or several, when n8n's burst debounce bundles them into one
// webhook) is stored silently; the route arms a timer and calls back with
// event:"photo_timer" so the agent gets one progress message per batch.
async function storePhoto(draft, fileUrlOrUrls, deps, now) {
  const raw = Array.isArray(fileUrlOrUrls) ? fileUrlOrUrls : [fileUrlOrUrls];
  const urls = [...new Set(raw)]; // a burst can list the same source url twice
  const hosted = await importAll(urls, deps.importPhoto);
  for (const h of hosted) { if (draft.photos.length < MAX_PHOTOS) draft.photos.push(h); }
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

/*
 * n8n just finished editing a photo → it may become a property page.
 * Business Handler2 edits photos one at a time (its burst output only warns),
 * so this arrives once per photo: pile them on a silent `offered` draft and ask
 * once, when the third lands. A batch path sending several at once still works.
 */
async function photosEdited(input, deps, draft, now) {
  const { phone } = input;
  const hosted = await importAll(input.photos || [], deps.importPhoto);
  if (draft && draft.status === "active" && !D.isPaused(draft, now)) {
    draft.photos = draft.photos.concat(hosted).slice(0, MAX_PHOTOS);
    const p = promptFor(draft);
    return { handled: true, status: p.status, draft: D.touch(draft, now), replies: [R.photosSaved(draft.photos.length), ...p.replies] };
  }
  if (draft && draft.status === "active") return resumePrompt(draft, { photos: hosted }, now);
  const target = draft && draft.status === "offered" ? draft : offeredDraft(phone, now);
  target.photos = target.photos.concat(hosted).slice(0, MAX_PHOTOS);
  D.touch(target, now);
  if (target.photos.length < D.MIN_PHOTOS || target.offer_sent) {
    return { handled: true, status: `offer_pending:${target.photos.length}`, draft: target, replies: [] };
  }
  target.offer_sent = true;
  return { handled: true, status: "offered", draft: target, replies: [R.offer(target.photos.length)] };
}

function offeredDraft(phone, now) {
  const d = D.newDraft(phone, "photos", now);
  d.status = "offered";
  return d;
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
      const fresh = offeredDraft(draft.phone, now);
      fresh.photos = o.photos;
      if (fresh.photos.length < D.MIN_PHOTOS) {
        return { handled: true, status: `offer_pending:${fresh.photos.length}`, draft: fresh, replies: [] };
      }
      fresh.offer_sent = true;
      return { handled: true, status: "offered", draft: fresh, replies: [R.offer(fresh.photos.length)] };
    }
    return openDraft(draft.phone, D.openerKind(o.text), o.text, deps, now);
  }
  return { handled: true, status: "resume_prompt", replies: [R.resumePrompt(D.summary(draft))] };
}

async function activeTurn(input, deps, draft, now) {
  if (input.event === "photo_timer") return photoTimer(draft);
  const photoUrls = photoUrlsOf(input);
  if (photoUrls) return storePhoto(draft, photoUrls, deps, now);
  const cmd = D.command(input.text);
  if (cmd === "cancel") return { handled: true, status: "cancelled", del: true, replies: [R.cancelled()] };
  const step = D.nextStep(draft);
  if (step.kind === "ask") {
    const r = answerField(draft, step.field, input.text, cmd);
    return { handled: true, ...r, draft: r.draft ? D.touch(r.draft, now) : undefined };
  }
  // All questions answered - photo collection / confirm mode
  const n = draft.photos.length;
  // "ממשיכים" with enough photos → show confirm
  if (cmd === "continue" && n >= D.MIN_PHOTOS) {
    return { handled: true, status: "confirm", replies: [R.confirm(D.summary(draft))] };
  }
  // "כן" with enough photos → build
  if (cmd === "yes" && n >= D.MIN_PHOTOS) return build(draft, deps, now);
  // "לא" with enough photos → cancel
  if (cmd === "no" && n >= D.MIN_PHOTOS) return { handled: true, status: "cancelled", del: true, replies: [R.cancelled()] };
  // Any other text → show photo progress (includes "continue"/"yes"/"no" with not enough photos)
  return { handled: true, status: `photos_progress:${n}`, replies: [R.photosProgress(n)] };
}

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
    if (input.event || photoUrlsOf(input)) return notOurs("not_ours");
    const kind = D.openerKind(input.text);
    if (!kind) return notOurs("not_ours");
    if (draft.status === "building") return openDraft(phone, kind, input.text, deps, now);
    return resumePrompt(draft, { text: input.text }, now);
  }
  return activeTurn(input, deps, draft, now);
}

module.exports = { handleTurn, _test: { promptFor, answerField } };
