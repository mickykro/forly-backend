/*
 * posting-diag.js — what the page looked like, in facts, when a post attempt
 * failed: for the failure note on local/staging (posting-shots), next to the
 * screenshot. Where it was (host + path, title), how many of each element the
 * driver looks for it found (composer, editor, Join group, the video input,
 * the upload progress, Post…), the names it read (header identity, group,
 * composer target and author) and any dialog/alert text — each checked
 * against what was expected where one is known.
 *
 * Page text can name other people: this goes to the note on disk only
 * (local/staging, 3 days), never to Firestore. What the post itself keeps is
 * safeDetail(): the check's name and the step, no page text.
 * Best-effort: any read that fails is null; snapshot() never throws.
 */
const P = require("./posting-driver-proof");
const S = P.SELECTORS;

const MAX_TEXT = 160;
const clip = (s) => (typeof s === "string" ? (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s) : s == null ? null : String(s).slice(0, MAX_TEXT));
const COUNTED = ["composer", "editor", "composerRoot", "joinGroup", "mediaInput", "mediaButton", "mediaDrop", "mediaAttached", "mediaProgress", "submit", "dialog", "alert", "captchaFrame"];

// → { where, title, counts, read, expected, page_text } — every field best-effort.
async function snapshot(page, x = {}) {
  if (!page) return null;
  const safe = (p) => Promise.resolve().then(p).catch(() => null);
  let where = null;
  try { const u = new URL(page.url()); where = `${u.host}${u.pathname}`; } catch { /* not loaded */ }
  const counts = {};
  for (const k of COUNTED) if (S[k]) counts[k] = await safe(() => P.countOf(page, S[k]));
  const read = {
    header_identity: clip(await safe(() => P.textOf(page, S.identity))),
    group_name: clip(await safe(() => P.textOf(page, S.targetName))),
    composer_target: clip(await safe(() => P.textOf(page, S.composerTarget))),
    composer_author: clip(await safe(() => P.textOf(page, S.composerAuthor))),
    target_id: clip(await safe(() => P.readTargetId(page, (x.attempt && x.attempt.target_type) || "group"))),
    editor_chars: await safe(async () => { const t = await P.textOf(page, S.editor); return typeof t === "string" ? t.length : null; }),
  };
  const conn = x.conn || {};
  const expected = {
    identity: clip(P.norm(conn.facebook_identity_label) || null),
    target_id: clip((x.want && x.want.id) || (x.attempt && x.attempt.target_id) || null),
    group_name: clip((x.want && x.want.name) || null),
    copy_chars: typeof x.copy === "string" ? P.norm(x.copy).length : null,
  };
  const texts = [];
  for (const sel of [S.dialog, S.alert]) { const r = await safe(() => P.regionTexts(page, sel)); if (Array.isArray(r)) texts.push(...r); }
  const page_text = texts.map((t) => clip(P.norm(t))).filter(Boolean).slice(0, 5);
  return { where, title: clip(await safe(() => page.title())), counts, read, expected, page_text };
}

// What the post (Firestore, the agent's card) keeps: names, never page text.
const CHECK_RE = /^[a-z_]{1,40}$/;
function safeDetail({ check, step } = {}) {
  const out = {};
  if (typeof check === "string" && CHECK_RE.test(check)) out.error_check = check;
  if (typeof step === "string" && CHECK_RE.test(step)) out.failed_step = step;
  return out;
}

module.exports = { snapshot, safeDetail, clip, COUNTED };
