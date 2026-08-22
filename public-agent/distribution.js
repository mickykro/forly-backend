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

  function renderGroups(st) {
    $("groupsCard").hidden = false;
    $("groupsBox").value = (st.groups || []).join("\n");
    updateGroupCount(st.groups || []);
    $("saveGroups").onclick = async () => {
      const groups = $("groupsBox").value.split("\n").map((s) => s.trim()).filter(Boolean);
      try {
        const r = await api("/api/distribution/groups", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ groups }),
        });
        $("groupsBox").value = r.groups.join("\n");
        updateGroupCount(r.groups);
        toast(r.groups.length < groups.length
          ? "נשמר. שימו לב: קישורים שאינם קבוצות פייסבוק הוסרו."
          : "הקבוצות נשמרו.");
      } catch { toast("השמירה נכשלה — נסו שוב."); }
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
