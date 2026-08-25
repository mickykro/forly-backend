/*
 * background.js — the extension's brain (MV3 service worker).
 *
 * It never decides pacing itself: it asks Forly for the next allowed group,
 * and Forly answers with a task or an honest "wait, here's why". That keeps
 * the safety rules on the server where a tampered client can't skip them.
 *
 * One tab, one group, one at a time. Nothing runs unless the agent pressed
 * Start, and the queue stops the moment anything looks wrong.
 */

const API = {
  base: null,               // set at pairing time from the Forly page
  async call(path, opts = {}) {
    const { base, token } = await store();
    const r = await fetch(`${base}${path}`, {
      ...opts,
      headers: { "content-type": "application/json", "x-forly-ext": token, ...(opts.headers || {}) },
    });
    if (!r.ok) throw Object.assign(new Error(`api ${r.status}`), { status: r.status });
    return r.json();
  },
};

const store = () => chrome.storage.local.get(["base", "token", "session", "running", "mode"]);
const setStore = (patch) => chrome.storage.local.set(patch);

async function log(line) {
  const { logs = [] } = await chrome.storage.local.get("logs");
  logs.unshift({ at: new Date().toISOString(), line });
  await chrome.storage.local.set({ logs: logs.slice(0, 40) });
}

// ── the loop ──────────────────────────────────────────────────────────────
// A single step: ask for a task, run it in a tab, report the outcome, then
// schedule the NEXT step at the server-chosen (randomized) gap.
async function step() {
  const { running, session } = await store();
  if (!running || !session) return;

  let next;
  try {
    next = await API.call(`/api/distribution/extension/next?s=${encodeURIComponent(session)}`);
  } catch (e) {
    await log(e.status === 401 ? "החיבור ל-Forly פג — יש לחבר מחדש" : "שגיאת רשת, ננסה שוב");
    return schedule(5 * 60 * 1000);
  }

  if (next.done) {
    await setStore({ running: false });
    await log("סיימנו את כל הקבוצות ✅");
    return;
  }
  if (next.wait) {
    const msg = {
      locked: "הפרסום הושהה ל-24 שעות לאחר חסימה — זו הגנה על החשבון",
      quiet_hours: "מחוץ לשעות הפרסום (09:00–21:00) — נמשיך מחר",
      daily_cap: `הגענו למכסה היומית (${next.wait.cap}) — נמשיך מחר`,
      too_soon: "ממתינים בין פוסטים כדי להיראות טבעי",
      needs_group_sync: "צריך לסנכרן את הקבוצות שלכם — לחצו «סנכרון הקבוצות שלי»",
    }[next.wait.reason] || "ממתינים";
    await log(msg);
    // Nothing will change until the agent syncs, so stop instead of polling.
    if (next.wait.reason === "needs_group_sync") {
      await setStore({ running: false });
      return;
    }
    const retry = next.wait.retry_at ? new Date(next.wait.retry_at).getTime() - Date.now() : 30 * 60 * 1000;
    return schedule(Math.max(60 * 1000, Math.min(retry + 5000, 6 * 60 * 60 * 1000)));
  }

  await runTask(next.task, next.mode || "assist", next.gap_ms);
}

function schedule(ms) {
  chrome.alarms.create("forly-step", { when: Date.now() + Math.max(60 * 1000, ms) });
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === "forly-step") step(); });

// Open the group, hand the content script the text, wait for the outcome.
async function runTask(task, mode, gapMs) {
  await log(`פותח קבוצה: ${task.group_url.split("/groups/")[1]}`);
  const tab = await chrome.tabs.create({ url: task.group_url, active: true });

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => finish({ status: "failed", detail: "timeout" }), 5 * 60 * 1000);
    function onMsg(msg, sender) {
      if (!msg || msg.forly !== "result" || sender.tab?.id !== tab.id) return;
      finish(msg);
    }
    function finish(result) {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onMsg);
      resolve(result);
    }
    chrome.runtime.onMessage.addListener(onMsg);
    // The content script may still be booting; retry the handoff briefly.
    let tries = 0;
    const send = () => {
      chrome.tabs.sendMessage(tab.id, { forly: "task", task, mode }, () => {
        if (chrome.runtime.lastError && tries++ < 10) setTimeout(send, 700);
      });
    };
    setTimeout(send, 1500);
  });

  try {
    const r = await API.call("/api/distribution/extension/result", {
      method: "POST",
      body: JSON.stringify({
        session_id: task.session_id, group_key: task.group_key,
        status: outcome.status, detail: outcome.detail || null,
      }),
    });
    await log(outcome.status === "posted" ? "פורסם ✓"
      : outcome.status === "blocked" ? "זוהתה חסימה — עוצרים" : "דולג");
    if (outcome.status === "blocked") { await setStore({ running: false }); return; }
    return schedule(r.gap_ms || gapMs || 5 * 60 * 1000);
  } catch {
    await log("לא הצלחנו לדווח ל-Forly — ננסה שוב");
    return schedule(5 * 60 * 1000);
  }
}

// ── one-shot read of the agent's own joined groups ────────────────────────
// Opens their group list, lets groups.js collect id/name/url, uploads it, and
// closes the tab. Only on request — never on a timer.
async function syncGroups() {
  const tab = await chrome.tabs.create({
    url: "https://www.facebook.com/groups/joins/", active: false });
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // A genuine full scan can take several minutes on a long lazy-loaded list.
    const timer = setTimeout(() => done({ groups: [], complete: false, timed_out: true }), 4 * 60 * 1000);
    let tries = 0;
    const send = () => chrome.tabs.sendMessage(tab.id, { forly: "scan-groups" }, (response) => {
      if (chrome.runtime.lastError) {
        if (tries++ < 12) return setTimeout(send, 800);
        return done({ groups: [], complete: false, scanner_unavailable: true });
      }
      return done(response && response.ok ? response : { groups: [], complete: false, scan_failed: true });
    });
    setTimeout(send, 2500);
  });
  try { await chrome.tabs.remove(tab.id); } catch { /* already closed */ }
  const groups = Array.isArray(result.groups) ? result.groups : [];
  if (!groups.length) {
    await log(result.timed_out ? "סריקת הקבוצות ארכה יותר מדי זמן" : "לא נמצאו קבוצות — ודאו שאתם מחוברים לפייסבוק");
    return 0;
  }
  await API.call("/api/distribution/extension/groups", {
    method: "POST", body: JSON.stringify({
      groups,
      sync: { complete: result.complete === true, capped: result.capped === true, scrolls: result.scrolls || null },
    }),
  });
  await log(`סונכרנו ${groups.length} קבוצות שאתם חברים בהן${result.complete ? " ✓" : " (סריקה חלקית)"}`);
  return groups.length;
}

// ── messages from the popup and from the Forly web page ───────────────────
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.forly === "sync-groups") {
      const n = await syncGroups().catch(() => 0);
      reply({ ok: true, count: n });
    } else if (msg.forly === "pair") {
      await setStore({ base: msg.base, token: msg.token, mode: msg.mode || "assist" });
      await log("התוסף חובר לחשבון ✓");
      reply({ ok: true });
    } else if (msg.forly === "start") {
      await setStore({ session: msg.session, running: true });
      await log("מתחילים");
      step();
      reply({ ok: true });
    } else if (msg.forly === "stop") {
      await setStore({ running: false });
      chrome.alarms.clear("forly-step");
      await log("נעצר על ידכם");
      reply({ ok: true });
    } else if (msg.forly === "state") {
      const s = await store();
      const { logs = [] } = await chrome.storage.local.get("logs");
      reply({ ...s, logs });
    }
  })();
  return true;   // async reply
});

// The Forly dashboard hands over the pairing token without any copy/paste.
chrome.runtime.onMessageExternal.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg && msg.forly === "pair" && msg.token && msg.base) {
      await setStore({ base: msg.base, token: msg.token, mode: msg.mode || "assist" });
      await log("התוסף חובר לחשבון ✓");
      reply({ ok: true });
    } else reply({ ok: false });
  })();
  return true;
});
