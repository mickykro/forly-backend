/*
 * distribution.js — the הפצה dashboard page.
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
    clearTimeout(toastT); toastT = setTimeout(() => { m.style.display = "none"; }, 4000);
  }

  function renderConnection(st) {
    $("connectCard").hidden = false;
    const chip = $("connChip"), txt = $("connText"), btn = $("connectBtn");
    if (st.connection.needs_reconnect) {
      chip.textContent = "נדרש חיבור מחדש"; chip.className = "chip warn";
      txt.textContent = "החיבור פג תוקף — הפרסום מושהה עד חיבור מחדש.";
      btn.textContent = "חיבור מחדש"; btn.hidden = false;
    } else if (st.connection.connected) {
      chip.textContent = "מחובר"; chip.className = "chip ok";
      txt.textContent = `מפרסמים לדף: ${st.connection.page_name || ""}` +
        (st.connection.instagram_linked ? " · אינסטגרם מקושר" : "");
      btn.textContent = "החלפת דף / חיבור מחדש"; btn.hidden = false;
    } else {
      chip.textContent = "לא מחובר"; chip.className = "chip warn";
      txt.textContent = "חיבור חד-פעמי — ומהנכס הבא הפרסום בקליק אחד.";
      btn.hidden = false;
    }
    btn.onclick = () => { location.href = "/api/distribution/oauth/start"; };
  }

  // The curated catalog renders as checkboxes; anything the agent has saved
  // that ISN'T in the catalog lives in the free-text box. Saving merges both.
  // Selection state lives in `selected` — checked groups are PINNED to a
  // section at the top (immune to the filter); unchecking returns a group to
  // its city section.
  let catalog = [];
  let selected = new Set();

  function ownGroupLines() {
    return $("groupsBox").value.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  function catalogRow(g, showCity) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer;font-size:.9rem";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = selected.has(g.url);
    cb.onchange = () => {
      if (cb.checked) selected.add(g.url); else selected.delete(g.url);
      renderCatalog();
    };
    const span = document.createElement("span");
    span.textContent = g.name +
      (showCity && g.city ? ` · ${g.city}` : "") +
      (g.members ? ` · ~${Math.round(g.members / 1000)}K חברים` : "");
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
      box.appendChild(sectionHead(`✓ הקבוצות שנבחרו (${chosen.length})`, "var(--ok)"));
      for (const g of chosen) box.appendChild(catalogRow(g, true));
    }
    // The rest, grouped by city, biggest first, filterable.
    const byCity = new Map();
    for (const g of catalog) {
      if (selected.has(g.url)) continue;
      if (q && !(g.name + " " + (g.city || "")).toLowerCase().includes(q)) continue;
      const c = g.city || "ארצי";
      if (!byCity.has(c)) byCity.set(c, []);
      byCity.get(c).push(g);
    }
    for (const [city, groups] of byCity) {
      box.appendChild(sectionHead(city, "var(--gold)"));
      groups.sort(bySize);
      for (const g of groups) box.appendChild(catalogRow(g, false));
    }
    updateGroupCount([...selected, ...ownGroupLines()]);
  }

  function renderGroups(st) {
    $("groupsCard").hidden = false;
    const mine = st.groups || [];
    api("/api/distribution/group-catalog").then((r) => {
      catalog = r.groups || [];
      const catalogUrls = catalog.map((g) => g.url);
      selected = new Set(mine.filter((u) => catalogUrls.includes(u)));
      $("groupsBox").value = mine.filter((u) => !catalogUrls.includes(u)).join("\n");
      renderCatalog();
      $("catalogFilter").oninput = renderCatalog;
      $("groupsBox").oninput = () => updateGroupCount([...selected, ...ownGroupLines()]);
    }).catch(() => { $("groupsBox").value = mine.join("\n"); updateGroupCount(mine); });

    const collectSelection = () => [...selected, ...ownGroupLines()];

    $("saveGroups").onclick = async () => {
      const groups = collectSelection();
      try {
        const r = await api("/api/distribution/groups", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ groups }),
        });
        updateGroupCount(r.groups);
        toast(r.groups.length < groups.length
          ? "נשמר. שימו לב: קישורים שאינם קבוצות פייסבוק הוסרו."
          : "הקבוצות נשמרו.");
      } catch { toast("השמירה נכשלה — נסו שוב."); }
    };

    // Offer a group: usable immediately, suggested to the shared catalog.
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

    // Facebook killed the group-search API — the honest path is opening
    // Facebook's own search prefilled; the agent copies the group URL back.
    $("fbSearchBtn").onclick = () => {
      const q = $("fbSearchBox").value.trim();
      if (q) window.open("https://www.facebook.com/search/groups?q=" + encodeURIComponent(q),
        "_blank", "noopener");
    };
  }

  function updateGroupCount(groups) {
    const el = $("groupCount");
    el.textContent = groups.length >= 5
      ? `יש ${groups.length} קבוצות 👍`
      : `כרגע ${groups.length}. הוסיפו עוד ${5 - groups.length} להגעה מיטבית.`;
  }

  async function publish(pageId, force, btn) {
    btn.disabled = true;
    try {
      await api("/api/distribution/publish", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ page_id: pageId, force }),
      });
      toast("נשלח לפרסום — עדכון יגיע בוואטסאפ.");
      setTimeout(loadProps, 1500);
    } catch (e) {
      if (e.code === "already_published") {
        const dlg = $("repostDlg");
        dlg.showModal();
        $("repostYes").onclick = () => { dlg.close(); publish(pageId, true, btn); };
        $("repostNo").onclick = () => dlg.close();
      } else if (e.code === "already_in_flight") {
        toast("הפרסום כבר בתהליך.");
      } else {
        toast("הפרסום נכשל — נסו שוב בעוד רגע.");
      }
    } finally { btn.disabled = false; }
  }

  async function loadProps() {
    const props = await api("/api/properties").catch(() => null);
    const list = (props && props.properties) || [];
    $("propsCard").hidden = false;
    const box = $("propList");
    box.textContent = "";
    const active = list.filter((p) => p.page_id && p.page_status === "active");
    if (!active.length) {
      const p = document.createElement("p");
      p.className = "muted"; p.textContent = "אין עדיין נכסים פעילים.";
      box.appendChild(p); return;
    }
    for (const prop of active) {
      const pageId = prop.page_id;
      const row = document.createElement("div"); row.className = "prop";
      row.id = "prop-" + pageId;
      const t = document.createElement("div"); t.className = "t";
      const name = document.createElement("div"); name.className = "name";
      name.textContent = prop.title || pageId;
      t.appendChild(name);
      const chip = document.createElement("span"); chip.className = "chip";
      chip.textContent = "…";
      const btn = document.createElement("button");
      btn.textContent = "פרסום"; btn.onclick = () => publish(pageId, false, btn);
      row.append(t, chip, btn); box.appendChild(row);
      api(`/api/distribution/status?page_id=${encodeURIComponent(pageId)}`).then((st) => {
        const L = st.listing || {};
        if (L.posted) {
          chip.textContent = "פורסם"; chip.className = "chip ok";
          btn.textContent = "פרסום מחדש";
          if (L.post_url) {
            const a = document.createElement("a");
            a.href = L.post_url; a.target = "_blank"; a.rel = "noopener";
            a.textContent = "לפוסט";
            t.appendChild(a);
          }
        } else if (L.in_flight) {
          chip.textContent = "בתהליך"; btn.disabled = true;
        } else if (L.last_status === "failed") {
          chip.textContent = "נכשל"; chip.className = "chip warn";
          btn.textContent = "ניסיון נוסף";
        } else {
          chip.textContent = "טרם פורסם";
        }
      }).catch(() => { chip.textContent = "—"; });
    }
    // Deep link from the main dashboard: /distribution.html?page=<id>
    // scrolls to that property and highlights it briefly.
    const focus = new URLSearchParams(location.search).get("page");
    if (focus) {
      const el = document.getElementById("prop-" + focus);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.style.outline = "2px solid var(--gold)";
        el.style.outlineOffset = "4px";
        el.style.borderRadius = "10px";
        setTimeout(() => { el.style.outline = ""; }, 4000);
      }
    }
  }

  (async () => {
    let st;
    try { st = await api("/api/distribution/status"); }
    catch { return; }               // 401 already redirected
    if (!st.entitled) { $("entitleCard").hidden = false; return; }
    renderConnection(st);
    renderGroups(st);
    loadProps();
    // Landed here from a successful OAuth connect → confirm it, clean the URL
    // (but keep ?page= deep links intact for the highlight above).
    if (new URLSearchParams(location.search).get("connected") === "1") {
      toast("החיבור לפייסבוק הושלם ✅");
      history.replaceState(null, "", location.pathname);
    }
  })();
})();
