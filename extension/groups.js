/*
 * groups.js — reads the groups THIS agent has joined, once, on request.
 *
 * Why this exists: knowing the real membership list means Forly can offer
 * only groups the agent actually belongs to, and can refuse to schedule a
 * post into a group they never joined — the single fastest way to get
 * reported as a spammer.
 *
 * Deliberate limits, because reading pages is the part of an extension that
 * carries real enforcement risk:
 *   • only the agent's OWN joined-groups page, never anyone else's;
 *   • only id, name and URL — never members, posts, or admins;
 *   • only when the agent presses the button, never on a schedule;
 *   • the page is opened and scrolled at human speed, then closed.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// Collect /groups/<id-or-slug> links from the agent's own group list.
function harvest() {
  const found = new Map();
  for (const a of document.querySelectorAll('a[href*="/groups/"]')) {
    let u;
    try { u = new URL(a.href, location.origin); } catch { continue; }
    const m = u.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
    if (!m) continue;
    const slug = m[1];
    if (["feed", "joins", "discover", "create", "search"].includes(slug)) continue;
    const name = (a.innerText || "").trim().split("\n")[0];
    if (!name || name.length > 90) continue;
    found.set(`https://www.facebook.com/groups/${slug}`, name);
  }
  return [...found.entries()].map(([url, name]) => ({ url, name }));
}

async function scan() {
  // Scroll the list the way a person reviewing their groups would, so the
  // lazy-loaded rows render.
  let last = 0;
  for (let i = 0; i < 12; i++) {
    window.scrollBy({ top: 700 + rand(0, 400), behavior: "smooth" });
    await sleep(rand(700, 1400));
    const count = harvest().length;
    if (count === last && i > 3) break;      // list stopped growing
    last = count;
  }
  return harvest();
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg && msg.forly === "scan-groups") {
    scan()
      .then((groups) => chrome.runtime.sendMessage({ forly: "groups", groups }))
      .catch(() => chrome.runtime.sendMessage({ forly: "groups", groups: [] }));
    reply({ ok: true });
  }
  return true;
});
