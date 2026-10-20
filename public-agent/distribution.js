/*
 * distribution.js — backend-only Facebook and Group settings.
 *
 * A property is selected only from its dashboard card. This page stores the
 * optional Facebook Page connection and shows the agent's default groups —
 * the same one list the auto-publish page edits (PUT /api/posting/default-groups).
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = (path, opts = {}) => fetch(path, {
    credentials: "include",
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json", ...opts.headers } : opts.headers,
  })
    .catch(() => { throw Object.assign(new Error("network"), { code: "network" }); })
    .then(async (r) => {
      if (r.status === 401) { location.href = "/"; throw new Error("unauthenticated"); }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.error || "error"), { code: body.error || (r.status === 404 ? "unavailable" : "error"), status: r.status, reason: body.reason });
      return body;
    });

  let state = null;
  let catalog = [];
  let toastTimer = null;

  function toast(text) {
    if (!text) return; // a silent error says nothing
    const el = $("msg");
    el.textContent = text;
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = "none"; }, 4200);
  }

  function sectionHead(text, color) {
    const head = document.createElement("div");
    head.textContent = text;
    head.style.cssText = `font-weight:700;font-size:.85rem;color:${color};margin:8px 0 2px`;
    return head;
  }

  // ── default groups: ONE list, the same as the auto-publish page's ──
  // (PUT /api/posting/default-groups). Member groups only: the catalog below
  // is for finding groups to join; after joining, "רענון" brings them here.
  let posting = null;
  const escHtml = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fbLink = (url) => (/^https:\/\/(www\.|m\.)?facebook\.com\/groups\//.test(url || "") ? url : null);

  function updateGroupCount() {
    const n = ((posting && posting.default_group_ids) || []).length;
    $("groupCount").textContent = n ? `${n} קבוצות ברירת מחדל` : "עוד לא נבחרו קבוצות ברירת מחדל";
  }

  function renderMyGroups() {
    const box = $("myGroups"), nm = $("nonMemberGroups");
    if (!posting || !posting.connected) {
      box.innerHTML = '<p class="muted small">כדי לבחור קבוצות, חברו קודם את חשבון הפייסבוק האישי שלכם (למטה, "חשבונות אישיים").</p>';
      nm.innerHTML = ""; updateGroupCount(); return;
    }
    const defs = new Set((posting.default_group_ids || []).map(String));
    const members = (posting.member_groups || []).filter((g) => g.membership_state === "member");
    box.innerHTML = members.length ? members.map((g) =>
      `<label class="grp-row"><input type="checkbox" data-def="${escHtml(g.group_id)}"${defs.has(String(g.group_id)) ? " checked" : ""}> <span>${escHtml(g.name)}</span></label>`).join("")
      : '<p class="muted small">לא מצאנו קבוצות שאתם חברים בהן. הצטרפו לקבוצות מהקטלוג למטה ולחצו "רענון".</p>';
    const links = (posting.non_member_groups || []).filter((g) => fbLink(g.url));
    nm.innerHTML = links.length ? '<h3 style="font-size:.92rem;margin:12px 0 6px">שמרתם, אבל עוד לא הצטרפתם</h3>' +
      links.map((g) => `<div class="grp-row"><span>${escHtml(g.name || g.url.replace(/^https?:\/\/(www\.)?/, ""))}</span> <a href="${escHtml(g.url)}" target="_blank" rel="noopener noreferrer">הצטרפות ↗</a></div>`).join("") : "";
    updateGroupCount();
  }

  async function loadMyGroups() {
    try { posting = await api("/api/posting/settings"); } catch (e) { posting = null; }
    renderMyGroups();
  }

  function catalogRow(group, showCity) {
    const row = document.createElement("div");
    row.className = "grp-row";
    const text = document.createElement("span");
    const policy = group.agent_policy === "explicitly_allowed" ? " · פרסום מתווכים נתמך" : " · בדקו את כללי הקבוצה";
    text.textContent = group.name + (showCity && group.city ? ` · ${group.city}` : "") +
      (group.members ? ` · ~${Math.round(group.members / 1000)}K חברים` : "") + policy;
    row.appendChild(text);
    if (fbLink(group.url)) {
      const a = document.createElement("a");
      a.href = group.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = " הצטרפות ↗";
      row.appendChild(a);
    }
    return row;
  }

  function renderCatalog() {
    const box = $("catalogList");
    box.textContent = "";
    const filter = ($("catalogFilter").value || "").trim().toLowerCase();
    const mine = new Set(((posting && posting.member_groups) || []).map((g) => String(g.group_id)));
    const idOf = (url) => { const m = String(url || "").match(/\/groups\/([^/?#]+)/); return m ? m[1] : null; };
    const matching = catalog.filter((group) => !mine.has(idOf(group.url)) && (!filter ||
      `${group.name || ""} ${group.city || ""}`.toLowerCase().includes(filter)));
    const cities = new Map();
    matching.forEach((group) => {
      const city = group.city || "ארצי";
      if (!cities.has(city)) cities.set(city, []);
      cities.get(city).push(group);
    });
    for (const [city, groups] of cities) {
      box.appendChild(sectionHead(city, "var(--gold)"));
      groups.sort((a, b) => (b.members || 0) - (a.members || 0)).forEach((group) => box.appendChild(catalogRow(group, false)));
    }
    if (!catalog.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "אין עדיין קבוצות בקטלוג.";
      box.appendChild(note);
    }
  }

  async function loadCatalog() {
    const response = await api("/api/distribution/group-catalog");
    catalog = response.groups || [];
    renderCatalog();
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
    // The one default list, saved the moment a box is ticked.
    $("myGroups").addEventListener("change", async (ev) => {
      const box = ev.target && ev.target.dataset && ev.target.dataset.def ? ev.target : null;
      if (!box) return;
      const ids = [...$("myGroups").querySelectorAll("input[data-def]:checked")].map((i) => i.dataset.def);
      box.disabled = true;
      try {
        const r = await api("/api/posting/default-groups", { method: "PUT", body: JSON.stringify({ group_ids: ids }) });
        posting.default_group_ids = r.default_group_ids || ids;
        toast("קבוצות ברירת המחדל נשמרו ✓");
      } catch (error) { box.checked = !box.checked; toast("השמירה נכשלה, נסו שוב."); }
      finally { box.disabled = false; updateGroupCount(); }
    });
    $("resyncGroups").onclick = async function () {
      this.disabled = true; this.textContent = "מרעננים…";
      try { await api("/api/posting/groups/resync", { method: "POST", body: "{}" }); await loadMyGroups(); renderCatalog(); toast("רשימת הקבוצות עודכנה"); }
      catch (error) { toast("הרענון נכשל, נסו שוב בעוד כמה דקות."); }
      finally { this.disabled = false; this.textContent = "רענון"; }
    };
    $("suggestBtn").onclick = async () => {
      const url = $("suggestUrl").value.trim();
      if (!url) return;
      try {
        await api("/api/distribution/group-catalog/suggest", { method: "POST", body: JSON.stringify({ url }) });
        $("suggestUrl").value = "";
        await loadMyGroups();
        toast("הקבוצה נשמרה. אחרי שתצטרפו אליה ותלחצו רענון, אפשר לסמן אותה כברירת מחדל.");
      } catch (error) {
        toast(error.code === "invalid_group_url" ? "זה אינו קישור לקבוצת Facebook (facebook.com/groups/...)" : "הוספת הקבוצה נכשלה.");
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
    await loadMyGroups();
    await loadCatalog().catch(() => {});
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
    { key: "facebook", label: "פייסבוק", steps: [
      "התחברו לפייסבוק בחלון שלמטה, כמו שאתם מתחברים תמיד.",
      "אם פייסבוק שולחת קוד בסמס או מבקשת אישור — השלימו אותו באותו חלון.",
    ], copy: [
      "חיבור אחד לפייסבוק — פורלי תפרסם גם בדף העסקי וגם בקבוצות מאותו חשבון, ותקרא פוסטים מקבוצות. מתחברים כאן פעם אחת, כמו בדפדפן רגיל.",
      "בשלושת הימים הראשונים פורלי רק מסתובבת בפייסבוק מהחשבון שלכם — גוללת, צופה, מסמנת לייק פה ושם — בלי לפרסם. אחר כך פוסט אחד ביום, ובהדרגה יותר. ככה פייסבוק רואה פעילות רגילה ולא רובוט, וזה מה ששומר על החשבון שלכם.",
    ], small: "פרסום אוטומטי בקבוצות נעשה על אחריותכם — נסביר בדיוק לפני שמתחילים." },
    { key: "yad2", label: "יד2", steps: [
      "התחברו ליד2 בחלון שלמטה — בטלפון או במייל, כמו תמיד.",
      "אם יד2 שולחת קוד בסמס — הזינו אותו באותו חלון.",
    ], copy: [
      "מתחברים ליד2 כדי שפורלי תוכל לקרוא את המודעות שלכם באתר ולהציע אותן כדף נכס מוכן — פורלי לא מפרסמת דרך החשבון הזה.",
    ] },
    { key: "madlan", label: "מדלן", steps: [
      "בחלון שלמטה מופיע עמוד הבית של מדלן.",
      "לחצו על \"הרשמה/התחברות\" בראש העמוד, והתחברו כמו שאתם מתחברים תמיד — בטלפון או במייל.",
      "אם מדלן שולחת קוד בסמס — הזינו אותו באותו חלון.",
    ], copy: [
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

  // Every error the connect routes can answer, in the agent's words. A 404
  // means the feature is not switched on on this server (Driver not set up).
  function connectErrorText(e) {
    const code = e && e.code;
    if (code === "posting_disabled") {
      return e.reason === "account_disabled"
        ? "החשבון הזה מושהה אצלנו כרגע, ולכן אי אפשר לחבר אותו. הצוות שלנו יחזור אליכם."
        : "אי אפשר לחבר את החשבון כרגע — נסו שוב מאוחר יותר.";
    }
    const text = ({
      profile_busy: "פורלי משתמשת בחשבון הזה ממש עכשיו — נסו שוב בעוד כמה דקות.",
      driver_busy: "כל הדפדפנים שלנו תפוסים כרגע — נסו שוב בעוד דקה.",
      consent_required: "סמנו את האישור שמעל הכפתור.",
      extract_unavailable: "לא הצלחנו לפתוח דפדפן כרגע — נסו שוב בעוד רגע.",
      proxy_unavailable: "הדפדפן לא הצליח להתחבר לאינטרנט דרך הרשת שהוגדרה. מנהל המערכת צריך לבדוק את חיבור הפרוקסי ואז לנסות שוב.",
      browser_network_unavailable: "הדפדפן נפתח בלי חיבור תקין לאינטרנט. פורלי תסגור אותו ותנסה לפתוח דפדפן חדש פעם אחת.",
      unavailable: "", // the server has no account connection: not announced
      network: "אין חיבור לשרת — בדקו את האינטרנט ונסו שוב.",
    })[code];
    return text !== undefined ? text : "משהו השתבש — נסו שוב בעוד רגע.";
  }

  // The login browser shows inside the modal (connect-viewer.js): the server
  // relays its screen and the agent's clicks and typing, so no window opens
  // and the browser's address never reaches this page.
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const SMS_NOTE = "קיבלתם קוד בסמס? אפשר לצאת לרגע ולחזור — הדפדפן מחכה לכם כמה דקות.";
  function openBrowser(platform) {
    const row = PLATFORM_ROWS.find((r) => r.key === platform) || PLATFORM_ROWS[0];
    $("browserModalTitle").textContent = `התחברות ל${row.label}`;
    $("browserModalSub").textContent = `זה ${row.label} האמיתי, בתוך פורלי. מתחברים כרגיל — פורלי לא שומרת את הסיסמה.`;
    const steps = row.steps.concat(['כשסיימתם, לחצו "סיימתי להתחבר".']);
    bBody.innerHTML = `<details class="popup-steps-box" open><summary>איך מתחברים</summary><ol class="popup-steps">${steps.map((t) => `<li>${esc(t)}</li>`).join("")}</ol></details><div id="browserView" class="browser-view"></div>`;
    bMsg.textContent = SMS_NOTE;
    bModal.hidden = false; bOpen = true;
    window.ForlyViewer.mount($("browserView"), platform, {
      // On a phone the steps fold away once the page shows, to give it the room.
      onFrame: () => { const d = bBody.querySelector(".popup-steps-box"); if (d && window.matchMedia("(max-width: 640px)").matches) d.open = false; },
      onEnd: (code, gotFrame) => onViewerEnd(platform, code, gotFrame),
    });
  }
  function closeBrowser() { window.ForlyViewer.unmount(); bModal.hidden = true; bBody.innerHTML = ""; bOpen = false; }

  // A login browser recorded for this account that is already gone (expired,
  // or stopped at Driver): open a fresh one, once, without a second click.
  let restarted = false;
  async function onViewerEnd(platform, code, gotFrame) {
    if (!bOpen || currentPlatform !== platform || code === "connected" || code === "replaced") return;
    const expired = ["session_ended", "session_expired", "no_open_session"].includes(code);
    const network = ["proxy_unavailable", "browser_network_unavailable"].includes(code);
    if (((expired && !gotFrame) || network) && !restarted) {
      restarted = true;
      bMsg.textContent = network ? "הדפדפן נפתח בלי חיבור תקין — סוגרים ופותחים דפדפן חדש…" : "הדפדפן הקודם נסגר — פותחים חדש…";
      try { await api("/api/connections/browser/start", { method: "POST", body: JSON.stringify({ platform, consent: true }) }); openBrowser(platform); }
      catch (e) { bMsg.textContent = connectErrorText(e); }
      return;
    }
    bMsg.textContent = expired
      ? "עבר יותר מדי זמן והדפדפן נסגר. סגרו את החלון ולחצו שוב על חיבור החשבון."
      : network ? connectErrorText({ code })
      : code === "driver_busy" ? connectErrorText({ code })
        : "לא הצלחנו להציג את הדפדפן — סגרו את החלון ונסו שוב בעוד רגע.";
  }

  // The connect button's label always comes from here — never left as a
  // "working…" text. When status cannot be read, the row keeps what it last
  // knew (connected or not), so a failed check never flips it.
  const connected = {}, pending = {};
  function paintRow(platform) {
    const on = !!connected[platform];
    $(`browserConnChip_${platform}`).textContent = on ? "מחובר" : "";
    $(`browserDisconnectBtn_${platform}`).hidden = !on;
    $(`browserConnectBtn_${platform}`).textContent = on ? "חיבור מחדש" : pending[platform] ? "המשך ההתחברות" : "חיבור החשבון";
  }
  async function refreshBrowserChip(platform) {
    try {
      const j = await api(`/api/connections/browser/${platform}/status`);
      connected[platform] = j.state === "connected";
      pending[platform] = j.state === "open";
      $(`browserIdentity_${platform}`).textContent = connected[platform] && j.identity_label ? `מחובר בתור ${j.identity_label}` : "";
    } catch (e) { /* keep what we knew */ }
    paintRow(platform);
  }

  PLATFORM_ROWS.forEach(({ key: platform }) => {
    $(`browserConnectBtn_${platform}`).addEventListener("click", async function () {
      if (!$(`browserConsent_${platform}`).checked) { toast("סמנו את האישור שמעל הכפתור"); return; }
      const btn = this; btn.disabled = true; btn.textContent = "פותחים דפדפן…";
      currentPlatform = platform; restarted = false;
      try {
        // A login already under way (the agent went for the SMS and closed
        // the modal) is resumed, not replaced by a second browser.
        if (!pending[platform] || connected[platform]) await api("/api/connections/browser/start", { method: "POST", body: JSON.stringify({ platform, consent: true }) });
        pending[platform] = true;
        openBrowser(platform);
      } catch (e) {
        toast(connectErrorText(e));
      } finally {
        btn.disabled = false; paintRow(platform); // the label is back at once, whatever happened
        refreshBrowserChip(platform);
      }
    });
    $(`browserDisconnectBtn_${platform}`).addEventListener("click", async function () {
      if (!confirm("לנתק את החשבון? פורלי תפסיק להשתמש בו ותמחק את ההתחברות השמורה.")) return;
      const btn = this; btn.disabled = true;
      try { await api(`/api/connections/browser/${platform}`, { method: "DELETE" }); connected[platform] = false; toast("החשבון נותק"); }
      catch (e) { toast(e && e.code === "network" ? connectErrorText(e) : "לא הצלחנו לנתק — נסו שוב"); }
      finally { btn.disabled = false; refreshBrowserChip(platform); }
    });
  });

  $("browserDoneBtn").addEventListener("click", async function () {
    const btn = this; btn.disabled = true; bMsg.textContent = "בודקים…";
    try {
      const j = await api(`/api/connections/browser/${currentPlatform}/finish`, { method: "POST" });
      toast(j.identity_label ? `החשבון מחובר ✓ (${j.identity_label})` : "החשבון מחובר ✓");
      pending[currentPlatform] = false;
      closeBrowser(); refreshBrowserChip(currentPlatform);
    } catch (e) {
      // driver_busy: our browser budget is full, the login window is fine —
      // keep it open and just retry; never send the agent to reopen it.
      const code = e && e.code;
      bMsg.textContent = code === "driver_busy"
        ? "הדפדפן עסוק כרגע, נסו שוב בעוד דקה"
        : code === "session_expired" || code === "no_open_session"
          ? "עבר יותר מדי זמן והדפדפן נסגר. סגרו את החלון ולחצו שוב על חיבור החשבון."
          : code === "not_logged_in"
            ? "נראה שעדיין לא התחברתם — השלימו את ההתחברות בחלון ואז לחצו שוב."
            : code === "cannot_verify_login"
              ? "לא הצלחנו לוודא שההתחברות הושלמה — החלון נשאר פתוח. נסו שוב בעוד רגע, ואם זה חוזר כתבו לנו."
              : connectErrorText(e);
    } finally { btn.disabled = false; }
  });

  // Closing the window is not "give up": an agent who logged in and closed it
  // without pressing done is still logged in at Driver. Run /finish's check
  // quietly; only a confirmed login says anything.
  $("browserModalClose").addEventListener("click", async () => {
    const platform = currentPlatform;
    closeBrowser();
    if (!platform) return;
    if (pending[platform]) {
      try {
        const j = await api(`/api/connections/browser/${platform}/finish`, { method: "POST" });
        pending[platform] = false;
        toast(j.identity_label ? `החשבון מחובר ✓ (${j.identity_label})` : "החשבון מחובר ✓");
      } catch (e) { /* not logged in (or the window already gone): closing stays closing */ }
    }
    refreshBrowserChip(platform);
  });

  // If the agent leaves for the SMS and comes back, the modal is still here;
  // only when they close it explicitly is the session's fate decided by /finish.
  $("browserConnectCard").hidden = false;
  PLATFORM_ROWS.forEach(({ key }) => refreshBrowserChip(key));
})();
