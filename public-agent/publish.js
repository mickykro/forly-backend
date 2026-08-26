/*
 * publish.js — one property, one publishing workspace.
 *
 * Facebook Page posts use the supported backend publishing path. Group sharing
 * remains manual: Forly prepares copy and direct links, while the agent
 * chooses when and whether to publish within each Group.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  let S = qs.get("s") || "";
  let T = qs.get("t") || "";
  const P = qs.get("page") || "";
  let session = null;
  let pagePoll = null;

  const api = (path, opts) => fetch(path, { credentials: "include", ...opts })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || "error"), { code: j.error });
      return j;
    });

  let toastT = null;
  function toast(text) {
    const m = $("msg");
    m.textContent = text; m.style.display = "block";
    clearTimeout(toastT); toastT = setTimeout(() => { m.style.display = "none"; }, 3000);
  }

  function copy(text, okMsg) {
    const done = () => toast(okMsg || "הטקסט הועתק ✓");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch { toast("ההעתקה נכשלה — סמנו והעתיקו ידנית"); }
      document.body.removeChild(ta);
    }
  }

  function openConnectDialog() {
    const dialog = $("facebookConnectDialog");
    $("facebookConnectBtn").href = `/api/distribution/oauth/start?page_id=${encodeURIComponent(session.page_id)}`;
    if (dialog.showModal) dialog.showModal(); else location.href = $("facebookConnectBtn").href;
  }

  function setPagePublish({ text, label, disabled = false, postUrl = null, onClick = null }) {
    $("pagePublishText").textContent = text;
    const btn = $("pagePublishBtn");
    btn.textContent = label;
    btn.disabled = disabled;
    btn.onclick = onClick;
    const link = $("pagePostLink");
    link.classList.toggle("hidden", !postUrl);
    if (postUrl) link.href = postUrl;
  }

  async function publishPage(force) {
    const btn = $("pagePublishBtn");
    btn.disabled = true;
    setPagePublish({ text: "שולחים את הנכס לדף הפייסבוק…", label: "⏳ הפרסום בתהליך", disabled: true });
    try {
      await api("/api/distribution/publish", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ page_id: session.page_id, force: !!force }),
      });
      toast("הפרסום נשלח לדף הפייסבוק ✓");
      refreshPagePublish(0);
    } catch (err) {
      if (err.code === "already_published") {
        setPagePublish({
          text: "הנכס כבר פורסם בדף הפייסבוק.", label: "פרסום נוסף בדף", onClick: () => {
            if (confirm("הנכס כבר פורסם. ליצור פוסט נוסף בדף הפייסבוק?")) publishPage(true);
          },
        });
      } else if (err.code === "not_connected" || err.code === "needs_reconnect") {
        openConnectDialog();
      } else {
        setPagePublish({ text: "הפרסום בדף נכשל. נסו שוב בעוד רגע.", label: "ניסיון פרסום מחדש", onClick: () => publishPage(!!force) });
      }
    }
  }

  async function refreshPagePublish(tick = 0) {
    clearTimeout(pagePoll);
    try {
      const status = await api(`/api/distribution/status?page_id=${encodeURIComponent(session.page_id)}`);
      const conn = status.connection || {};
      const listing = status.listing || {};
      if (!status.entitled) {
        setPagePublish({ text: "פרסום אוטומטי בדף אינו פעיל בחשבון זה.", label: "פרסום בדף אינו זמין", disabled: true });
        return;
      }
      if (!conn.connected || conn.needs_reconnect) {
        setPagePublish({
          text: conn.needs_reconnect
            ? "חיבור הדף לפייסבוק דורש חידוש לפני פרסום."
            : "כדי לפרסם בדף העסקי, צריך לחבר את Facebook פעם אחת.",
          label: conn.needs_reconnect ? "חידוש חיבור Facebook" : "חיבור Facebook לפרסום",
          onClick: openConnectDialog,
        });
        return;
      }
      if (listing.in_flight) {
        setPagePublish({ text: "הנכס מתפרסם בדף הפייסבוק…", label: "⏳ הפרסום בתהליך", disabled: true });
        if (tick < 30) pagePoll = setTimeout(() => refreshPagePublish(tick + 1), 10000);
        return;
      }
      if (listing.posted) {
        setPagePublish({
          text: `הנכס פורסם בדף ${conn.page_name || "הפייסבוק"}.`,
          label: "פרסום נוסף בדף",
          postUrl: listing.post_url || session.post_url || null,
          onClick: () => { if (confirm("ליצור פוסט נוסף בדף הפייסבוק?")) publishPage(true); },
        });
        return;
      }
      setPagePublish({
        text: `מוכן לפרסום אוטומטי בדף ${conn.page_name || "הפייסבוק"}.`,
        label: "פרסום בדף הפייסבוק",
        onClick: () => publishPage(false),
      });
    } catch {
      setPagePublish({ text: "לא הצלחנו לבדוק את חיבור הדף כרגע.", label: "רענון מצב הפרסום", onClick: () => refreshPagePublish(0) });
    }
  }

  function mark(groupKey, action, reason) {
    return api("/api/distribution/share-session/mark", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ s: S, t: T, group: groupKey, action, reason }),
    }).then((r) => {
      const g = session.groups.find((x) => x.key === groupKey);
      if (g) g.state = r.state;
      render();
    }).catch(() => toast("העדכון נכשל — נסו שוב"));
  }

  const STATE_LABEL = { copied: "הועתק", opened: "נפתחה", posted: "פורסם ✓", skipped: "דולג" };

  function groupCard(g, index) {
    const card = document.createElement("div");
    card.className = "gcard" + (g.state === "posted" || g.state === "skipped" ? " done" : "");

    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;gap:8px;align-items:start";
    const nameWrap = document.createElement("div");
    const name = document.createElement("div");
    name.className = "gname";
    // The catalog name when we know it, the group slug otherwise.
    name.textContent = g.name ||
      decodeURIComponent(g.url.replace(/^https:\/\/www\.facebook\.com\/groups\//, ""));
    const meta = document.createElement("div");
    meta.className = "gmeta"; meta.textContent = `קבוצה ${index + 1}`;
    nameWrap.append(name, meta);
    head.appendChild(nameWrap);
    if (g.state !== "ready") {
      const tag = document.createElement("span");
      tag.className = "state-tag " + g.state;
      tag.textContent = STATE_LABEL[g.state] || g.state;
      head.appendChild(tag);
    }
    card.appendChild(head);

    const actions = document.createElement("div");
    actions.className = "gactions";

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn-ghost btn-sm";
    copyBtn.textContent = "העתקת הטקסט";
    copyBtn.onclick = () => { copy(g.copy, "הטקסט הועתק — עכשיו פותחים את הקבוצה"); mark(g.key, "copied"); };

    const openBtn = document.createElement("a");
    openBtn.className = "btn btn-gold btn-sm";
    openBtn.textContent = "פתיחת הקבוצה";
    openBtn.href = g.url; openBtn.target = "_blank"; openBtn.rel = "noopener";
    openBtn.onclick = () => mark(g.key, "opened");

    const postedBtn = document.createElement("button");
    postedBtn.className = "btn btn-ghost btn-sm";
    postedBtn.textContent = "✓ פרסמתי";
    postedBtn.onclick = () => mark(g.key, "posted");

    const skipBtn = document.createElement("button");
    skipBtn.className = "btn btn-ghost btn-sm";
    skipBtn.textContent = "דילוג";
    skipBtn.onclick = () => {
      const reason = prompt("סיבה (לא חובה): לדוגמה — הקבוצה לא מאפשרת מתווכים") || "";
      mark(g.key, "skipped", reason);
    };

    actions.append(copyBtn, openBtn, postedBtn, skipBtn);
    card.appendChild(actions);
    return card;
  }

  // ── inline group picker (shown when this property has no groups yet) ──
  const picked = new Set();

  function renderPicker() {
    const hasGroups = (session.groups || []).length > 0;
    $("pickCard").classList.toggle("hidden", hasGroups);
    if (hasGroups) return;

    const cat = session.catalog || [];
    const sug = session.suggestion;
    if (sug && sug.groups && sug.groups.length) {
      $("reuseBox").classList.remove("hidden");
      $("reuseText").textContent = sug.same_city
        ? `בנכס "${sug.title || "קודם"}" ב${sug.city} בחרתם ${sug.groups.length} קבוצות — ` +
          "לשייך את אותן הקבוצות גם לנכס הזה?"
        : `בבחירה האחרונה שלכם${sug.title ? ` (הנכס "${sug.title}")` : ""} ` +
          `היו ${sug.groups.length} קבוצות — לשייך אותן גם לנכס הזה?`;
      $("reuseBtn").textContent = sug.same_city
        ? `שיוך ${sug.groups.length} הקבוצות`
        : `שימוש בבחירה האחרונה (${sug.groups.length})`;
      $("reuseBtn").onclick = () => savePicked(sug.groups);
    } else {
      $("reuseBox").classList.add("hidden");
    }
    if (session.city) {
      $("pickHint").textContent =
        `כל נכס משויך לקבוצות משלו. הנכס הזה ב${session.city} — הקבוצות המקומיות מופיעות ראשונות.`;
    }

    const q = ($("pickFilter").value || "").trim().toLowerCase();
    const box = $("pickList");
    box.textContent = "";
    if (!cat.length) {
      const p = document.createElement("p");
      p.className = "sub"; p.textContent = "לא נמצאו קבוצות מומלצות.";
      box.appendChild(p); return;
    }
    // Same-city groups first, then the rest; mismatched listing types last.
    const rank = (g) => (g.city && session.city && g.city === session.city ? 0 : 1) +
      (g.match === false ? 2 : 0);
    const rows = cat
      .filter((g) => !q || (g.name + " " + (g.city || "")).toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || (b.members || 0) - (a.members || 0));
    // The city's own groups stay open; every other band folds into a native
    // <details> so a long catalog doesn't bury the list that matters. A
    // filter query opens them — you can't search inside a closed fold.
    const bandOf = (g) => rank(g) >= 2 ? "פחות מתאימות לנכס הזה"
      : rank(g) === 0 ? `בעיר ${session.city}` : "קבוצות נוספות";
    const groupRow = (g) => {
      const label = document.createElement("label");
      label.style.cssText = "display:flex;gap:8px;align-items:center;padding:4px 0;cursor:pointer;font-size:.9rem";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = picked.has(g.url);
      cb.style.accentColor = "var(--gold)";
      cb.onchange = () => { cb.checked ? picked.add(g.url) : picked.delete(g.url); };
      const span = document.createElement("span");
      span.textContent = g.name + (g.city ? ` · ${g.city}` : "") +
        (g.members ? ` · ~${Math.round(g.members / 1000)}K` : "");
      label.append(cb, span);
      return label;
    };
    const bands = new Map();
    for (const g of rows) {
      const b = bandOf(g);
      if (!bands.has(b)) bands.set(b, []);
      bands.get(b).push(g);
    }
    // With no local band (property has no city), the first fold opens —
    // otherwise the whole catalog would arrive collapsed.
    const hasLocal = [...bands.keys()].some((b) => b.startsWith("בעיר"));
    let first = true;
    for (const [band, list] of bands) {
      const open = band.startsWith("בעיר");
      const color = open ? "#157A3F"
        : band.startsWith("פחות") ? "var(--ink-soft)" : "var(--gold)";
      const head = `font-weight:700;font-size:.82rem;color:${color}`;
      let target = box;
      if (open) {
        const h = document.createElement("div");
        h.textContent = band;
        h.style.cssText = `${head};margin:8px 0 2px`;
        box.appendChild(h);
      } else {
        const d = document.createElement("details");
        d.open = !!q || (!hasLocal && first);
        first = false;
        d.style.cssText = "margin:8px 0 2px";
        const sm = document.createElement("summary");
        sm.style.cssText = `${head};cursor:pointer`;
        sm.textContent = `${band} (${list.length})`;
        d.appendChild(sm);
        box.appendChild(d);
        target = d;
      }
      for (const g of list) target.appendChild(groupRow(g));
    }
  }

  async function savePicked(groups) {
    const list = groups || [...picked];
    if (!list.length) { toast("בחרו לפחות קבוצה אחת"); return; }
    try {
      session = await api("/api/distribution/share-session/groups", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ s: S, t: T, groups: list }),
      });
      toast(`${session.groups.length} קבוצות שויכו לנכס ✓`);
      render();
    } catch { toast("השמירה נכשלה — נסו שוב"); }
  }

  function render() {
    renderPicker();
    const groups = session.groups || [];
    const done = groups.filter((g) => g.state === "posted" || g.state === "skipped").length;
    const posted = groups.filter((g) => g.state === "posted").length;
    $("bar").style.width = groups.length ? Math.round(done / groups.length * 100) + "%" : "0%";
    $("pcount").textContent = groups.length
      ? `${done} מתוך ${groups.length} קבוצות · ${posted} פורסמו`
      : "עדיין לא שויכו קבוצות לנכס הזה — בוחרים למטה 👇";

    const box = $("groups");
    box.textContent = "";
    // Unfinished first: the queue always shows the next thing to do on top.
    const order = [...groups].sort((a, b) => {
      const w = (g) => (g.state === "posted" || g.state === "skipped") ? 1 : 0;
      return w(a) - w(b);
    });
    order.forEach((g, i) => box.appendChild(groupCard(g, groups.indexOf(g))));
    $("allDone").classList.toggle("hidden", !(groups.length && done === groups.length));
  }

  (async () => {
    if (!S && !P) { $("loading").classList.add("hidden"); $("badlink").classList.remove("hidden"); return; }
    try {
      if (P) {
        session = await api("/api/distribution/share-session", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ page_id: P }),
        });
        S = session.id;
      } else {
        session = await api(`/api/distribution/share-session?s=${encodeURIComponent(S)}&t=${encodeURIComponent(T)}`);
      }
    } catch {
      $("loading").classList.add("hidden");
      $("badlink").classList.remove("hidden");
      return;
    }
    $("loading").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("title").textContent = session.title || "פרסום הנכס";
    if (session.post_url) {
      const a = document.createElement("a");
      a.href = session.post_url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "הפוסט בדף הפייסבוק ↗"; a.style.color = "var(--gold)";
      $("postLine").appendChild(a);
    } else {
      $("postLine").textContent = session.page_url;
    }
    $("copyText").value = session.copy;
    $("copyMain").onclick = () => copy(session.copy);
    $("pickFilter").oninput = renderPicker;
    $("savePick").onclick = () => savePicked();
    $("facebookConnectCancel").onclick = () => $("facebookConnectDialog").close();
    render();
    refreshPagePublish(0);
  })();
})();
