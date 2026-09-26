/*
 * autopublish.js — the all-properties publishing page (autopublish.html).
 *
 * One list of the agent's properties, each with its own on/off switch and its
 * own groups: pre-picked by the server from the member groups that suit it
 * (its city, its kind of deal — GET /api/posting/properties), adjustable per
 * property. The account-level choices (mode, consent, Page, likes, new
 * properties) are made once, below the list. Every shape and rule is the
 * API's (routes/posting*.js); the Hebrew texts and halt logic are the
 * campaign card's (publish-campaign.js, window.ForlyCampaign.ui).
 *
 * Never rendered: a group URL other than an https facebook.com link, a phone,
 * a raw error message. Group names come from Facebook and are escaped.
 */
(() => {
  "use strict";
  const U = window.ForlyCampaign && window.ForlyCampaign.ui;
  const $ = (id) => document.getElementById(id);
  if (!U || !$("app")) return;

  let toastTimer = null;
  function toast(text) {
    const el = $("msg"); el.textContent = text; el.style.display = "block";
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.display = "none"; }, 4200);
  }
  const api = (path, opts) => fetch(path, Object.assign({ credentials: "include", headers: { "content-type": "application/json" } }, opts))
    .catch(() => { throw Object.assign(new Error("network"), { code: "network" }); })
    .then(async (r) => {
      if (r.status === 401) { location.href = "/"; throw new Error("unauthenticated"); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error("request failed"), { code: j.error || `http_${r.status}`, status: r.status, body: j });
      return j;
    });
  const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
  const errorText = (e) => (e && e.code === "network" ? "אין חיבור לשרת — בדקו את האינטרנט ונסו שוב." : U.errorText(e));

  let settings = null, props = [], maxActive = 3, consentGiven = false, timer = null;
  const picks = new Map(); // page_id → Set of group ids, for properties not posting yet
  const open = new Set(); // page_ids whose group panel is open
  // The post preview: shown per property, and always once before a property
  // is first switched on (its confirm button is what switches it on).
  const previewOpen = new Set(), previewed = new Set(), confirming = new Set();
  const previews = new Map(); // `${page_id}|${group_id}` → { copy, comment_link, author, group_name } | "loading" | "error"
  function previewKey(p) { return `${p.page_id}|${[...groupsOf(p)][0] || ""}`; }
  function loadPreview(p) {
    const k = previewKey(p), gid = [...groupsOf(p)][0];
    if (previews.has(k)) return;
    previews.set(k, "loading");
    api(`/api/posting/preview?page_id=${encodeURIComponent(p.page_id)}${gid ? `&group_id=${encodeURIComponent(gid)}` : ""}`)
      .then((j) => previews.set(k, j), () => previews.set(k, "error"))
      .then(renderProps);
  }
  function previewHtml(p) {
    const v = previews.get(previewKey(p)), id = U.esc(p.page_id);
    if (!v || v === "loading") return '<div class="ap-preview"><p class="camp-muted">טוענים את הפוסט…</p></div>';
    if (v === "error") return '<div class="ap-preview"><p class="ap-note">לא הצלחנו להציג את הפוסט — נסו שוב.</p></div>';
    const who = U.esc(v.author || "החשבון שלכם");
    return `<div class="ap-preview"><div class="ap-fb">
        <div class="ap-fb-head"><b>${who}</b> ◂ ${U.esc(v.group_name || "הקבוצה")}</div>
        <div class="ap-fb-body">${U.esc(v.copy)}</div>
        <div class="ap-fb-comment"><b>${who}</b> <span dir="ltr">${U.esc(v.comment_link)}</span><small>תגובה ראשונה — הקישור לדף הנכס</small></div>
      </div>
      <p class="camp-muted camp-small">כך ייראה הפוסט. הנוסח משתנה מעט מקבוצה לקבוצה, והמחיר והפרטים נלקחים מדף הנכס ברגע הפרסום.</p>
      ${confirming.has(p.page_id) ? `<button type="button" class="btn btn-gold btn-sm" data-confirm="${id}">נראה טוב — הפעלת פרסום אוטומטי</button>` : ""}</div>`;
  }
  const busy = new Set(); // page_ids with a request in flight
  const live = (c) => !!c && (c.status === "running" || c.status === "paused");
  const members = () => (settings && settings.member_groups) || [];
  const usableIds = () => members().filter(U.usable).map((g) => String(g.group_id));
  const mode = () => (document.querySelector('input[name="apMode"]:checked') || {}).value || "per_post";
  const pages = () => U.cardPages(settings);
  const pageOn = () => pages().length > 0 && !!($("apPageOn") || {}).checked;
  const withPage = () => pageOn() && (pages().length === 1 || !!($("apPageSelect") || {}).value);
  const DEAL = { sale: "למכירה", rent: "להשכרה" };

  // The groups a property posts to: its campaign's while it runs; otherwise
  // what the agent ticked here, first the server's picks (up to five).
  function groupsOf(p) {
    if (live(p.campaign)) return new Set((p.campaign.groups || []).map((g) => String(g.group_id)));
    if (!picks.has(p.page_id)) {
      const ok = new Set(usableIds());
      picks.set(p.page_id, new Set((p.fit_group_ids || []).map(String).filter((id) => ok.has(id)).slice(0, 5)));
    }
    return picks.get(p.page_id);
  }

  function statusOf(p) {
    const c = p.campaign;
    if (!live(c)) return { cls: "", text: c && c.status === "completed" ? "כבוי · הסבב הקודם הושלם" : "כבוי" };
    if (c.status === "paused" || /^posting_disabled:/.test(c.wait_reason || "")) return { cls: "warn", text: "מושהה" };
    const posts = Array.isArray(c.posts) ? c.posts : [];
    const pending = posts.filter((x) => x.status === "pending_approval");
    if (pending.length) return { cls: "warn", text: `ממתין לאישור שלכם (${pending.length}) — בוואטסאפ או ב"פרטים ואישורים"` };
    const next = posts.filter((x) => x.status === "scheduled").sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
    const done = posts.filter((x) => x.status === "posted").length;
    const head = `פעיל · ${done} פורסמו`;
    return { cls: "live", text: next ? `${head} · הבא: ${U.fmt(next.scheduled_at)}` : `${head} · ${U.waitText(c.wait_reason)}` };
  }

  function propHtml(p) {
    const on = live(p.campaign), ids = groupsOf(p), st = statusOf(p), id = U.esc(p.page_id);
    const fit = new Set((p.fit_group_ids || []).map(String));
    const thumb = /^https:\/\//.test(p.thumb_url || "") ? `<img class="ap-thumb" src="${U.esc(p.thumb_url)}" alt="" loading="lazy">` : '<div class="ap-thumb"></div>';
    const where = [p.city, DEAL[p.listing_type]].filter(Boolean).map(U.esc).join(" · ");
    const none = !on && !ids.size ? `<p class="ap-note">לא מצאנו קבוצה שלכם שמתאימה ל${U.esc(p.city || "נכס הזה")} — בחרו קבוצות.</p>` : "";
    const panel = !open.has(p.page_id) ? "" : `<div class="ap-groups"><div class="camp-groups">` +
      (members().filter(U.usable).map((g) => {
        const gid = String(g.group_id), checked = ids.has(gid);
        return `<div class="camp-g${checked ? " on" : ""}"><label><input type="checkbox" data-page="${id}" data-group="${U.esc(gid)}"${checked ? " checked" : ""}>` +
          ` <span class="camp-gn">${U.esc(g.name)}</span> <small>${fit.has(gid) ? `מתאימה ל${U.esc(p.city || "נכס")} · ` : ""}${U.esc(U.groupNote(g))}</small></label></div>`;
      }).join("") || '<p class="camp-muted">אין קבוצות ברשימה. רעננו את הקבוצות בהגדרות למטה.</p>') + "</div>" +
      (on ? `<button type="button" class="btn btn-gold btn-sm" data-save="${id}" style="margin-top:8px">שמירה והתחלת סבב חדש</button>` : "") + "</div>";
    return `<div class="ap-prop${on ? " on" : ""}">
      <div class="ap-top">${thumb}
        <div class="ap-main"><div class="ap-title">${U.esc(p.title || "נכס")}</div><div class="ap-meta">${where}</div>
          <div class="ap-status ${st.cls}">${U.esc(st.text)}</div></div>
        <label class="ap-switch"><span>פרסום אוטומטי</span><span class="switch"><input type="checkbox" data-toggle="${id}"${on ? " checked" : ""}${busy.has(p.page_id) ? " disabled" : ""}><i></i></span></label>
      </div>${none}
      <div class="ap-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-groups="${id}">קבוצות (${ids.size})</button>
        <button type="button" class="btn btn-ghost btn-sm" data-preview="${id}">${previewOpen.has(p.page_id) ? "הסתרת התצוגה" : "תצוגה מקדימה של הפוסט"}</button>
        <a class="btn btn-ghost btn-sm" href="/publish.html?page=${encodeURIComponent(p.page_id)}">שיתוף ידני</a>
        ${p.campaign ? `<a class="btn btn-ghost btn-sm" href="/publish.html?page=${encodeURIComponent(p.page_id)}#campaignCard">פרטים ואישורים</a>` : ""}
      </div>${previewOpen.has(p.page_id) ? previewHtml(p) : ""}${panel}</div>`;
  }

  function renderProps() {
    const liveCount = props.filter((p) => live(p.campaign)).length;
    $("apCount").textContent = props.length ? `${liveCount} מתוך ${maxActive} נכסים בפרסום אוטומטי (אפשר עד ${maxActive} בו-זמנית)` : "";
    $("apProps").innerHTML = props.map(propHtml).join("") ||
      '<p class="camp-muted">עוד אין נכסים עם דף פעיל. <a href="/create.html">יצירת נכס חדש</a></p>';
    const h = U.haltInfo(settings && settings.halt_state, props.map((p) => p.campaign).find(live) || null);
    $("apHalt").hidden = !h;
    if (h) {
      $("apHalt").className = `camp-halt camp-halt-${h.cls}`;
      $("apHaltMsg").textContent = h.text;
      $("apHaltBrowserBtn").hidden = !(h.reconnect || h.verify);
      $("apHaltBrowserBtn").textContent = h.verify ? "השלמת האימות" : "חיבור החשבון מחדש";
      $("apResumeBtn").hidden = !(h.resume || h.reconsent);
      $("apResumeBtn").textContent = h.reconsent ? "אישור מחדש והמשך" : "להמשיך";
      $("apResumeBtn").dataset.reconsent = h.reconsent ? "1" : "";
    }
    $("apNeedConnect").hidden = !!(settings && settings.connected);
    $("apFirstPost").textContent = settings && settings.connected ? U.estimateText(settings.first_post_estimate, settings.first_post_wait_reason) : "";
  }

  function renderSettings() {
    const ms = members();
    $("apMemberGroups").innerHTML = ms.map((g) => {
      const id = U.esc(g.group_id);
      return `<div class="camp-g${U.usable(g) ? "" : " off"}"><span class="camp-gn">${U.esc(g.name)}</span> <small>${U.esc(U.groupNote(g))}</small>` +
        `<button type="button" class="camp-x" data-rm="${id}" title="הסרה מהרשימה" aria-label="הסרת הקבוצה מהרשימה">×</button></div>`;
    }).join("") || '<p class="camp-muted">לא מצאנו קבוצות בחשבון. הצטרפו לכמה מהקבוצות למטה ולחצו "רענון".</p>';
    const hidden = settings.hidden_group_ids || [];
    $("apUnhide").hidden = !hidden.length;
    $("apUnhide").textContent = `החזרת ${hidden.length === 1 ? "קבוצה אחת" : `${hidden.length} קבוצות`} שהסרתם`;
    const sug = (settings.suggested_groups || []).filter((g) => U.fbUrl(g.url));
    $("apSuggested").innerHTML = sug.map((g) => `<div class="camp-s"><span>${U.esc(g.name || "קבוצה")}${g.city ? ` · ${U.esc(g.city)}` : ""}` +
      `${g.members ? ` · ~${Math.max(1, Math.round(g.members / 1000))}K` : ""}</span> <a href="${U.esc(U.fbUrl(g.url))}" target="_blank" rel="noopener noreferrer">הצטרפות ↗</a></div>`).join("") ||
      '<p class="camp-muted">אין כרגע הצעות לאזור שלכם.</p>';
    const perm = settings.permission || {};
    $("apConsentRow").hidden = consentGiven; $("apConsentDone").hidden = !consentGiven;
    $("apConsentOld").hidden = consentGiven || !perm.consent_version;
    $("apConsentVer").textContent = settings.consent_version || "";
  }

  function renderPages(chosen) {
    const ps = pages(), box = $("apPageTarget");
    box.innerHTML = !ps.length ? "" : `<label class="camp-consent"><input type="checkbox" id="apPageOn"> <span><strong>גם בדף העסקי</strong>` +
      `<small>${ps.length === 1 ? `${U.esc(ps[0].name)} · ` : ""}כל נכס שתפעילו יתפרסם גם בדף. אם כבר פרסמתם אותו שם ידנית, אל תסמנו — שלא יעלה פעמיים.</small></span></label>` +
      (ps.length > 1 ? `<label class="camp-page-pick" hidden>באיזה דף: <select id="apPageSelect"><option value="">בחרו דף…</option>` +
        ps.map((p) => `<option value="${U.esc(p.id)}"${p.id === chosen ? " selected" : ""}>${U.esc(p.name)}</option>`).join("") + "</select></label>" : "");
    if (ps.length) $("apPageOn").addEventListener("change", () => { const l = box.querySelector(".camp-page-pick"); if (l) l.hidden = !$("apPageOn").checked; });
  }

  function applySettings(s) {
    settings = s;
    const perm = s.permission || {};
    consentGiven = perm.enabled === true && perm.consent_current === true;
  }

  async function loadAll() {
    const [s, p] = await Promise.all([api("/api/posting/settings"), api("/api/posting/properties")]);
    applySettings(s);
    props = p.properties || []; maxActive = p.max_active || 3;
  }
  async function refresh() {
    try { await loadAll(); renderProps(); renderSettings(); } catch (e) { /* the next poll tries again */ }
  }

  // The account-level choices, under the consent. Auto-enroll keeps every
  // usable member group as the pool; enrollment narrows it per property.
  function settingsBody() {
    const auto = $("apAutoEnroll").checked, targets = withPage() ? ["page", "groups"] : ["groups"];
    const b = {
      enabled: true, consent: true, consent_version: settings.consent_version, auto_mode: mode(),
      default_group_ids: auto ? usableIds() : [], targets: auto ? targets : ["groups"], allows_visible_interactions: $("apVisible").checked,
    };
    const sel = pageOn() && $("apPageSelect");
    if (sel && sel.value) b.page_id = sel.value;
    else if (pageOn() && pages().length === 1) b.page_id = pages()[0].id;
    return b;
  }
  function needConsent() {
    if (consentGiven || $("apConsent").checked) return false;
    toast("סמנו את האישור בתחתית העמוד"); $("apConsentRow").scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  async function start(p, ids) {
    const unknown = members().some((g) => ids.includes(String(g.group_id)) && g.agent_policy === "unknown");
    const targets = withPage() ? ["page", "groups"] : ["groups"];
    await put("/api/posting/settings", settingsBody());
    await post("/api/posting/campaigns", {
      page_id: p.page_id, group_ids: ids, mode: mode(), days: 14, repeat: false, targets, consent: true,
      consent_version: settings.consent_version, include_unknown: unknown,
      account_aged: $("apAged").checked, posted_manually: $("apManual").checked,
    });
    consentGiven = true;
  }

  async function withBusy(p, fn) {
    busy.add(p.page_id); renderProps();
    try { await fn(); }
    catch (e) {
      const bad = (e && e.body && e.body.group_ids) || [];
      if (bad.length && picks.has(p.page_id)) bad.forEach((id) => picks.get(p.page_id).delete(String(id)));
      if (e && e.code === "consent_outdated") { consentGiven = false; $("apConsent").checked = false; }
      toast(errorText(e));
    } finally { busy.delete(p.page_id); await refresh(); }
  }

  async function toggle(p, on) {
    if (on) {
      if (!settings.connected) { toast("קודם חברו את החשבון האישי שלכם בפייסבוק."); return renderProps(); }
      const ids = [...groupsOf(p)];
      if (!ids.length) { open.add(p.page_id); toast("בחרו לפחות קבוצה אחת לנכס הזה"); return renderProps(); }
      if (!previewed.has(p.page_id)) {
        previewOpen.add(p.page_id); confirming.add(p.page_id); loadPreview(p);
        toast("בדקו את הפוסט ואשרו כדי להפעיל"); return renderProps();
      }
      if (pageOn() && !withPage()) { $("apSettings").open = true; toast("בחרו באיזה דף עסקי לפרסם, או בטלו את \"גם בדף העסקי\""); return renderProps(); }
      if (needConsent()) return renderProps();
      return withBusy(p, async () => { await start(p, ids); open.delete(p.page_id); toast("התחלנו ✓ אפשר לעצור בכל רגע"); });
    }
    // STOP: always allowed, whatever the switches or halts say (routes/posting.js).
    if (!confirm("לעצור את הפרסום של הנכס הזה? מה שכבר עלה נשאר בקבוצות. אפשר להפעיל שוב מתי שתרצו.")) return renderProps();
    return withBusy(p, async () => { await post(`/api/posting/campaigns/${encodeURIComponent(p.campaign.id)}/stop`); toast("הפרסום של הנכס נעצר"); });
  }

  // A running property's groups change by starting a new pass with them:
  // STOP, then the same create call (posting-campaign restarts a stopped one).
  async function saveGroups(p) {
    const box = document.querySelectorAll(`input[data-page="${CSS.escape(p.page_id)}"]:checked`);
    const ids = [...box].map((i) => i.dataset.group);
    if (!ids.length) return toast("בחרו לפחות קבוצה אחת");
    if (needConsent()) return;
    if (!confirm("לשמור את הקבוצות? הפרסום של הנכס יתחיל סבב חדש איתן. מה שכבר עלה נשאר.")) return;
    await withBusy(p, async () => {
      await post(`/api/posting/campaigns/${encodeURIComponent(p.campaign.id)}/stop`);
      await start(p, ids);
      open.delete(p.page_id); toast("הקבוצות נשמרו ✓");
    });
  }

  // ── wiring ──
  const byId = (id) => props.find((p) => p.page_id === id);
  $("apProps").addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.dataset.toggle && byId(t.dataset.toggle)) return toggle(byId(t.dataset.toggle), t.checked);
    if (t.dataset.page && t.dataset.group) {
      const p = byId(t.dataset.page);
      if (p && !live(p.campaign)) { const s = groupsOf(p); if (t.checked) s.add(t.dataset.group); else s.delete(t.dataset.group); renderProps(); }
    }
  });
  $("apProps").addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest("button"); if (!b) return;
    if (b.dataset.groups) { if (open.has(b.dataset.groups)) open.delete(b.dataset.groups); else open.add(b.dataset.groups); renderProps(); }
    if (b.dataset.save && byId(b.dataset.save)) saveGroups(byId(b.dataset.save));
    if (b.dataset.preview && byId(b.dataset.preview)) {
      const p = byId(b.dataset.preview);
      if (previewOpen.has(p.page_id)) { previewOpen.delete(p.page_id); confirming.delete(p.page_id); } else { previewOpen.add(p.page_id); loadPreview(p); }
      renderProps();
    }
    if (b.dataset.confirm && byId(b.dataset.confirm)) {
      const p = byId(b.dataset.confirm);
      previewed.add(p.page_id); confirming.delete(p.page_id); previewOpen.delete(p.page_id);
      toggle(p, true);
    }
  });
  $("apMemberGroups").addEventListener("click", async (ev) => {
    const b = ev.target.closest && ev.target.closest("button[data-rm]"); if (!b) return;
    if (!confirm("להסיר את הקבוצה מהרשימה? פורלי לא תפרסם בה בשום נכס. אפשר להחזיר אותה אחר כך.")) return;
    b.disabled = true;
    try {
      const j = await api(`/api/posting/groups/${encodeURIComponent(b.dataset.rm)}`, { method: "DELETE" });
      settings.member_groups = j.member_groups || []; settings.hidden_group_ids = j.hidden_group_ids || [];
      picks.forEach((s) => s.delete(b.dataset.rm)); renderSettings(); renderProps(); toast("הקבוצה הוסרה מהרשימה");
    } catch (e) { b.disabled = false; toast(errorText(e)); }
  });
  $("apUnhide").addEventListener("click", async function () {
    this.disabled = true;
    try {
      for (const id of settings.hidden_group_ids || []) settings.hidden_group_ids = (await post(`/api/posting/groups/${encodeURIComponent(id)}/unhide`)).hidden_group_ids || [];
      toast("הקבוצות יחזרו לרשימה ברענון הבא");
    } catch (e) { toast(errorText(e)); }
    finally { this.disabled = false; renderSettings(); }
  });
  $("apResync").addEventListener("click", async function () {
    this.disabled = true; this.textContent = "מרעננים…";
    try { await post("/api/posting/groups/resync"); picks.clear(); await refresh(); toast("רשימת הקבוצות עודכנה"); }
    catch (e) { toast(errorText(e)); }
    finally { this.disabled = false; this.textContent = "רענון"; }
  });
  $("apSaveSettings").addEventListener("click", async function () {
    if (needConsent()) return;
    this.disabled = true;
    try { applySettings(Object.assign({}, settings, { permission: (await put("/api/posting/settings", settingsBody())).permission })); renderSettings(); toast("ההגדרות נשמרו ✓"); }
    catch (e) { if (e && e.code === "consent_outdated") { consentGiven = false; $("apConsent").checked = false; renderSettings(); } toast(errorText(e)); }
    finally { this.disabled = false; }
  });
  $("apResumeBtn").addEventListener("click", async function () {
    if (this.dataset.reconsent) {
      if (!confirm($("apConsentText").textContent.trim())) return;
      try { await put("/api/posting/settings", Object.assign(settingsBody(), { consent: true })); }
      catch (e) { return toast(errorText(e)); }
    }
    this.disabled = true;
    try {
      for (const p of props) if (p.campaign && p.campaign.status === "paused") await post(`/api/posting/campaigns/${encodeURIComponent(p.campaign.id)}/resume`);
      toast("ממשיכים ✓");
    } catch (e) { toast(errorText(e)); }
    finally { this.disabled = false; await refresh(); }
  });

  (async () => {
    try { await loadAll(); }
    catch (e) {
      $("loading").innerHTML = `<p class="sub">${U.esc(e && e.code === "http_404" ? "הפרסום האוטומטי עדיין לא זמין בשרת הזה." : errorText(e))}</p>`;
      return;
    }
    const perm = settings.permission || {};
    $("apAutoEnroll").checked = perm.enabled === true && (perm.default_group_ids || []).length > 0;
    $("apVisible").checked = perm.allows_visible_interactions === true;
    const m = document.querySelector(`input[name="apMode"][value="${perm.auto_mode === "standing" ? "standing" : "per_post"}"]`); if (m) m.checked = true;
    renderPages(perm.page_id);
    $("apFirstWeek").textContent = U.FIRST_WEEK;
    $("apReach").textContent = U.REACH_NOTE;
    $("apSettings").open = !consentGiven;
    renderProps(); renderSettings();
    $("loading").style.display = "none"; $("app").hidden = false;
    // Statuses move on their own (a post goes out, an approval arrives).
    timer = setInterval(() => { if (document.visibilityState === "visible" && props.some((p) => live(p.campaign))) refresh(); }, 60000);
  })();
})();
