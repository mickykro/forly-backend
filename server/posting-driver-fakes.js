/* Shared fixtures for posting-driver.test.js and posting-driver-reconcile.test.js:
   a fake page that matches on the EXPORTED selectors, and a harness shaped
   like posting-tick's postDeps. Not a test itself. No network, no Driver. */
process.env.FORLY_ENV = "local";
process.env.PROFILE_KEY = "test-profile-key";
const { sha } = require("./posting-campaign");
const PD = require("./posting-driver");
const S = PD.SELECTORS;

const PHONE = "972501234567";
const NAME = "Dana Cohen";
const GROUP_NAME = "דירות להשכרה בחיפה";
const PAGE_NAME = "Dana Nadlan";
const COPY = "🏠 דירה בחיפה 4 חדרים\nמרפסת שמש, קומה 3, חניה פרטית ומחסן";
const LINK = `https://f.ly/p/pg1?c=${"a".repeat(32)}`;
const GROUP_URL = "https://www.facebook.com/groups/111";
const PERMA = "https://www.facebook.com/groups/111/posts/999/";
const PAGE_URL = "https://www.facebook.com/dana.nadlan";
const PAGE_PERMA = "https://www.facebook.com/dana.nadlan/posts/77/";

const connOf = (o) => Object.assign({ facebook_identity_label: NAME, facebook_profile_gen: 0, facebook_groups_member: [{ group_id: "111", name: GROUP_NAME }] }, o);
const attemptOf = (o) => Object.assign({
  key: "0123456789abcdef0123456789abcdef", phone: PHONE, page_id: "pg1", campaign_id: "c1", post_id: "p1",
  target_type: "group", target_id: "111", target_url: GROUP_URL, publisher: "browser", copy_hash: sha(COPY), confirm_membership: false, click_id: "a".repeat(32),
}, o);
const argsOf = (o) => Object.assign({ attempt: attemptOf(), copy: COPY, comment: LINK, dryRun: false, campaignId: "c1", phone: PHONE, groupUrl: GROUP_URL }, o);
const nameOf = (sel) => Object.keys(S).find((k) => S[k] === sel) || "other";
const denied = (reason) => Object.assign(new Error("posting not allowed"), { code: "posting_disabled", reason });

function fakePage(o = {}) {
  const ev = o.ev || [];
  const st = { url: "about:blank", submitted: false, editor: "", typed: [], clicks: [], visited: [], pressed: [] };
  const v = (x) => (typeof x === "function" ? x(st) : x);
  const texts = Object.assign({
    [S.identity]: NAME, [S.targetName]: GROUP_NAME, [S.composerTarget]: GROUP_NAME, [S.composerAuthor]: NAME,
    [S.editor]: (s) => s.editor, [S.postMessage]: COPY, [S.postAuthor]: NAME, [S.dialog]: "", [S.alert]: "",
  }, o.texts);
  const counts = Object.assign({ [S.composer]: 1, [S.editor]: 1, [S.composerRoot]: 1, [S.joinGroup]: 0, [S.commentBox]: 1, [S.discard]: 1, [S.captchaFrame]: 0 }, o.counts);
  const attrs = Object.assign({ [S.targetIdMeta]: "fb://group/111", [S.targetUrlMeta]: "" }, o.attrs);
  const feed = o.feed !== undefined ? o.feed : (s) => (s.submitted ? [{ href: `${PERMA}?__cft__=x`, author: NAME, text: COPY }] : []);
  const node = (sel) => {
    const n = {
      count: async () => v(counts[sel]) || 0,
      click: async () => { st.clicks.push(sel); ev.push(`click:${nameOf(sel)}`); if (sel === S.submit) st.submitted = true; },
      waitFor: async () => { if (!(v(counts[sel]) > 0)) throw new Error("timeout"); },
      // Typing goes THROUGH a locator (M8): the editor's text is what reached the editor.
      evaluate: async () => (o.focusLost ? !o.focusLost(st) : true), // ensureFocus
      pressSequentially: async (t) => { st.typed.push(t); ev.push(`type:${nameOf(sel)}`); if (sel === S.editor && !st.submitted) st.editor += t; },
      innerText: async () => String(v(texts[sel]) ?? ""),
      getAttribute: async () => v(attrs[sel]) ?? null,
      setInputFiles: async (f) => { st.files = (st.files || []).concat([f]); ev.push(`files:${nameOf(sel)}`); },
    };
    n.first = () => n; n.nth = () => n;
    return n;
  };
  return {
    st, ev,
    goto: async (u) => { st.visited.push(u); ev.push("goto"); st.url = (o.redirect && o.redirect(u)) || u; },
    url: () => st.url,
    goBack: async () => { st.url = "https://www.facebook.com/"; },
    locator: node,
    innerText: async () => "",
    keyboard: { type: async (t) => { st.keyboardTyped = (st.keyboardTyped || 0) + 1; }, press: async (k) => { st.pressed.push(k); } },
    mouse: { wheel: async () => {}, move: async () => {} },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    $$eval: async (sel) => (sel === S.feedPost ? v(feed) : []),
    // The driver's one in-page read (readInPage): the dialog/alert regions'
    // texts and the captcha-frame count. A region is { text (its chrome),
    // editable (the text inside its [contenteditable], never read) }; the
    // real walk is covered in Chromium (posting-driver-dom.test.js).
    evaluate: async (fn, arg) => {
      const { sels, cap, countSel } = arg || {};
      const regionsOf = (sel) => {
        if (sel !== S.dialog && sel !== S.alert) return [];
        const rs = (o.regions && o.regions[sel] !== undefined ? v(o.regions[sel]) : [{ text: v(texts[sel]) }]).filter((r) => r && (r.text || r.editable));
        return rs.map((r) => String(r.text || "").replace(/\s+/g, " ").trim().slice(0, cap));
      };
      return { regions: (sels || []).map(regionsOf), count: countSel ? v(counts[countSel]) || 0 : 0 };
    },
  };
}

// posting-tick's postDeps shape: attempts.transition(k, state, detail), guard(action), lockHeld, phone, platform, conn.
function harness(o = {}) {
  const ev = [];
  const page = fakePage(Object.assign({ ev }, o.page));
  const transitions = [], opened = [], guardCalls = {}, annotations = [];
  const deps = {
    attempts: {
      transition: async (k, to, d) => {
        ev.push(`t:${to}`);
        transitions.push({ k, to, d, submitClicks: page.st.clicks.filter((s) => s === S.submit).length });
        if (o.illegalAt === to) throw Object.assign(new Error("x"), { code: "illegal_transition" });
        return { key: k, state: to };
      },
      annotate: async (k, d) => { ev.push("annotate"); annotations.push(d); return {}; },
    },
    guard: async (action) => {
      guardCalls[action] = (guardCalls[action] || 0) + 1;
      ev.push(`g:${action}`);
      if (o.deny && o.deny(action, guardCalls[action])) throw denied("test");
      return true;
    },
    lockHeld: true, phone: PHONE, platform: "facebook", conn: connOf(o.conn),
    withPage: async (opts, fn, pd) => { opened.push({ opts, pd }); ev.push("open"); try { return await fn(page, { sessionId: "s" }); } finally { ev.push("close"); } },
    socialDwell: o.socialDwell || (async () => []),
    typingDelay: () => 0, rand: () => 0.5,
  };
  return { ev, page, transitions, opened, annotations, deps, states: () => transitions.map((t) => t.to), submits: () => page.st.clicks.filter((s) => s === S.submit).length };
}

module.exports = {
  PHONE, NAME, GROUP_NAME, PAGE_NAME, COPY, LINK, GROUP_URL, PERMA, PAGE_URL, PAGE_PERMA,
  connOf, attemptOf, argsOf, fakePage, harness, denied,
};
