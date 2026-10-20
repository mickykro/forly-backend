/*
 * posting-manual-prep.js — the semi-automatic manual tab: one target made
 * ready in the admin's live browser, and, when the admin moves on, a look at
 * whether it went up.
 *
 * prepare() opens the group (or the agent's Page), checks membership, opens
 * the composer, attaches the property's video, types the text, waits for the
 * upload and runs the R3 proof (posting-driver-proof) — then STOPS. A proof
 * that does not pass is a warning on the ready post (warn, check), not a stop:
 * the admin is looking at the page and clicks Post themselves. It never
 * clicks Post: the admin does, in Facebook. The driver's own drive() is left
 * alone (its attempt states and its one Post click are its rules); this reuses
 * its selectors and helpers only.
 *
 * check() only looks: composer still holding our text → not posted; a post of
 * the complete copy in the feed that was not there before prepare() typed it
 * (seenBefore), or a new "pending approval" banner → posted; else unsure (the
 * admin is asked). A cut feed text ("… See more") never proves a post: an
 * older post of the same property starts the same way.
 *
 * Nothing is logged: no phone, URL, name or post text.
 */
const P = require("./posting-driver-proof");
const media = require("./posting-media");
const { sha } = require("./posting-campaign");
const S = P.SELECTORS;

const LOAD_MS = 45000;
// Anything the page says other than ok / pending: stop and show it (unreadable too — fail closed).
const FINE = new Set(["ok", "pending_approval"]);
const cancelled = () => Object.assign(new Error("cancelled"), { code: "cancelled" });

// The attempt-shaped target the R3 proof checks: a group by its id, the Page by its numeric id.
function targetOf(item) {
  const page = item.kind === "page";
  return { target_type: page ? "page" : "group", target_id: page ? String(item.group_id).replace(/^page:/, "") : String(item.group_id), target_url: item.group_url, copy_hash: sha(item.copy) };
}

/*
 * prepare(page, item, conn, { file, alive }) → { ok: true, pendingBefore,
 * seenBefore, warn?, check? } | { ok: false, code }. item: a queue item (group_id, group_url, kind, copy).
 * file: the video as posting-media.fetchVideo returns it (or null). alive():
 * false once the admin moved on — checked before every browser change, nothing after it.
 */
async function prepare(page, item, conn, { file = null, alive = () => true } = {}) {
  const step = () => { if (!alive()) throw cancelled(); };
  const x = { wait: (p, a) => p.waitForTimeout(a * 1000), diag: null };
  const no = (code) => ({ ok: false, code });
  try {
    await page.goto(item.group_url, { waitUntil: "domcontentloaded", timeout: LOAD_MS }).catch(() => {});
    step();
    await page.locator(`${S.composer}, ${S.joinGroup}`).first().waitFor({ timeout: LOAD_MS }).catch(() => {});
    step();
    const sig = await P.readSignal(page, item.copy);
    if (!FINE.has(sig)) return no(sig);
    const seenBefore = (await ownPosts(page, item, conn)).map((p) => p.permalink);
    const kind = item.kind === "page" ? "page" : "group";
    if (kind === "group" && (await P.countOf(page, S.joinGroup)) > 0) return no("not_member");
    const composer = page.locator(S.composer).first();
    if ((await composer.count().catch(() => 0)) === 0) return no("composer_not_found");
    step();
    await composer.click();
    const editor = page.locator(S.editor).first();
    if (!(await editor.waitFor({ timeout: LOAD_MS }).then(() => true, () => false))) return no("composer_not_found");
    if ((await P.countOf(page, S.composerRoot)) !== 1) return no("composer_not_found");
    step();
    if (file) { const bad = await media.attach(page, x, file); if (bad) return no(bad); step(); }
    await editor.click();
    const lines = String(item.copy).replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      step();
      if (i > 0) await page.keyboard.press("Enter");
      if (lines[i]) await page.keyboard.insertText(lines[i]);
    }
    step();
    if (file) { const bad = await media.waitUploaded(page, x); if (bad) return no(bad); step(); }
    const resolved = kind === "group" ? await P.readTargetId(page, "group") : null;
    const proof = await P.proveIdentityAndDestination(page, targetOf(item), conn, { copy: item.copy, resolvedGroupId: resolved });
    const out = { ok: true, pendingBefore: sig === "pending_approval", seenBefore };
    return proof.ok ? out : Object.assign(out, { warn: proof.code, check: proof.check || null });
  } catch (e) {
    if (e && e.code === "cancelled") return no("cancelled");
    return no("prep_error");
  }
}

// Every feed post by us under the target whose text is the copy or a cut of it: [{ permalink, exact }].
async function ownPosts(page, item, conn) {
  const t = targetOf(item);
  const ids = [t.target_id, P.urlSegment(item.group_url, t.target_type)].filter(Boolean);
  const author = t.target_type === "group" ? P.norm(conn && conn.facebook_identity_label) : P.norm(await P.textOf(page, S.targetName));
  return (await P.readFeedPosts(page)).map((p) => P.findOwnPost([p], { kind: t.target_type, ids, author, copy: item.copy })).filter(Boolean);
}

// → "posted" | "not_posted" | "unsure". Only looks; never clicks. seenBefore:
// prepare()'s permalinks; without it (a failed preparation) the feed proves nothing.
async function check(page, item, conn, { pendingBefore = false, seenBefore = null } = {}) {
  try {
    if ((await P.countOf(page, S.composerRoot)) > 0 && P.norm(await P.textOf(page, S.editor))) return "not_posted";
    if (Array.isArray(seenBefore) && (await ownPosts(page, item, conn)).some((p) => p.exact && !seenBefore.includes(p.permalink))) return "posted";
    if (!pendingBefore && (await P.readSignal(page, item.copy)) === "pending_approval") return "posted";
  } catch (e) { /* a failed read proves nothing */ }
  return "unsure";
}

module.exports = { prepare, check, targetOf };
