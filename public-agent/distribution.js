/*
 * distribution.js — the הפצה dashboard page.
 *
 * Flow (product decision): ① connect Facebook → ② choose property/ies →
 * ③ choose groups → ④ publish. Steps 2–4 stay locked until connected.
 * All server data is written with textContent / value — never innerHTML.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = (path, opts) => fetch(path, { credentials: "include", ...opts })
    .then(async (r) => {
      if (r.status === 401) { location.href = "/"; throw new Error("unauthenticated"); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || "error"), { code: j.error, status: r.status });
      return j;
    });

  let toastT = null;
  function toast(text) {
    const m = $("msg");
    m.textContent = text; m.style.display = "block";
    clearTimeout(toastT); toastT = setTimeout(() => { m.style.display = "none"; }, 4500);
  }

  // ── state ──
  let st = null;                    // /status payload
  let props = [];                   // active properties
  const listingState = new Map();   // page_id → /status?page_id listing object
  const selectedProps = new Set();
  let catalog = [];
  let catalogType = "";             // listing type the catalog was matched for
  let selected = new Set();         // selected catalog group urls
  let pollT = null;

  // Which kind of listing the agent is about to share — drives group matching.
  function currentListingType() {
    const picked = props.filter((p) => selectedProps.has(p.page_id));
    const types = (picked.length ? picked : props).map((p) => p.listing_type || "sale");
    return types.includes("rent") && !types.includes("sale") ? "rent" : "sale";
  }

  const connected = () =>
    !!(st && st.connection.connected && !st.connection.needs_reconnect);

  // ── stepper ──
  function renderStepper() {
    const doneMap = {
      1: connected(),
      2: selectedProps.size > 0,
      3: [...selected, ...ownGroupLines()].length > 0,
      4: false,
    };
    let current = !doneMap[1] ? 1 : !doneMap[2] ? 2 : !doneMap[3] ? 3 : 4;
    for (const el of document.querySelectorAll(".step")) {
      const n = Number(el.dataset.step);
      el.classList.toggle("done", !!doneMap[n] && n !== current);
      el.classList.toggle("current", n === current);
    }
    const locked = !connected();
    for (const id of ["propsCard", "groupsCard", "publishCard"]) {
      $(id).classList.toggle("locked", locked);
    }
    const n = selectedProps.size;
    $("publishSummary").textContent = !connected()
      ? "קודם מתחברים לפייסבוק (שלב 1)."
      : n === 0 ? "בחרו לפחות נכס אחד (שלב 2)."
      : `${n} נכסים ייפורסמו לדף "${st.connection.page_name || ""}" + ערכת שיתוף לקבוצות.`.replace("1 נכסים ייפורסמו", "נכס אחד יפורסם");
    $("publishBtn").disabled = false; // guard handled on click, with guidance
  }

  // ── step 1: connection ──
  function renderConnection() {
    $("connectCard").hidden = false;
    const chip = $("connChip"), txt = $("connText"), btn = $("connectBtn");
    if (st.connection.needs_reconnect) {
      chip.textContent = "נדרש חיבור מחדש"; chip.className = "conn-chip warn";
      txt.textContent = "החיבור פג תוקף — הפרסום מושהה עד חיבור מחדש.";
      btn.textContent = "חיבור מחדש";
    } else if (st.connection.connected) {
      chip.textContent = "מחובר"; chip.className = "conn-chip ok";
      // Say plainly whether Instagram will be posted to — silence here reads
      // as "it's working" and the agent finds out only from the summary.
      txt.textContent = `מפרסמים לדף: ${st.connection.page_name || ""}` +
        (st.connection.instagram_linked
          ? " · אינסטגרם מקושר — יפורסם גם שם"
          : " · אינסטגרם לא מקושר (קשרו חשבון עסקי לדף בפייסבוק, ואז חברו מחדש כאן)");
      btn.textContent = "החלפת דף / חיבור מחדש";
    } else {
      chip.textContent = "לא מחובר"; chip.className = "conn-chip warn";
      txt.textContent = "חיבור חד-פעמי — ומהנכס הבא הפרסום בקליק אחד.";
    }
    btn.onclick = () => { location.href = "/api/distribution/oauth/start"; };
  }

  // ── step 2: properties ──
  function daysAgo(iso) {
    if (!iso) return "";
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return d <= 0 ? "פורסם היום" : d === 1 ? "פורסם אתמול" : `פורסם לפני ${d} ימים`;
  }

  function propRow(prop) {
    const pageId = prop.page_id;
    const row = document.createElement("div");
    row.className = "prop-row"; row.id = "prop-" + pageId;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.onchange = () => {
      if (cb.checked) selectedProps.add(pageId); else selectedProps.delete(pageId);
      renderStepper();
      syncCatalogType();
    };
    const img = document.createElement("img");
    img.loading = "lazy"; img.alt = "";
    if (prop.thumb_url) img.src = prop.thumb_url;
    const t = document.createElement("div"); t.className = "t";
    const name = document.createElement("div"); name.className = "name";
    name.textContent = prop.title || pageId;
    const sub = document.createElement("div"); sub.className = "sub";
    sub.textContent = prop.address || "";
    t.append(name, sub);
    const chip = document.createElement("span"); chip.className = "chip";
    chip.textContent = "…";
    const kitBtn = document.createElement("button");
    kitBtn.className = "btn btn-ghost btn-sm"; kitBtn.textContent = "שיתוף לקבוצות";
    kitBtn.onclick = () => openKit(pageId);
    row.append(cb, img, t, chip, kitBtn);
    row._els = { cb, chip, sub, t };
    return row;
  }

  function applyListingState(row, prop, L) {
    const { cb, chip, sub, t } = row._els;
    if (L.posted) {
      chip.textContent = "פורסם"; chip.className = "chip active";
      const when = daysAgo(L.posted_at);
      if (when) sub.textContent = [prop.address, when].filter(Boolean).join(" · ");
      let a = t.querySelector("a");
      if (!a && L.post_url) {
        a = document.createElement("a");
        a.target = "_blank"; a.rel = "noopener"; a.textContent = "לפוסט";
        t.appendChild(a);
      }
      if (a && L.post_url) a.href = L.post_url;
    } else if (L.in_flight) {
      chip.textContent = "בתהליך"; chip.className = "chip building";
      cb.checked = false; cb.disabled = true;
      selectedProps.delete(prop.page_id);
    } else if (L.last_status === "failed") {
      chip.textContent = "נכשל"; chip.className = "chip expired";
    } else {
      chip.textContent = "טרם פורסם"; chip.className = "chip";
    }
    if (!L.in_flight) cb.disabled = false;
  }

  async function refreshListing(prop, row) {
    try {
      const r = await api(`/api/distribution/status?page_id=${encodeURIComponent(prop.page_id)}`);
      listingState.set(prop.page_id, r.listing || {});
      applyListingState(row, prop, r.listing || {});
    } catch { row._els.chip.textContent = "—"; }
  }

  async function loadProps() {
    const r = await api("/api/properties").catch(() => null);
    props = ((r && r.properties) || []).filter((p) => p.page_id && p.page_status === "active");
    // Reloads (including the refresh after a publish) start from a clean
    // slate — a stale tick must never publish something a second time.
    selectedProps.clear();
    $("propsCard").hidden = false;
    const box = $("propList");
    box.textContent = "";
    if (!props.length) {
      const p = document.createElement("p");
      p.className = "muted"; p.textContent = "אין עדיין נכסים פעילים.";
      box.appendChild(p);
      return;
    }
    const rows = new Map();
    for (const prop of props) {
      const row = propRow(prop);
      rows.set(prop.page_id, row);
      box.appendChild(row);
    }
    await Promise.all(props.map((p) => refreshListing(p, rows.get(p.page_id))));
    // Nothing is pre-selected: publishing under an agent's own name is an
    // explicit act, so the agent ticks what they mean to publish. The only
    // exception is an explicit deep link (?page=…), handled below.
    renderStepper();
    syncCatalogType();
    startPollingIfNeeded(rows);
    focusDeepLink(rows);
  }

  // Live refresh: while any job is in flight, poll every 10s (max ~5 min)
  // so chips flip to "פורסם" with the post link by themselves.
  function startPollingIfNeeded(rows) {
    clearInterval(pollT);
    let ticks = 0;
    const anyInFlight = () =>
      [...listingState.values()].some((L) => L.in_flight);
    if (!anyInFlight()) return;
    pollT = setInterval(async () => {
      ticks++;
      const inFlight = props.filter((p) => (listingState.get(p.page_id) || {}).in_flight);
      await Promise.all(inFlight.map((p) => refreshListing(p, rows.get(p.page_id))));
      if (!anyInFlight() || ticks > 30) { clearInterval(pollT); renderStepper(); }
    }, 10000);
  }

  function focusDeepLink(rows) {
    const focus = new URLSearchParams(location.search).get("page");
    if (!focus || !rows.has(focus)) return;
    const el = rows.get(focus);
    el.scrollIntoView({ block: "center" });
    el._els.cb.checked = true; selectedProps.add(focus);
    el.style.outline = "2px solid var(--gold)";
    el.style.outlineOffset = "4px"; el.style.borderRadius = "12px";
    setTimeout(() => { el.style.outline = ""; }, 4000);
    renderStepper();
  }

  // ── the sharing queue ──
  // Opens (or reopens) a per-property queue: copy → open group → mark posted,
  // resumable, with per-group tracking. Same screen the WhatsApp link opens.
  async function openKit(pageId) {
    try {
      const s = await api("/api/distribution/share-session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ page_id: pageId }),
      });
      location.href = `/share.html?s=${encodeURIComponent(s.id)}`;
    } catch { toast("פתיחת ערכת השיתוף נכשלה."); }
  }

  // ── step 3: groups (catalog picker with pinned selection) ──
  function ownGroupLines() {
    return $("groupsBox").value.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  function updateGroupCount(groups) {
    const el = $("groupCount");
    el.textContent = groups.length >= 5
      ? `יש ${groups.length} קבוצות 👍`
      : `כרגע ${groups.length}. הוסיפו עוד ${5 - groups.length} להגעה מיטבית.`;
  }

  function catalogRow(g, showCity) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer;font-size:.9rem";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = selected.has(g.url);
    cb.style.accentColor = "var(--gold)";
    cb.onchange = () => {
      if (cb.checked) selected.add(g.url); else selected.delete(g.url);
      renderCatalog(); renderStepper();
    };
    const span = document.createElement("span");
    span.textContent = (g.joined ? "✓ " : "") + g.name +
      (showCity && g.city ? ` · ${g.city}` : "") +
      (g.members ? ` · ~${Math.round(g.members / 1000)}K חברים` : "");
    if (g.joined) span.title = "אתם חברים בקבוצה הזו";
    label.append(cb, span);
    return label;
  }

  function sectionHead(text, color) {
    const h = document.createElement("div");
    h.textContent = text;
    h.style.cssText = `font-weight:700;font-size:.85rem;color:${color};margin:8px 0 2px`;
    return h;
  }

  function renderCatalog() {
    const box = $("catalogList");
    box.textContent = "";
    if (!catalog.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "אין עדיין קבוצות מומלצות — הציעו קבוצות ונוסיף אותן לקטלוג.";
      box.appendChild(p);
      return;
    }
    const q = ($("catalogFilter").value || "").trim().toLowerCase();
    const bySize = (a, b) => (b.members || 0) - (a.members || 0);
    // Pinned: the agent's selected groups, always on top, never filtered out.
    const chosen = catalog.filter((g) => selected.has(g.url)).sort(bySize);
    if (chosen.length) {
      box.appendChild(sectionHead(`✓ הקבוצות שנבחרו (${chosen.length})`, "#157A3F"));
      for (const g of chosen) box.appendChild(catalogRow(g, true));
    }
    // Groups the agent already belongs to come first: those are the ones
    // they can actually post to today.
    const myGroups = [];
    const byCity = new Map();
    const mismatched = [];
    for (const g of catalog) {
      if (selected.has(g.url)) continue;
      if (q && !(g.name + " " + (g.city || "")).toLowerCase().includes(q)) continue;
      if (g.joined) { myGroups.push(g); continue; }
      // Groups that don't take this listing type are shown LAST, never hidden
      // — the agent decides, but a sale shouldn't lead with rental groups.
      if (g.match === false) { mismatched.push(g); continue; }
      const c = g.city || "ארצי";
      if (!byCity.has(c)) byCity.set(c, []);
      byCity.get(c).push(g);
    }
    if (myGroups.length) {
      box.appendChild(sectionHead(`הקבוצות שאתם חברים בהן (${myGroups.length})`, "#157A3F"));
      myGroups.sort(bySize);
      for (const g of myGroups) box.appendChild(catalogRow(g, true));
    }
    for (const [city, groups] of byCity) {
      box.appendChild(sectionHead(city, "var(--gold)"));
      groups.sort(bySize);
      for (const g of groups) box.appendChild(catalogRow(g, false));
    }
    if (mismatched.length) {
      const label = catalogType === "rent"
        ? "פחות מתאימות לשכירות" : "פחות מתאימות למכירה";
      box.appendChild(sectionHead(`${label} (${mismatched.length})`, "var(--ink-soft)"));
      mismatched.sort(bySize);
      for (const g of mismatched) box.appendChild(catalogRow(g, true));
    }
    updateGroupCount([...selected, ...ownGroupLines()]);
  }

  // Re-fetch the catalog when the selection flips sale ↔ rent, so matching
  // always reflects what's actually about to be shared.
  function syncCatalogType() {
    const want = currentListingType();
    if (catalog.length && want !== catalogType) loadCatalog(want);
  }

  function loadCatalog(type) {
    catalogType = type;
    return api(`/api/distribution/group-catalog?listing_type=${encodeURIComponent(type)}`)
      .then((r) => { catalog = r.groups || []; renderCatalog(); })
      .catch(() => { /* keep whatever is rendered */ });
  }

  function renderGroups() {
    $("groupsCard").hidden = false;
    const mine = st.groups || [];
    catalogType = currentListingType();
    api(`/api/distribution/group-catalog?listing_type=${encodeURIComponent(catalogType)}`).then((r) => {
      catalog = r.groups || [];
      const catalogUrls = catalog.map((g) => g.url);
      selected = new Set(mine.filter((u) => catalogUrls.includes(u)));
      $("groupsBox").value = mine.filter((u) => !catalogUrls.includes(u)).join("\n");
      renderCatalog();
      $("catalogFilter").oninput = renderCatalog;
      $("groupsBox").oninput = () => {
        updateGroupCount([...selected, ...ownGroupLines()]);
        renderStepper();
      };
      renderStepper();
    }).catch(() => { $("groupsBox").value = mine.join("\n"); updateGroupCount(mine); });

    const collectSelection = () => [...selected, ...ownGroupLines()];

    $("saveGroups").onclick = () => saveGroups(true);

    $("suggestBtn").onclick = async () => {
      const url = $("suggestUrl").value.trim();
      if (!url) return;
      try {
        const r = await api("/api/distribution/group-catalog/suggest", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        });
        $("suggestUrl").value = "";
        const catalogUrls = catalog.map((g) => g.url);
        $("groupsBox").value = r.groups.filter((u) => !catalogUrls.includes(u)).join("\n");
        updateGroupCount(r.groups);
        toast("הקבוצה נוספה לרשימה שלכם והוצעה לקטלוג המשותף.");
      } catch (e) {
        toast(e.code === "invalid_group_url"
          ? "זה לא נראה כמו קישור לקבוצת פייסבוק (facebook.com/groups/...)"
          : "ההוספה נכשלה — נסו שוב.");
      }
    };

    $("fbSearchBtn").onclick = () => {
      const q = $("fbSearchBox").value.trim();
      if (q) window.open("https://www.facebook.com/search/groups?q=" + encodeURIComponent(q),
        "_blank", "noopener");
    };
  }

  // Ticked boxes are not a saved list: publishing with unsaved ticks used to
  // drop them silently and the share queue arrived empty. Publish saves first.
  async function saveGroups(loud) {
    const groups = [...selected, ...ownGroupLines()];
    try {
      const r = await api("/api/distribution/groups", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups }),
      });
      updateGroupCount(r.groups);
      if (loud) {
        toast(r.groups.length < groups.length
          ? "נשמר. שימו לב: קישורים שאינם קבוצות פייסבוק הוסרו."
          : "הקבוצות נשמרו.");
      }
      return r.groups;
    } catch {
      if (loud) toast("השמירה נכשלה — נסו שוב.");
      return null;
    }
  }

  // ── step 4: publish ──
  async function publishOne(pageId, force) {
    try {
      await api("/api/distribution/publish", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ page_id: pageId, force }),
      });
      return "ok";
    } catch (e) { return e.code || "error"; }
  }

  async function publishSelected(forceRepublished) {
    if (!connected()) {
      toast("קודם מתחברים לפייסבוק — שלב 1 👆");
      $("connectCard").scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const picks = [...selectedProps];
    if (!picks.length) {
      toast("בחרו לפחות נכס אחד לפרסום (שלב 2).");
      $("propsCard").scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const groups = [...selected, ...ownGroupLines()];
    if (groups.length === 0) {
      toast("טיפ: בחרו קבוצות (שלב 3) כדי לקבל ערכת שיתוף מלאה.");
    } else {
      const saved = await saveGroups(false);
      if (saved === null) { toast("שמירת הקבוצות נכשלה — נסו שוב."); return; }
    }
    $("publishBtn").disabled = true;
    const fresh = [], published = [];
    for (const id of picks) {
      const L = listingState.get(id) || {};
      (L.posted ? published : fresh).push(id);
    }
    let started = 0, failed = 0;
    for (const id of fresh) {
      const r = await publishOne(id, false);
      if (r === "ok" || r === "already_in_flight") started++; else failed++;
    }
    if (published.length && !forceRepublished) {
      $("repostText").textContent = published.length === 1
        ? "אחד מהנכסים שנבחרו כבר פורסם. פרסום נוסף ייצור פוסט חדש בדף."
        : `${published.length} מהנכסים שנבחרו כבר פורסמו. פרסום נוסף ייצור פוסטים חדשים.`;
      $("repostDlg").showModal();
      $("repostYes").onclick = async () => {
        $("repostDlg").close();
        for (const id of published) {
          const r = await publishOne(id, true);
          if (r === "ok") started++; else failed++;
        }
        finishPublish(started, failed);
      };
      $("repostNo").onclick = () => { $("repostDlg").close(); finishPublish(started, failed); };
      return;
    }
    if (published.length && forceRepublished) {
      for (const id of published) {
        const r = await publishOne(id, true);
        if (r === "ok") started++; else failed++;
      }
    }
    finishPublish(started, failed);
  }

  function finishPublish(started, failed) {
    $("publishBtn").disabled = false;
    if (started) toast(`🚀 ${started} פרסומים בדרך — עדכון יגיע בוואטסאפ.`);
    else if (failed) toast("הפרסום נכשל — נסו שוב בעוד רגע.");
    setTimeout(loadProps, 1500);
  }

  $("publishBtn").onclick = () => publishSelected(false);

  // ── init ──
  (async () => {
    try { st = await api("/api/distribution/status"); }
    catch { return; }               // 401 already redirected
    if (!st.entitled) { $("entitleCard").hidden = false; return; }
    renderConnection();
    $("publishCard").hidden = false;
    renderGroups();
    loadProps();
    renderStepper();
    if (new URLSearchParams(location.search).get("connected") === "1") {
      toast("החיבור לפייסבוק הושלם ✅");
      history.replaceState(null, "", location.pathname + location.hash);
    }
  })();
})();
