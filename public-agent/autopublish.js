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
  const previews = new Map(); // `${page_id}|${group_id}` → exact copy + disclosed destination | "loading" | "error"
  function previewKey(p) { return `${p.page_id}|${[...groupsOf(p)][0] || ""}`; }
  function loadPreview(p) {
    // Manual posting: the agent approves every group's text, so every group is loaded.
    const gids = settings && settings.manual ? [...groupsOf(p)] : [[...groupsOf(p)][0]];
    for (const gid of gids) {
      const k = `${p.page_id}|${gid || ""}`;
      if (previews.has(k)) continue;
      previews.set(k, "loading");
      api(`/api/posting/preview?page_id=${encodeURIComponent(p.page_id)}${gid ? `&group_id=${encodeURIComponent(gid)}` : ""}`)
        .then((j) => previews.set(k, j), () => previews.set(k, "error"))
        .then(renderProps);
    }
  }
  // Manual posting: one editable text per group, approved together.
  function manualPreviewHtml(p) {
    const name = (gid) => (members().find((g) => String(g.group_id) === gid) || {}).name || "קבוצה";
    const cards = [...groupsOf(p)].map((gid) => {
      const v = previews.get(`${p.page_id}|${gid}`);
      if (!v || v === "loading") return `<div class="ap-fb"><p class="camp-muted">טוענים את הפוסט ל${U.esc(name(gid))}…</p></div>`;
      if (v === "error") return `<div class="ap-fb"><p class="ap-note">לא הצלחנו להציג את הפוסט ל${U.esc(name(gid))}. נסו שוב.</p></div>`;
      return `<div class="ap-fb"><div class="ap-fb-head"><b>${U.esc(v.author || "החשבון שלכם")}</b> ◂ ${U.esc(v.group_name || name(gid))}</div>${copyBox(`${p.page_id}|${gid}`, v.copy)}</div>`;
    }).join("");
    const v0 = previews.get(`${p.page_id}|${[...groupsOf(p)][0]}`);
    const video = v0 && /^https?:\/\//.test(v0.video_url || "") ? `<video class="ap-fb-video" controls playsinline preload="metadata" src="${U.esc(v0.video_url)}"></video>` : "";
    return `<div class="ap-preview">${cards}${video}
      <p class="camp-muted camp-small">זה הנוסח שיעלה לכל קבוצה, עם הסרטון של הנכס. אפשר לערוך כל אחד. אחרי האישור לא נבקש אישור נוסף, ובסוף תקבלו הודעת וואטסאפ עם הקבוצות שבהן פורסם.</p>
      ${repeatHtml(p.page_id)}
      <button type="button" class="btn btn-gold btn-sm" data-confirm="${U.esc(p.page_id)}">אישור והתחלת הפרסום</button></div>`;
  }
  function previewHtml(p) {
    if (settings && settings.manual && confirming.has(p.page_id)) return manualPreviewHtml(p);
    const v = previews.get(previewKey(p)), id = U.esc(p.page_id);
    if (!v || v === "loading") return '<div class="ap-preview"><p class="camp-muted">טוענים את הפוסט…</p></div>';
    if (v === "error") return '<div class="ap-preview"><p class="ap-note">לא הצלחנו להציג את הפוסט — נסו שוב.</p></div>';
    const who = U.esc(v.author || "החשבון שלכם");
    // The link is part of the post's own text now; a separate comment only when it is not.
    const comment = !v.comment_link || String(v.copy || "").includes(v.comment_link) ? ""
      : `<div class="ap-fb-comment"><b>${who}</b> <span dir="ltr">${U.esc(v.comment_link)}</span><small>תגובה ראשונה</small></div>`;
    return `<div class="ap-preview"><div class="ap-fb">
        <div class="ap-fb-head"><b>${who}</b> ◂ ${U.esc(v.group_name || "הקבוצה")}</div>
        ${confirming.has(p.page_id) && mode() === "per_post" ? copyBox(p.page_id, v.copy) : `<div class="ap-fb-body">${U.esc(v.copy)}</div>`}
        ${/^https?:\/\//.test(v.video_url || "") ? `<video class="ap-fb-video" controls playsinline preload="metadata" src="${U.esc(v.video_url)}"${/^https?:\/\//.test(v.poster_url || "") ? ` poster="${U.esc(v.poster_url)}"` : ""}></video>` : ""}
        ${comment}
      </div>
      <p class="ap-note">${U.esc(v.link_notice || U.linkNotice(v.link_kind))}</p>
      <p class="camp-muted camp-small">כך ייראה הפוסט. הנוסח משתנה מעט מקבוצה לקבוצה, והמחיר והפרטים נלקחים מדף הנכס ברגע הפרסום.</p>
      <p class="ap-note"><b>יפורסם בקבוצות (${groupsOf(p).size}):</b> ${members().filter((g) => groupsOf(p).has(String(g.group_id))).map((g) => U.esc(g.name)).join(" · ") || "—"}</p>
      ${confirming.has(p.page_id) ? repeatHtml(p.page_id) : ""}
      ${confirming.has(p.page_id) && mode() === "per_post" ? whenHtml(p.page_id)
    + '<p class="camp-muted camp-small">האישור כאן הוא האישור של הפוסט הראשון. הפוסטים לשאר הקבוצות יופיעו כאן, בשורה של הנכס, לאישור שלכם.</p>' : ""}
      ${confirming.has(p.page_id) ? `<button type="button" class="btn btn-gold btn-sm" data-confirm="${id}">אישור והפעלת פרסום אוטומטי</button>` : ""}</div>`;
  }
  // What the agent typed or chose, kept across re-renders: the text of a post
  // and when it should go out. Keyed by page_id (before starting) or page|post.
  const drafts = new Map();
  const draftOf = (k) => { if (!drafts.has(k)) drafts.set(k, { when: { k: "asap", day: 1, hour: 9 } }); return drafts.get(k); };
  const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
  const atHour = (dayOffset, hour) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(hour, 0, 0, 0); return d; };
  // Before 06:00 the agent's "tomorrow" is the coming morning, not the day after
  // (a post approved at 00:04 Sunday for "tomorrow morning" went up on Monday).
  const night = () => new Date().getHours() < 6;
  const tomorrow = () => (night() ? 0 : 1);
  // → ISO for the chosen moment, or null for "as soon as possible" (and for a moment already past).
  function whenIso(w) {
    const d = w.k === "t19" ? atHour(0, 19) : w.k === "m09" ? atHour(tomorrow(), 9) : w.k === "m19" ? atHour(tomorrow(), 19) : w.k === "custom" ? atHour(w.day, w.hour) : null;
    return d && d > new Date() ? d.toISOString() : null;
  }
  function whenHtml(key) {
    const w = draftOf(key).when, k = U.esc(key);
    const chip = (id, label) => `<button type="button" class="when-chip${w.k === id ? " on" : ""}" data-when="${k}" data-k="${id}">${label}</button>`;
    let custom = "";
    if (w.k === "custom") {
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = atHour(i, 12);
        return `<button type="button" class="when-day${w.day === i ? " on" : ""}" data-when="${k}" data-day="${i}"><small>${i === 0 ? "היום" : i === 1 ? "מחר" : `יום ${DAY_NAMES[d.getDay()]}`}</small><b>${d.getDate()}.${d.getMonth() + 1}</b></button>`;
      }).join("");
      const hours = Array.from({ length: 15 }, (_, i) => i + 8).map((h) =>
        `<button type="button" class="when-hour${w.hour === h ? " on" : ""}" data-when="${k}" data-hour="${h}">${String(h).padStart(2, "0")}:00</button>`).join("");
      custom = `<div class="when-strip">${days}</div><div class="when-strip">${hours}</div>`;
    }
    const iso = whenIso(w);
    return `<div class="when"><div class="when-title">מתי לפרסם</div><div class="when-chips">` +
      chip("asap", "בהקדם") + (!night() && new Date().getHours() < 19 ? chip("t19", "היום בערב") : "") + chip("m09", "מחר בבוקר") + chip("m19", "מחר בערב") + chip("custom", "מועד אחר") +
      `</div>${custom}<div class="when-sum">${iso ? `יעלה ${U.esc(U.fmt(iso))}` : "יעלה בהקדם האפשרי, לפי הקצב של החשבון"}</div></div>`;
  }
  // How often the property returns to its groups: once, or every N days.
  const repeatOf = (key) => { const d = draftOf(key); if (!d.repeat) d.repeat = { k: "once", n: 4 }; return d.repeat; };
  const repeatDays = (key) => { const r = repeatOf(key); return r.k === "once" ? null : r.k === "custom" ? r.n : Number(r.k); };
  const everyText = (n) => (n === 7 ? "כל שבוע" : n === 14 ? "כל שבועיים" : `כל ${n} ימים`);
  function repeatHtml(key) {
    const r = repeatOf(key), k = U.esc(key);
    const chip = (id, label) => `<button type="button" class="when-chip${String(r.k) === String(id) ? " on" : ""}" data-repeat="${k}" data-k="${id}">${label}</button>`;
    const custom = r.k !== "custom" ? "" : `<div class="when-strip">${[4, 5, 6, 10, 21, 30].map((n) =>
      `<button type="button" class="when-hour${r.n === n ? " on" : ""}" data-repeat="${k}" data-n="${n}">${n} ימים</button>`).join("")}</div>`; // never under 3: the same property returns to a group only after 3 days
    const n = repeatDays(key);
    return `<div class="when"><div class="when-title">חזרה על הפרסום</div><div class="when-chips">` +
      chip("once", "פעם אחת") + chip(3, "כל 3 ימים") + chip(7, "כל שבוע") + chip(14, "כל שבועיים") + chip("custom", "קצב אחר") +
      `</div>${custom}<div class="when-sum">${n ? `הנכס יחזור לכל קבוצה ${everyText(n)}, עד 30 יום או עד שתעצרו.` : "הנכס יעלה פעם אחת בכל קבוצה."}</div></div>`;
  }
  const copyBox = (key, original) => `<textarea class="camp-copy" dir="auto" maxlength="3000" rows="${Math.min(14, String(original).split("\n").length + 2)}" data-draft="${U.esc(key)}">` +
    `${U.esc(typeof draftOf(key).copy === "string" ? draftOf(key).copy : original)}</textarea>`;
  const approveBody = (key, original) => {
    const d = draftOf(key), body = {}, iso = whenIso(d.when);
    if (typeof d.copy === "string" && d.copy.trim() && d.copy !== original) body.copy = d.copy;
    if (iso) body.scheduled_at = iso;
    return body;
  };
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
      const no = new Set((p.excluded_group_ids || []).map(String));
      picks.set(p.page_id, new Set((p.fit_group_ids || []).map(String).filter((id) => ok.has(id) && !no.has(id)).slice(0, 5)));
    }
    return picks.get(p.page_id);
  }

  function statusOf(p) {
    const c = p.campaign;
    if (!live(c)) return { cls: "", text: c && c.status === "completed" ? "כבוי · הסבב הקודם הושלם" : "כבוי" };
    if (c.status === "paused" || /^posting_disabled:/.test(c.wait_reason || "")) return { cls: "warn", text: "מושהה" };
    const posts = Array.isArray(c.posts) ? c.posts : [];
    const pending = posts.filter((x) => x.status === "pending_approval");
    if (pending.length) return { cls: "warn", text: `ממתין לאישור שלכם (${pending.length}) — כאן למטה או בוואטסאפ` };
    const next = posts.filter((x) => x.status === "scheduled").sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
    const done = posts.filter((x) => x.status === "posted").length;
    const head = `פעיל · ${done} פורסמו${c.repeat_days ? ` · חוזר ${everyText(c.repeat_days)}` : ""}`;
    return { cls: "live", text: next ? `${head} · הבא: ${U.fmt(next.scheduled_at)}` : `${head} · ${U.waitText(c.wait_reason)}` };
  }

  // Posts waiting for the agent, right in the property's row: the text (editable), the time, approve or skip.
  function approvalsHtml(p) {
    if (!live(p.campaign)) return "";
    return (p.campaign.posts || []).filter((x) => x.status === "pending_approval" && typeof x.copy === "string").map((x) => {
      const key = `${p.page_id}|${x.id}`, k = U.esc(key);
      return `<div class="ap-approve"><div class="ap-approve-head">לאישור שלכם · <b>${U.esc(x.group_name || "הקבוצה")}</b></div>${copyBox(key, x.copy)}${whenHtml(key)}` +
        `<div class="camp-row-actions"><button type="button" class="btn btn-gold btn-sm" data-approve="${k}">אישור ופרסום</button>` +
        `<button type="button" class="btn btn-ghost btn-sm" data-skip="${k}">דילוג</button></div></div>`;
    }).join("");
  }
  // The last few posts that went out or did not: where, what happened, the link.
  function recentHtml(p) {
    const done = ((p.campaign && p.campaign.posts) || []).filter((x) => ["posted", "pending_group_approval", "failed", "unknown", "scheduled"].includes(x.status)).slice(-4).reverse();
    if (!done.length) return "";
    return `<ul class="ap-recent">${done.map((x) => `<li><span>${U.esc(x.group_name || "הקבוצה")}</span> · ${U.esc(U.statusText(x))}` +
      `${x.status === "scheduled" ? ` · ${U.esc(U.fmt(x.scheduled_at))}` : ""}` +
      `${/^https:\/\//.test(x.post_url || "") ? ` · <a href="${U.esc(x.post_url)}" target="_blank" rel="noopener noreferrer">לפוסט ↗</a>` : ""}</li>`).join("")}</ul>`;
  }

  function propHtml(p) {
    const on = live(p.campaign), ids = groupsOf(p), st = statusOf(p), id = U.esc(p.page_id);
    const fit = new Set((p.fit_group_ids || []).map(String)), excluded = new Set((p.excluded_group_ids || []).map(String));
    const thumb = /^https:\/\//.test(p.thumb_url || "") ? `<img class="ap-thumb" src="${U.esc(p.thumb_url)}" alt="" loading="lazy">` : '<div class="ap-thumb"></div>';
    const where = [p.city, DEAL[p.listing_type]].filter(Boolean).map(U.esc).join(" · ");
    const none = !on && !ids.size ? `<p class="ap-note">לא מצאנו קבוצה שלכם שמתאימה ל${U.esc(p.city || "נכס הזה")} — בחרו קבוצות.</p>` : "";
    const panel = !open.has(p.page_id) ? "" : `<div class="ap-groups"><div class="camp-groups">` +
      (members().filter(U.usable).map((g) => {
        const gid = String(g.group_id), checked = ids.has(gid);
        // A group the server refuses for this property's deal is shown, never tickable.
        if (excluded.has(gid) && !checked) {
          return `<div class="camp-g off"><label><input type="checkbox" disabled> <span class="camp-gn">${U.esc(g.name)}</span>` +
            ` <small>לא מתאימה ל${U.esc(DEAL[p.listing_type] ? `נכס ${DEAL[p.listing_type]}` : "סוג העסקה")}</small></label></div>`;
        }
        return `<div class="camp-g${checked ? " on" : ""}"><label><input type="checkbox" data-page="${id}" data-group="${U.esc(gid)}"${checked ? " checked" : ""}>` +
          ` <span class="camp-gn">${U.esc(g.name)}</span> <small>${fit.has(gid) ? `מתאימה ל${U.esc(p.city || "נכס")} · ` : ""}${U.esc(U.groupNote(g))}</small></label></div>`;
      }).join("") || '<p class="camp-muted">אין קבוצות ברשימה. רעננו את הקבוצות בהגדרות למטה.</p>') + "</div>" +
      (on ? `<button type="button" class="btn btn-gold btn-sm" data-save="${id}" style="margin-top:8px">שמירה והתחלת סבב חדש</button>` : "") + "</div>";
    return `<div class="ap-prop${on ? " on" : ""}">
      <div class="ap-top">${thumb}
        <div class="ap-main"><div class="ap-title">${U.esc(p.title || "נכס")}</div><div class="ap-meta">${where}</div>
          <div class="ap-status ${st.cls}">${U.esc(st.text)}</div></div>
        <label class="ap-switch"><span>פרסום אוטומטי</span><span class="switch"><input type="checkbox" data-toggle="${id}"${on || confirming.has(p.page_id) || busy.has(p.page_id) ? " checked" : ""}${busy.has(p.page_id) ? " disabled" : ""}><i></i></span></label>
      </div>${none}
      <div class="ap-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-groups="${id}">קבוצות (${ids.size})</button>
        <button type="button" class="btn btn-ghost btn-sm" data-preview="${id}">${previewOpen.has(p.page_id) ? "הסתרת התצוגה" : "תצוגה מקדימה של הפוסט"}</button>
        <a class="btn btn-ghost btn-sm" href="/publish.html?page=${encodeURIComponent(p.page_id)}">שיתוף ידני</a>
      </div>${approvalsHtml(p)}${recentHtml(p)}${previewOpen.has(p.page_id) ? previewHtml(p) : ""}${panel}</div>`;
  }

  // Properties in a live campaign always come first; within each part, the
  // agent's chosen order (newest first by default, remembered on this device).
  const SORTS = {
    new: (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")),
    old: (a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")),
    price_desc: (a, b) => (b.price || 0) - (a.price || 0),
    price_asc: (a, b) => (a.price || Infinity) - (b.price || Infinity),
    city: (a, b) => String(a.city || "").localeCompare(String(b.city || ""), "he"),
  };
  let sortBy = "new";
  try { const s = localStorage.getItem("ap_sort"); if (SORTS[s]) sortBy = s; } catch (e) { /* storage off */ }
  const sorted = () => props.slice().sort((a, b) => (live(b.campaign) - live(a.campaign)) || SORTS[sortBy](a, b) || SORTS.new(a, b));

  function renderProps() {
    const liveCount = props.filter((p) => live(p.campaign)).length;
    $("apCount").textContent = props.length ? `${liveCount} מתוך ${maxActive} נכסים בפרסום אוטומטי (אפשר עד ${maxActive} בו-זמנית)` : "";
    $("apProps").innerHTML = sorted().map(propHtml).join("") ||
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
    const defs = new Set((settings.default_group_ids || []).map(String));
    $("apMemberGroups").innerHTML = ms.map((g) => {
      const id = U.esc(g.group_id);
      return `<div class="camp-g${U.usable(g) ? "" : " off"}"><span class="camp-gn">${U.esc(g.name)}</span> <small>${U.esc(U.groupNote(g))}</small>` +
        ` <label class="ap-def"><input type="checkbox" data-def="${id}"${defs.has(String(g.group_id)) ? " checked" : ""}${U.usable(g) ? "" : " disabled"}> ברירת מחדל</label>` +
        `<button type="button" class="camp-x" data-rm="${id}" title="הסרה מהרשימה" aria-label="הסרת הקבוצה מהרשימה">×</button></div>`;
    }).join("") || '<p class="camp-muted">לא מצאנו קבוצות בחשבון. הצטרפו לכמה מהקבוצות למטה ולחצו "רענון".</p>';
    const nm = (settings.non_member_groups || []).filter((g) => U.fbUrl(g.url));
    $("apNonMemberWrap").hidden = !nm.length;
    $("apNonMember").innerHTML = nm.map((g) => `<div class="camp-s"><span>${U.esc(g.name || g.url.replace(/^https?:\/\/(www\.)?/, ""))}</span> ` +
      `<a href="${U.esc(U.fbUrl(g.url))}" target="_blank" rel="noopener noreferrer">הצטרפות ↗</a></div>`).join("");
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
    try {
      await loadAll();
      const typing = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.draft;
      if (!typing) renderProps(); // never pull the text box from under someone typing
      renderSettings();
    } catch (e) { /* the next poll tries again */ }
  }

  // The account-level choices, under the consent. Auto-enroll keeps every
  // usable member group as the pool; enrollment narrows it per property.
  function settingsBody() {
    const auto = $("apAutoEnroll").checked, targets = withPage() ? ["page", "groups"] : ["groups"];
    const b = {
      enabled: true, consent: true, consent_version: settings.consent_version, auto_mode: mode(),
      // The default groups are their own list (PUT /default-groups); this saves the auto-enroll choice only.
      auto_enroll: auto, targets: auto ? targets : ["groups"], allows_visible_interactions: $("apVisible").checked,
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

  // Groups the server refuses for this property (not a member any more,
  // barred to agents, the wrong kind of deal): dropped, and the rest go ahead.
  const startedText = (dropped) => (!dropped ? "התחלנו ✓ אפשר לעצור בכל רגע"
    : `הורדנו ${dropped === 1 ? "קבוצה אחת שלא מתאימה" : `${dropped} קבוצות שלא מתאימות`} לנכס — הפרסום התחיל בשאר ✓`);
  const DROPPABLE = new Set(["not_member", "group_disallowed", "listing_type_not_allowed"]);
  async function start(p, ids) {
    const targets = withPage() ? ["page", "groups"] : ["groups"];
    await put("/api/posting/settings", settingsBody());
    let left = ids.slice();
    for (let round = 0; round < 3; round++) {
      const unknown = members().some((g) => left.includes(String(g.group_id)) && g.agent_policy === "unknown");
      try {
        await post("/api/posting/campaigns", {
          page_id: p.page_id, group_ids: left, mode: mode(), days: 30, repeat: !!repeatDays(p.page_id), repeat_days: repeatDays(p.page_id), targets, consent: true,
          consent_version: settings.consent_version, include_unknown: unknown,
          // Manual posting: the text the agent approved for each group (edited or as shown).
          copies: settings.manual ? Object.fromEntries(left.map((gid) => {
            const v = previews.get(`${p.page_id}|${gid}`), d = draftOf(`${p.page_id}|${gid}`).copy;
            return [gid, typeof d === "string" && d.trim() ? d : (v && v.copy) || ""];
          }).filter((e) => e[1])) : undefined,
          account_aged: $("apAged").checked, posted_manually: $("apManual").checked,
        });
        consentGiven = true;
        return ids.length - left.length; // how many were dropped
      } catch (e) {
        const bad = new Set(((e && e.body && e.body.group_ids) || []).map(String));
        if (!e || !DROPPABLE.has(e.code) || !bad.size) throw e;
        if (picks.has(p.page_id)) bad.forEach((id) => picks.get(p.page_id).delete(id));
        left = left.filter((id) => !bad.has(String(id)));
        if (!left.length) throw e;
      }
    }
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
      const original = (previews.get(previewKey(p)) || {}).copy, perPost = mode() === "per_post";
      return withBusy(p, async () => {
        const dropped = await start(p, ids);
        // The agent has just read the post, maybe edited it, and chosen its time: that
        // IS the approval of the first post — it is never asked for a second time.
        const approved = settings.manual ? true : perPost ? await approveFirst(p, original) : true;
        toast(approved ? startedText(dropped) : "התחלנו ✓ הפוסט הראשון יופיע כאן לאישור בעוד רגע"); open.delete(p.page_id);
      });
    }
    // STOP: always allowed, whatever the switches or halts say (routes/posting.js).
    if (!confirm("לעצור את הפרסום של הנכס הזה? מה שכבר עלה נשאר בקבוצות. אפשר להפעיל שוב מתי שתרצו.")) return renderProps();
    return withBusy(p, async () => { await post(`/api/posting/campaigns/${encodeURIComponent(p.campaign.id)}/stop`); toast("הפרסום של הנכס נעצר"); });
  }

  async function approveFirst(p, original) {
    const body = approveBody(p.page_id, original);
    for (let i = 0; i < 8; i++) try {
      const c = ((await api(`/api/posting/campaigns?page_id=${encodeURIComponent(p.page_id)}`)).campaigns || []).find(live);
      const first = c && (c.posts || []).find((x) => x.status === "pending_approval");
      if (first) { await post(`/api/posting/campaigns/${encodeURIComponent(c.id)}/posts/${encodeURIComponent(first.id)}/approve`, body); drafts.delete(p.page_id); return true; }
      if (c && (c.posts || []).some((x) => x.status === "scheduled")) return true; // nothing to approve
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) { break; } // the post then waits in the row, to be approved there
    return false;
  }
  // Approve or skip a waiting post from its row. key: `${page_id}|${post_id}`.
  async function decide(key, what) {
    const [pageId, postId] = key.split("|"), p = byId(pageId);
    const x = p && live(p.campaign) && (p.campaign.posts || []).find((q) => q.id === postId);
    if (!x) return;
    await withBusy(p, async () => {
      await post(`/api/posting/campaigns/${encodeURIComponent(p.campaign.id)}/posts/${encodeURIComponent(postId)}/${what}`, what === "approve" ? approveBody(key, x.copy) : {});
      drafts.delete(key); toast(what === "approve" ? "אושר ✓" : "דילגנו על הפוסט");
    });
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
  $("apProps").addEventListener("input", (ev) => { const t = ev.target; if (t.dataset && t.dataset.draft) draftOf(t.dataset.draft).copy = t.value; });
  $("apProps").addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest("button"); if (!b) return;
    if (b.dataset.when) {
      const w = draftOf(b.dataset.when).when;
      if (b.dataset.k) w.k = b.dataset.k;
      if (b.dataset.day) w.day = Number(b.dataset.day);
      if (b.dataset.hour) w.hour = Number(b.dataset.hour);
      return renderProps();
    }
    if (b.dataset.repeat) {
      const r = repeatOf(b.dataset.repeat);
      if (b.dataset.k) r.k = /^\d+$/.test(b.dataset.k) ? Number(b.dataset.k) : b.dataset.k;
      if (b.dataset.n) r.n = Number(b.dataset.n);
      return renderProps();
    }
    if (b.dataset.approve) return decide(b.dataset.approve, "approve");
    if (b.dataset.skip) return decide(b.dataset.skip, "skip");
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
  $("apSort").value = sortBy;
  $("apSort").addEventListener("change", function () {
    sortBy = SORTS[this.value] ? this.value : "new";
    try { localStorage.setItem("ap_sort", sortBy); } catch (e) { /* storage off */ }
    renderProps();
  });
  // The one list of default groups, saved the moment a box is ticked.
  $("apMemberGroups").addEventListener("change", async (ev) => {
    const box = ev.target && ev.target.dataset && ev.target.dataset.def ? ev.target : null;
    if (!box) return;
    const ids = [...$("apMemberGroups").querySelectorAll("input[data-def]:checked")].map((i) => i.dataset.def);
    box.disabled = true;
    try { settings.default_group_ids = (await put("/api/posting/default-groups", { group_ids: ids })).default_group_ids || ids; toast("קבוצות ברירת המחדל נשמרו ✓"); }
    catch (e) { box.checked = !box.checked; toast(errorText(e)); }
    finally { box.disabled = false; renderSettings(); }
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
  // Two buttons, one sync: the top one is in sight; the settings one sits
  // with the group list it refreshes.
  async function resync() {
    const label = this.textContent;
    this.disabled = true; this.textContent = "מרעננים…";
    try { await post("/api/posting/groups/resync"); picks.clear(); await refresh(); toast("רשימת הקבוצות עודכנה"); }
    catch (e) { toast(errorText(e)); }
    finally { this.disabled = false; this.textContent = label; }
  }
  $("apResync").addEventListener("click", resync);
  $("apResyncTop").addEventListener("click", resync);
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
    $("apAutoEnroll").checked = perm.enabled === true && perm.auto_enroll === true;
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
