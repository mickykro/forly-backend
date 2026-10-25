/*
 * posting-audit.js — what Facebook itself says became of the account's posts, per group (17 Oct 2026).
 *
 * Our own records only say "the Post button was clicked and no warning showed". The truth is on
 * Facebook: each group's "Your content" tabs (published, pending, declined, removed). One session,
 * read-only — it navigates and scrolls, never clicks or types — and the profile is loaded but not
 * saved back. A halting signal (checkpoint, block, login) stops it at once.
 *
 * The tab addresses and the post count are [Unverified] against Facebook's markup: every tab is
 * screenshot to <tmp>/forly-audit/ so a count can be checked by eye. A tab Facebook redirects away
 * from reads as null (not 0).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const driver = require("./driver-browser");
const { profileNameFor } = require("./profile-name");
const P = require("./posting-driver-proof");
const { SIGNAL_DISABLES, SIGNAL_PENALISES } = require("./posting-signals");

const TABS = { published: "my_posted_content", pending: "my_pending_content", declined: "my_declined_content", removed: "my_removed_content" };
const HALTING = new Set([...SIGNAL_DISABLES, ...SIGNAL_PENALISES, "login_required"]);
const SHOT_DIR = path.join(os.tmpdir(), "forly-audit");

// In the page: the posts the tab lists — top-level articles only (a comment is an article inside one).
// shortcut: Facebook's "Your content" cards are not always articles, so this undercounts; the sidebar counter (below) wins.
function countInPage() {
  if (/No posts to show|אין פוסטים להצגה/.test(document.body.innerText || "")) return 0;
  const root = document.querySelector('[role="feed"]') || document.querySelector('[role="main"]');
  if (!root) return -1;
  return Array.from(root.querySelectorAll('[role="article"]')).filter((a) => !a.parentElement.closest('[role="article"]')).length;
}
// Facebook's own counter under "Published" in the sidebar ("Published · 6 posts"), or null.
function publishedCounter(text) {
  // Facebook puts invisible direction marks and a dot between the label and the number (22 Oct: "16" was missed).
  const m = String(text || "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").match(/(?:Published|פורסמו|פורסם)\D{0,12}?(\d+)\s*(?:posts?|פוסטים|פוסט)/i);
  return m ? Number(m[1]) : null;
}

// Scrolls until the count stops growing (Facebook loads a tab in pages).
async function countTab(page) {
  let n = -2, prev;
  for (let i = 0; i < 8; i++) {
    prev = n;
    n = await page.evaluate(countInPage);
    if (n === prev) break;
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1500);
  }
  return n;
}

// groups: [{ group_id, name }] → [{ group_id, name, published, pending, declined, removed, signal?, error? }]
async function auditGroups({ phone, groups }, deps = {}) {
  const db = deps.db || require("./db");
  const conn = (await db.getConnection(phone)) || {};
  const withPage = deps.withPage || driver.withPage;
  const readSignal = deps.readSignal || P.readSignal;
  const out = [];
  await withPage(
    { duration: 900, note: "forly-audit:groups", profile: { name: profileNameFor("facebook", phone, conn), persist: false } },
    async (page) => {
      for (const g of groups) {
        const row = { group_id: g.group_id, name: g.name || null };
        out.push(row);
        for (const [tab, seg] of Object.entries(TABS)) {
          try {
            await page.goto(`https://www.facebook.com/groups/${encodeURIComponent(g.group_id)}/${seg}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
            await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
            const sig = await readSignal(page, "");
            if (HALTING.has(sig)) { row.signal = sig; return; } // Facebook is pushing back: stop reading
            if (!new URL(page.url()).pathname.includes(seg)) { row[tab] = null; continue; } // redirected: no such tab here
            const counter = tab === "published" ? publishedCounter(await page.evaluate(() => document.body.innerText)) : null;
            row[tab] = counter !== null ? counter : await countTab(page);
            if (deps.saveShots !== false) {
              await fs.promises.mkdir(SHOT_DIR, { recursive: true });
              await page.screenshot({ path: path.join(SHOT_DIR, `${g.group_id}-${tab}.jpg`), type: "jpeg", quality: 60 }).catch(() => {});
            }
          } catch (e) { row[tab] = null; row.error = (e && e.name) || "error"; }
        }
      }
    },
    Object.assign({}, deps, { phone, platform: "facebook", conn }),
  );
  return out;
}

module.exports = { auditGroups, TABS, SHOT_DIR, _test: { countInPage, countTab, publishedCounter } };
