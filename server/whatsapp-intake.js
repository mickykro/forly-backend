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

const MAX_PHOTOS = 12;

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
  if (step.kind === "photos") return { status: "photos", replies: [R.askPhotos()] };
  if (step.kind === "choose") return { status: "choose", replies: [R.choose()] };
  if (step.kind === "create") return { status: "create", replies: [] }; // handleTurn builds it
  return { status: "confirm", replies: [R.reviewReady(deps.reviewLink(draft.phone), draft.skipped)] };
}

// Several replies as one WhatsApp bubble; the last one's buttons are kept.
function oneBubble(replies) {
  const last = replies[replies.length - 1];
  return { text: replies.map((r) => r.text).join("\n\n"), ...(last && last.buttons ? { buttons: last.buttons } : {}) };
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
  // ponytail: description left for user to provide in Q&A, not auto-filled from source
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

async function openDraft(phone, kind, text, deps, now) {
  return kind === "keyword" ? openFromKeyword(phone, deps, now) : openFromSource(phone, kind, text, deps, now);
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
  const room = Math.max(0, MAX_PHOTOS - draft.photos.length);
  if (urls.length > room) draft.photos_dropped = (draft.photos_dropped || 0) + urls.length - room;
  draft.photos.push(...(await importAll(urls.slice(0, room), deps.importPhoto)));
  return { handled: true, status: "photo_stored", draft: D.touch(draft, now), replies: [], armPhotoTimer: true };
}

// The agent's own video: re-hosted and used instead of a generated walkthrough.
async function storeVideo(draft, url, deps, now) {
  let hosted = null;
  try { hosted = await deps.importVideo(url); } catch (err) { console.warn("[whatsapp-intake] video import failed:", err.message); }
  if (!hosted) return { handled: true, status: "video_failed", replies: [R.videoFailed()] };
  draft.video_url = hosted;
  const p = promptFor(draft, deps);
  return { handled: true, status: "video_stored", draft: D.touch(draft, now), replies: [oneBubble([R.videoSaved(), ...p.replies])] };
}

// One bubble: the photo count and whatever comes next, so photos sent mid-questions
// never look ignored. Reports (and clears) photos dropped over the 12 cap.
function photoTimer(draft, deps, now) {
  const n = draft.photos.length;
  const dropped = draft.photos_dropped || 0;
  draft.photos_dropped = 0;
  const done = dropped ? { draft: D.touch(draft, now) } : {};
  if (D.nextStep(draft).kind === "photos") {
    const r = [R.photosProgress(n)];
    if (dropped) r.unshift(R.photosSaved(n, dropped));
    return { handled: true, status: `photos_progress:${n}`, ...done, replies: [oneBubble(r)] };
  }
  const p = promptFor(draft, deps);
  return { handled: true, status: p.status, ...done, replies: [oneBubble([R.photosSaved(n, dropped), ...p.replies])] };
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
  const p = promptFor(draft, deps);
  return { handled: true, status: p.status, draft: D.touch(draft, now), replies: p.replies };
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
    // Whatever the paused message was, "חדש" starts a new property from it (or empty).
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
  if (input.event === "photo_timer") return photoTimer(draft, deps, now);
  if (input.videoUrl) return storeVideo(draft, input.videoUrl, deps, now);
  const photoUrls = photoUrlsOf(input);
  if (photoUrls) return storePhoto(draft, photoUrls, deps, now);
  const cmd = D.command(input.text);
  if (cmd === "cancel") return { handled: true, status: "cancelled", del: true, replies: [R.cancelled()] };
  const slash = C.parseSlash(input.text);
  if (slash) return slashTurn(draft, slash, deps, now);
  // A replacement was proposed last turn: כן applies it, anything else keeps the old values.
  if (draft.pending_changes) {
    const changes = draft.pending_changes;
    draft.pending_changes = null;
    if (cmd === "yes" || cmd === "no") {
      if (cmd === "yes") C.apply(draft, changes);
      const p = promptFor(draft, deps);
      const first = cmd === "yes" ? R.updated(changes) : R.kept();
      return { handled: true, status: p.status, draft: D.touch(draft, now), replies: [oneBubble([first, ...withPriceCheck(draft, p.replies)])] };
    }
  }
  const step = D.nextStep(draft);
  if (!cmd && C.needsExtraction(step.field || null, input.text) && deps.extractAllowed(draft.phone)) {
    const r = await smartAnswer(draft, input.text, deps, now, step.field);
    if (r) return r;
  }
  if (step.kind === "ask") {
    const r = answerField(draft, step.field, input.text, cmd, deps);
    if (r.draft && (step.field === "price" || step.field === "deal")) r.replies = withPriceCheck(r.draft, r.replies);
    return { handled: true, ...r, draft: r.draft ? D.touch(r.draft, now) : undefined };
  }
  if (step.kind === "photos") {
    return { handled: true, status: `photos_progress:${draft.photos.length}`, replies: [R.photosProgress(draft.photos.length)] };
  }
  if (step.kind === "choose") {
    if (cmd !== "preview" && cmd !== "create") return { handled: true, status: "choose", replies: [R.choose()] };
    draft.mode = cmd;
    const p = promptFor(draft, deps);
    return { handled: true, status: p.status, draft: D.touch(draft, now), replies: p.replies };
  }
  // Preview was chosen: building happens on the review page, so any text —
  // "ליצור" included — (re)sends the link.
  if (cmd === "create") return { handled: true, status: "preview_only", replies: [R.previewOnly(deps.reviewLink(draft.phone))] };
  const p = promptFor(draft, deps);
  return { handled: true, status: p.status, replies: p.replies };
}

// The price warning goes in front of the next question when price and deal disagree.
function withPriceCheck(draft, replies) {
  return D.priceLooksOff(draft.fields) ? [R.priceOff(draft.fields), ...replies] : replies;
}

// "/מחיר 2.1 מיליון", "/p 2.1m", or "/" alone for the list.
function slashTurn(draft, slash, deps, now) {
  if (slash.list) return { handled: true, status: "field_list", replies: [R.fieldList(draft.fields)] };
  if (slash.unknown) return { handled: true, status: "field_unknown", replies: [R.unknownField(slash.unknown)] };
  if (!C.setField(draft, slash.field, slash.value)) {
    return { handled: true, status: `invalid:${slash.field}`, replies: [R.invalid(slash.field)] };
  }
  const p = promptFor(draft, deps);
  const replies = withPriceCheck(draft, [R.updated({ [slash.field]: draft.fields[slash.field] }), ...p.replies]);
  return { handled: true, status: `corrected:${slash.field}`, draft: D.touch(draft, now), replies: [oneBubble(replies)] };
}

// A reply that talks about other fields ("רגע, המחיר 2.1 מיליון", "חיפה, 3 חדרים, 1.9 מיליון"):
// extract it like listing text, fill empty fields, and ask before replacing any.
// null → nothing usable came out; the caller handles the text the ordinary way.
async function smartAnswer(draft, text, deps, now, asked) {
  // A bare place name means nothing to the extractor; "שכונה: הבורסה, …" does. Numeric
  // questions get no label: "חניות: רגע, המחיר…" makes it invent a parking count.
  const prompt = asked === "city" || asked === "neighborhood" ? `${R.LABELS[asked]}: ${text}` : text;
  let parsed;
  try { parsed = await deps.parseListing(prompt); } catch (err) { return null; }
  const { filled, proposed } = C.merge(draft, parsed.fields || {});
  if (!Object.keys(filled).length && !Object.keys(proposed).length) return null;
  const replies = Object.keys(filled).length ? [R.updated(filled)] : [];
  if (Object.keys(proposed).length) {
    draft.pending_changes = proposed;
    replies.push(R.confirmChanges(proposed, draft.fields));
    return { handled: true, status: "confirm_changes", draft: D.touch(draft, now), replies: [oneBubble(replies)] };
  }
  const p = promptFor(draft, deps);
  return { handled: true, status: p.status, draft: D.touch(draft, now), replies: [oneBubble(withPriceCheck(draft, [...replies, ...p.replies]))] };
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
  // "עזרה" is answered wherever the agent is, and changes nothing: an agent who
  // asks how this works while a draft is open was answered with the resume
  // prompt before, twice over, and had no way to tell that only three exact
  // words would get them out. A question must never cost someone their draft,
  // so this returns no draft and leaves updated_at alone — the pause clock keeps
  // running exactly as it was.
  if (D.command(input.text) === "help") {
    return { handled: true, status: "help", replies: [R.help(deps.guideUrl, !!draft)] };
  }

  const open = draft && (draft.status === "active" || draft.status === "offered");
  if (input.messageType === "documentMessage" && open) {
    // Whatever step the draft is at, the question it's waiting on comes right after.
    const pending = draft.status === "active" ? promptFor(draft, deps).replies : [];
    return { handled: true, status: "document", replies: [oneBubble([R.sendAsImage(), ...pending])] };
  }

  if (!draft) {
    const kind = D.openerKind(input.text);
    if (!kind) return withDrop(notOurs("not_ours"));
    return openDraft(phone, kind, input.text, deps, now);
  }
  if (draft.status === "offered") return offeredTurn(input, deps, draft, now);
  if (draft.status === "resume_prompt") return resumeTurn(input, deps, draft, now);
  if (draft.status === "building") {
    const kind = D.openerKind(input.text);
    if (input.event || photoUrlsOf(input) || !kind) return notOurs("not_ours");
    return openDraft(phone, kind, input.text, deps, now);
  }
  // Paused: any message brings the open draft back up (המשך / חדש / ביטול).
  if (D.isPaused(draft, now)) {
    if (input.event) return notOurs("not_ours");
    return resumePrompt(draft, { text: input.text || null, file_urls: photoUrlsOf(input) }, now);
  }
  // A new link or "נכס חדש" while a draft is open is a different property: ask
  // instead of ignoring it. (Pasted listing text stays an answer — it fills fields.)
  const opener = D.openerKind(input.text);
  if (draft.status === "active" && (opener === "link" || opener === "keyword")) return resumePrompt(draft, { text: input.text }, now);
  const t = await activeTurn(input, deps, draft, now);
  return t.status === "create" ? build(t.draft || draft, deps, now) : t;
}

module.exports = { handleTurn, _test: { promptFor, answerField } };
