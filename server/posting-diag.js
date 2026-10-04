/*
 * posting-diag.js — what the page looked like, in facts, when a post attempt
 * failed: for the failure note on local/staging (posting-shots), next to the
 * screenshot. Where it was (host + path, title), how many of each element the
 * driver looks for it found (composer, editor, Join group, the video input,
 * the upload progress, Post…), the names it read (header identity, group,
 * composer target and author) and any dialog/alert text — each checked
 * against what was expected where one is known.
 *
 * `markup` is what the next calibration needs when a selector read nothing:
 * the <meta> keys in <head> (content only for address keys — al:*, og:url,
 * og:type; a description can be post text, so only its length), the
 * canonical link, the short controls of the group header and the composer,
 * the banner's aria-labels, where the account's OWN name sits in the page,
 * and the id the address names. Never a post's text (nothing inside the
 * feed or an article is read, and a "button" longer than 40 characters is a
 * card, skipped), never another person's name, and every link as host+path
 * only (no query: no tokens).
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

// In the page (see the header for what is kept and why). own: the account's
// own name, or "". rootSel: the composer root.
function markupInPage({ own, rootSel }) {
  const clip = (v, n = 40) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const uniq = (a, n) => [...new Set(a.filter(Boolean))].slice(0, n);
  const addr = (href) => { try { const u = new URL(href, location.href); return clip(`${u.host}${u.pathname}`, 80); } catch { return null; } };
  const tag = (e) => `${e.tagName.toLowerCase()}${e.getAttribute("role") ? `[${e.getAttribute("role")}]` : ""}`;
  const all = (root, sel) => { try { return Array.from(root.querySelectorAll(sel)); } catch { return []; } };
  const outsideFeed = (e) => !e.closest('[role="feed"], [role="article"]');
  // a control's aria-label ("@…") or, without one, its text — only when short
  const control = (e) => { const a = clip(e.getAttribute("aria-label"), 41), t = clip(e.innerText, 41); return a ? (a.length <= 40 ? `@${a}` : null) : t.length <= 40 ? t : null; };
  const groupPath = (a) => { const p = addr(a.href); return p && /\/groups\/[^/]+(\/[a-z_]+)?\/?$/.test(p) ? p : null; };
  const meta = all(document, "meta[property], meta[name]").slice(0, 40).map((m) => {
    const k = clip(m.getAttribute("property") || m.getAttribute("name")), c = m.getAttribute("content") || "";
    return /^al:/.test(k) ? `${k}=${clip(c, 80)}` : /^og:(url|type)$/.test(k) ? `${k}=${k === "og:url" ? addr(c) : clip(c)}` : `${k} (${c.length})`;
  });
  const canonical = all(document, 'link[rel="canonical"]').map((l) => addr(l.href))[0] || null;
  const main = document.querySelector('div[role="main"]'), banner = document.querySelector('div[role="banner"]'), root = all(document, rootSel)[0];
  const where = (e) => { const r = e.closest('[role="banner"], [role="navigation"], [role="main"], [role="dialog"], [role="complementary"], [role="feed"]'); return r ? r.getAttribute("role") : "-"; };
  const chain = (e) => { const out = []; for (let n = e; n && n !== document.body && out.length < 5; n = n.parentElement) out.push(tag(n)); return `${where(e)}: ${out.reverse().join(">")}`; };
  let name_at = [], name_labels = [];
  if (own) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n && name_at.length < 40; n = w.nextNode()) if (n.data.trim() === own && n.parentElement) name_at.push(chain(n.parentElement));
    name_labels = all(document, "[aria-label]").filter((e) => e.getAttribute("aria-label").includes(own)).map((e) => `${where(e)}: ${tag(e)} @${clip(e.getAttribute("aria-label"), 60)}`);
  }
  return {
    meta, canonical,
    main_buttons: main ? uniq(all(main, '[role="button"]').filter(outsideFeed).map(control), 25) : null,
    main_group_links: main ? uniq(all(main, 'a[href*="/groups/"]').filter(outsideFeed).map(groupPath), 8) : null,
    banner_labels: banner ? uniq(all(banner, "[aria-label]").map((e) => `${tag(e)} @${clip(e.getAttribute("aria-label"))}`), 20) : null,
    user_json: all(document, 'script[type="application/json"]').filter((sc) => (sc.textContent || "").includes('"CurrentUserInitialData"')).length,
    name_at: uniq(name_at, 8), name_labels: uniq(name_labels, 6),
    composer: root ? {
      buttons: uniq(all(root, '[role="button"]').map(control), 20),
      headings: uniq(all(root, 'h1, h2, h3, [role="heading"]').map((e) => clip(e.innerText)), 5),
      strong: uniq(all(root, "strong").map((e) => clip(e.innerText)), 5),
      texts: uniq(all(root, "span, a, strong").filter((e) => !e.closest('[contenteditable="true"]')).map((e) => clip(e.textContent)).filter((t) => t && t.length <= 40), 25), // the dialog's own labels: who posts, where to
      group_links: uniq(all(root, 'a[href*="/groups/"]').map(groupPath), 5),
      editor_emoji_imgs: all(root, '[contenteditable="true"] img[alt]').length,
    } : null,
  };
}

// → { where, title, counts, read, expected, page_text, markup } — every field best-effort.
async function snapshot(page, x = {}) {
  if (!page) return null;
  const safe = (p) => Promise.resolve().then(p).catch(() => null);
  let where = null;
  try { const u = new URL(page.url()); where = `${u.host}${u.pathname}`; } catch { /* not loaded */ }
  const counts = {};
  for (const k of COUNTED) if (S[k]) counts[k] = await safe(() => P.countOf(page, S[k]));
  const read = {
    identity: clip(await safe(() => P.readIdentity(page))), // what the proof compares: the bootstrap name, else the banner
    header_identity: clip(await safe(() => P.textOf(page, S.identity))),
    group_name: clip(await safe(() => P.textOf(page, S.targetName))),
    composer_target: clip(await safe(() => P.textOf(page, S.composerTarget))),
    composer_author: clip(await safe(() => P.textOf(page, S.composerAuthor))),
    target_id: clip(await safe(() => P.readTargetId(page, (x.attempt && x.attempt.target_type) || "group"))),
    url_id: await safe(() => P.urlGroupId(page.url())),
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
  // The account's own name, to find where the page shows it: what was read, else a stored label that is a name.
  const own = read.identity || (P.isPersonName(expected.identity) ? expected.identity : "");
  const markup = await safe(() => page.evaluate(markupInPage, { own, rootSel: S.composerRoot }));
  return { where, title: clip(await safe(() => page.title())), counts, read, expected, page_text, markup: markup && Array.isArray(markup.meta) ? markup : null };
}

// What the post (Firestore, the agent's card) keeps: names, never page text.
const CHECK_RE = /^[a-z_]{1,40}$/;
function safeDetail({ check, step } = {}) {
  const out = {};
  if (typeof check === "string" && CHECK_RE.test(check)) out.error_check = check;
  if (typeof step === "string" && CHECK_RE.test(step)) out.failed_step = step;
  return out;
}

module.exports = { snapshot, safeDetail, clip, COUNTED, markupInPage };
