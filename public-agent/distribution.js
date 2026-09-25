/*
 * distribution.js — backend-only Facebook and Group settings.
 *
 * A property is selected only from its dashboard card. This page stores the
 * optional Facebook Page connection and the manual/default Group links that a
 * new property workspace may use as its initial target list.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = (path, opts) => fetch(path, { credentials: "include", ...opts })
    .then(async (r) => {
      if (r.status === 401) { location.href = "/"; throw new Error("unauthenticated"); }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.error || "error"), { code: body.error });
      return body;
    });

  let state = null;
  let catalog = [];
  let selected = new Set();
  let toastTimer = null;

  function toast(text) {
    const el = $("msg");
    el.textContent = text;
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = "none"; }, 4200);
  }

  function groupLines() {
    return $("groupsBox").value.split("\n").map((value) => value.trim()).filter(Boolean);
  }

  function updateGroupCount(groups) {
    const count = groups.length;
    $("groupCount").textContent = count
      ? `${count} קבוצות שמורות כברירת מחדל`
      : "עדיין לא נשמרו קבוצות — אפשר לבחור מהקטלוג או להדביק קישורים";
  }

  function sectionHead(text, color) {
    const head = document.createElement("div");
    head.textContent = text;
    head.style.cssText = `font-weight:700;font-size:.85rem;color:${color};margin:8px 0 2px`;
    return head;
  }

  function catalogRow(group, showCity) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;gap:8px;align-items:center;padding:4px 0;cursor:pointer;font-size:.9rem";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(group.url);
    checkbox.style.accentColor = "var(--gold)";
    checkbox.onchange = () => {
      if (checkbox.checked) selected.add(group.url); else selected.delete(group.url);
      renderCatalog();
    };
    const text = document.createElement("span");
    const policy = group.agent_policy === "explicitly_allowed"
      ? " · פרסום מתווכים נתמך"
      : " · בדקו את כללי הקבוצה";
    text.textContent = group.name +
      (showCity && group.city ? ` · ${group.city}` : "") +
      (group.members ? ` · ~${Math.round(group.members / 1000)}K חברים` : "") + policy;
    label.append(checkbox, text);
    return label;
  }

  function renderCatalog() {
    const box = $("catalogList");
    box.textContent = "";
    const filter = ($("catalogFilter").value || "").trim().toLowerCase();
    const matching = catalog.filter((group) => !filter ||
      `${group.name || ""} ${group.city || ""}`.toLowerCase().includes(filter));
    const bySize = (a, b) => (b.members || 0) - (a.members || 0);
    const chosen = catalog.filter((group) => selected.has(group.url)).sort(bySize);
    if (chosen.length) {
      box.appendChild(sectionHead(`✓ קבוצות ברירת המחדל (${chosen.length})`, "#157A3F"));
      chosen.forEach((group) => box.appendChild(catalogRow(group, true)));
    }
    const cities = new Map();
    matching.filter((group) => !selected.has(group.url)).forEach((group) => {
      const city = group.city || "ארצי";
      if (!cities.has(city)) cities.set(city, []);
      cities.get(city).push(group);
    });
    for (const [city, groups] of cities) {
      box.appendChild(sectionHead(city, "var(--gold)"));
      groups.sort(bySize).forEach((group) => box.appendChild(catalogRow(group, false)));
    }
    if (!catalog.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "אין עדיין קבוצות בקטלוג. אפשר להדביק קישור לקבוצה ידנית.";
      box.appendChild(note);
    }
    updateGroupCount([...selected, ...groupLines()]);
  }

  async function loadCatalog() {
    const response = await api("/api/distribution/group-catalog");
    catalog = response.groups || [];
    const saved = response.selected_groups || (state && state.groups) || [];
    const catalogUrls = new Set(catalog.map((group) => group.url));
    selected = new Set(saved.filter((url) => catalogUrls.has(url)));
    $("groupsBox").value = saved.filter((url) => !catalogUrls.has(url)).join("\n");
    renderCatalog();
  }

  async function saveGroups(loud = true) {
    const groups = [...selected, ...groupLines()];
    try {
      const response = await api("/api/distribution/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups }),
      });
      state.groups = response.groups || [];
      updateGroupCount(state.groups);
      if (loud) toast("קבוצות ברירת המחדל נשמרו ✓");
      return response.groups;
    } catch (error) {
      if (loud) toast(error.code === "invalid_group_url"
        ? "אחד הקישורים אינו קישור לקבוצת Facebook"
        : "שמירת הקבוצות נכשלה — נסו שוב.");
      return null;
    }
  }

  function renderConnection() {
    $("connectCard").hidden = false;
    const connection = state.connection || {};
    const chip = $("connChip");
    const text = $("connText");
    const button = $("connectBtn");
    if (connection.needs_reconnect) {
      chip.textContent = "נדרש חיבור מחדש";
      chip.className = "conn-chip warn";
      text.textContent = "החיבור לדף פג תוקף. אפשר לחדש אותו כאן או מעמוד הפרסום של נכס.";
      button.textContent = "חיבור מחדש";
    } else if (connection.connected) {
      chip.textContent = "מחובר";
      chip.className = "conn-chip ok";
      text.textContent = `הדף המחובר: ${connection.page_name || "Facebook"}. כל נכס ניתן לפרסום ישירות מהדשבורד.`;
      button.textContent = "החלפת דף / חיבור מחדש";
    } else {
      chip.textContent = "לא מחובר";
      chip.className = "conn-chip warn";
      text.textContent = "חיבור חד-פעמי מאפשר פרסום אוטומטי בדף העסקי מעמוד הפרסום של כל נכס.";
      button.textContent = "חיבור חשבון Facebook";
    }
    button.onclick = () => { location.href = "/api/distribution/oauth/start"; };
  }

  function bindGroupControls() {
    $("catalogFilter").oninput = renderCatalog;
    $("groupsBox").oninput = () => updateGroupCount([...selected, ...groupLines()]);
    $("saveGroups").onclick = () => saveGroups(true);
    $("suggestBtn").onclick = async () => {
      const url = $("suggestUrl").value.trim();
      if (!url) return;
      try {
        const response = await api("/api/distribution/group-catalog/suggest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        });
        $("suggestUrl").value = "";
        state.groups = response.groups || [];
        await loadCatalog();
        toast("הקבוצה נשמרה כברירת מחדל ונשלחה להצעת קטלוג.");
      } catch (error) {
        toast(error.code === "invalid_group_url"
          ? "זה אינו קישור לקבוצת Facebook (facebook.com/groups/...)"
          : "הוספת הקבוצה נכשלה.");
      }
    };
    $("fbSearchBtn").onclick = () => {
      const query = $("fbSearchBox").value.trim();
      if (query) window.open(`https://www.facebook.com/search/groups?q=${encodeURIComponent(query)}`, "_blank", "noopener");
    };
  }

  (async () => {
    try { state = await api("/api/distribution/status"); }
    catch { return; }
    if (!state.entitled) { $("entitleCard").hidden = false; return; }
    renderConnection();
    $("groupsCard").hidden = false;
    bindGroupControls();
    await loadCatalog().catch(() => {
      $("groupsBox").value = (state.groups || []).join("\n");
      updateGroupCount(state.groups || []);
    });
    if (new URLSearchParams(location.search).get("connected") === "1") {
      toast("החיבור לפייסבוק הושלם ✓");
      history.replaceState(null, "", location.pathname + location.hash);
    }
  })();

  // ── the personal-account browser: facebook posts, yad2/madlan are read-only
  //    (Phase 4 — connect + dwell + read one's own listings as drafts).
  //    Same flow for all three; only the copy under each row differs. ──
  const bModal = $("browserModal"), bBody = $("browserModalBody"), bMsg = $("browserModalMsg");
  let bOpen = false, currentPlatform = null;

  const PLATFORM_ROWS = [
    { key: "facebook", label: "פייסבוק", copy: [
      "חיבור אחד לפייסבוק — פורלי תפרסם גם בדף העסקי וגם בקבוצות מאותו חשבון, ותקרא פוסטים מקבוצות. מתחברים כאן פעם אחת, כמו בדפדפן רגיל.",
      "בשלושת הימים הראשונים פורלי רק מסתובבת בפייסבוק מהחשבון שלכם — גוללת, צופה, מסמנת לייק פה ושם — בלי לפרסם. אחר כך פוסט אחד ביום, ובהדרגה יותר. ככה פייסבוק רואה פעילות רגילה ולא רובוט, וזה מה ששומר על החשבון שלכם.",
    ], small: "פרסום אוטומטי בקבוצות נעשה על אחריותכם — נסביר בדיוק לפני שמתחילים." },
    { key: "yad2", label: "יד2", copy: [
      "מתחברים ליד2 כדי שפורלי תוכל לקרוא את המודעות שלכם באתר ולהציע אותן כדף נכס מוכן — פורלי לא מפרסמת דרך החשבון הזה.",
    ] },
    { key: "madlan", label: "מדלן", copy: [
      "מתחברים למדלן כדי שפורלי תוכל לקרוא את המודעות שלכם באתר ולהציע אותן כדף נכס מוכן — פורלי לא מפרסמת דרך החשבון הזה.",
    ] },
  ];

  function rowHtml(p) {
    return `<div class="conn-platform-row" data-platform="${p.key}">
      <h3>${p.label} <span class="conn-chip" id="browserConnChip_${p.key}"></span></h3>
      ${p.copy.map((t) => `<p class="muted">${t}</p>`).join("")}
      ${p.small ? `<p class="muted small">${p.small}</p>` : ""}
      <label class="consent-line"><input type="checkbox" id="browserConsent_${p.key}"> <span>הבנתי, ואני רוצה לחבר את החשבון</span></label>
      <div class="conn-row">
        <button class="btn btn-gold" id="browserConnectBtn_${p.key}">חיבור החשבון</button>
        <button class="btn btn-danger" id="browserDisconnectBtn_${p.key}" hidden>ניתוק החשבון</button>
        <span class="muted small" id="browserIdentity_${p.key}"></span>
      </div>
    </div>`;
  }
  $("browserRows").innerHTML = PLATFORM_ROWS.map(rowHtml).join("");

  function openBrowser(viewUrl) {
    // The viewer refuses to be framed (X-Frame-Options / frame-ancestors), so
    // it opens in its own window. Stripping that header server-side would mean
    // proxying their websocket and defeating a deliberate control.
    const win = window.open(viewUrl, "forly-connect", "width=1200,height=820,noopener");
    bBody.innerHTML = '<p class="popup-note">ההתחברות נפתחה בחלון נפרד. כשסיימתם, חזרו לכאן ולחצו "סיימתי להתחבר".</p>';
    if (!win) bBody.innerHTML = '<p class="popup-note">הדפדפן חסם את החלון — אשרו חלונות קופצים לאתר ונסו שוב.</p>';
    bModal.hidden = false; bOpen = true;
  }
  function closeBrowser() { bModal.hidden = true; bBody.innerHTML = ""; bOpen = false; }

  async function refreshBrowserChip(platform) {
    try {
      const j = await api(`/api/connections/browser/${platform}/status`);
      const on = j.state === "connected";
      $(`browserConnChip_${platform}`).textContent = on ? "מחובר" : "";
      $(`browserIdentity_${platform}`).textContent = on && j.identity_label ? `מחובר בתור ${j.identity_label}` : "";
      $(`browserDisconnectBtn_${platform}`).hidden = !on;
      $(`browserConnectBtn_${platform}`).textContent = on ? "חיבור מחדש" : "חיבור החשבון";
    } catch (e) { /* row stays in its default state */ }
  }

  PLATFORM_ROWS.forEach(({ key: platform }) => {
    $(`browserConnectBtn_${platform}`).addEventListener("click", async function () {
      if (!$(`browserConsent_${platform}`).checked) { toast("סמנו את האישור שמעל הכפתור"); return; }
      const btn = this; btn.disabled = true; btn.textContent = "פותחים דפדפן…";
      currentPlatform = platform;
      try {
        const j = await api("/api/connections/browser/start", { method: "POST", body: JSON.stringify({ platform, consent: true }) });
        openBrowser(j.view_url);
      } catch (e) {
        toast(e && e.code === "profile_busy" ? "פורלי כבר משתמשת בחשבון הזה — נסו שוב בעוד כמה דקות" : "לא הצלחנו לפתוח דפדפן כרגע — נסו שוב בעוד רגע");
      } finally { btn.disabled = false; refreshBrowserChip(platform); }
    });
    $(`browserDisconnectBtn_${platform}`).addEventListener("click", async function () {
      if (!confirm("לנתק את החשבון? פורלי תפסיק להשתמש בו ותמחק את ההתחברות השמורה.")) return;
      try { await api(`/api/connections/browser/${platform}`, { method: "DELETE" }); toast("החשבון נותק"); }
      catch (e) { toast("לא הצלחנו לנתק — נסו שוב"); }
      refreshBrowserChip(platform);
    });
  });

  $("browserDoneBtn").addEventListener("click", async function () {
    const btn = this; btn.disabled = true; bMsg.textContent = "בודקים…";
    try {
      const j = await api(`/api/connections/browser/${currentPlatform}/finish`, { method: "POST" });
      toast(j.identity_label ? `החשבון מחובר ✓ (${j.identity_label})` : "החשבון מחובר ✓");
      closeBrowser(); refreshBrowserChip(currentPlatform);
    } catch (e) {
      bMsg.textContent = e && e.code === "session_expired"
        ? "עבר יותר מדי זמן והחלון נסגר. פתחו אותו שוב ונסו להתחבר."
        : "נראה שעדיין לא התחברתם — השלימו את ההתחברות בדפדפן ואז לחצו שוב.";
    } finally { btn.disabled = false; }
  });

  $("browserModalClose").addEventListener("click", closeBrowser);

  // If the agent leaves for the SMS and comes back, the modal is still here;
  // only when they close it explicitly is the session's fate decided by /finish.
  $("browserConnectCard").hidden = false;
  PLATFORM_ROWS.forEach(({ key }) => refreshBrowserChip(key));
})();
