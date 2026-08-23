/*
 * share.js — the group sharing queue (mobile-first, opened from WhatsApp).
 *
 * Forly automates the PREPARATION, never the Facebook action: per-group copy
 * with a tracked link, an open button, and states the agent confirms by hand.
 * Nothing here claims a group post that wasn't confirmed by the agent.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const S = qs.get("s") || "";
  const T = qs.get("t") || "";
  let session = null;

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
    // The catalog name isn't in the session payload — show the group slug,
    // which is what the agent recognises in Facebook's own UI.
    name.textContent = decodeURIComponent(g.url.replace(/^https:\/\/www\.facebook\.com\/groups\//, ""));
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

  function render() {
    const groups = session.groups || [];
    const done = groups.filter((g) => g.state === "posted" || g.state === "skipped").length;
    const posted = groups.filter((g) => g.state === "posted").length;
    $("bar").style.width = groups.length ? Math.round(done / groups.length * 100) + "%" : "0%";
    $("pcount").textContent = groups.length
      ? `${done} מתוך ${groups.length} קבוצות · ${posted} פורסמו`
      : "לא הוגדרו קבוצות — אפשר להוסיף בעמוד ההפצה";

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
    if (!S) { $("loading").classList.add("hidden"); $("badlink").classList.remove("hidden"); return; }
    try {
      session = await api(`/api/distribution/share-session?s=${encodeURIComponent(S)}&t=${encodeURIComponent(T)}`);
    } catch {
      $("loading").classList.add("hidden");
      $("badlink").classList.remove("hidden");
      return;
    }
    $("loading").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("title").textContent = session.title || "שיתוף הנכס";
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
    render();
  })();
})();
