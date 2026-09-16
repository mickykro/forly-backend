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

async function activeTurn(input, deps, draft, now) {
  const cmd = D.command(input.text);
  if (cmd === "cancel") return { handled: true, status: "cancelled", del: true, replies: [R.cancelled()] };
  const step = D.nextStep(draft);
  if (step.kind === "ask") {
    const r = answerField(draft, step.field, input.text, cmd);
    return { handled: true, ...r, draft: r.draft ? D.touch(r.draft, now) : undefined };
  }
  // photos + confirm arrive in Task 6
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
  // offered / resume_prompt / paused / building arrive in Task 7
  return notOurs("not_ours");
}

// ponytail: temporary stub for routes/whatsapp.js until Task 8 rewrites the route
async function intake() { return { status: "not_ours", reply: null }; }

module.exports = { handleTurn, intake, _test: { promptFor, answerField } };
