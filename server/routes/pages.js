/*
 * routes/pages.js — landing page builder + serving + leads
 * Handles: /createPropertyPage, /api/property-page, /api/property-lead,
 *          /api/property-event, /api/video-overlay, /api/extend, /p/:id
 */

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const db = require("../db");
const pageEdit = require("../edit");
const { pad, daysFromNow, asMillis, sanitizeTheme, sanitizeLang, normalizePhone, guessImageExt, rehost, sendWhatsApp } = require("../utils");

const PAGE_LIFESPAN_DAYS = 30;
const LEAD_MAX_PER_HOUR = 3;
const SERVER_TEMPLATES = new Set(["nocturne", "galerie", "reel"]);

const confirmHtml = (title, sub) =>
  `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>` +
  `<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#F7F3EC;color:#17140F;` +
  `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}` +
  `.card{background:#FFFDF9;border:1px solid rgba(185,138,47,.3);border-radius:22px;padding:48px 36px;` +
  `max-width:340px;box-shadow:0 20px 60px rgba(23,20,15,.08)}h1{font-size:1.5rem;margin:0 0 10px}` +
  `p{color:#5A5348;margin:0}</style></head>` +
  `<body><div class="card"><h1>${title}</h1><p>${sub}</p></div></body></html>`;
const expiredLinkHtml = () =>
  confirmHtml("הקישור אינו תקף", "ייתכן שהדף כבר הוארך. ניתן להאריך גם דרך agent.call4li.com");

module.exports = function createPagesRouter(ctx) {
  const { uploadDir, baseUrl, pageBaseUrl, templatesDir, n8nLeadWebhook, greenInstance, greenToken,
          requireAuth, verifyActionToken, authSecret } = ctx;

  const router = express.Router();

  // shared page payload builder
  function pagePayload(id, d) {
    return {
      page_id: id, status: d.status, agent: d.agent, agent2: d.agent2 || null,
      property: d.property,
      hero: d.hero, gallery: d.gallery, carousel: d.carousel, area: d.area,
      cta: d.cta, sections: d.sections, theme: d.theme || null,
      language: d.language || "he",
      texts: d.texts || null,
    };
  }

  // ── page builder (called by n8n) ──
  router.post("/createPropertyPage", async (req, res) => {
    const body = req.body || {};
    if (!body.listing_id || !body.business_phone || !body.video_url ||
        !Array.isArray(body.photos) || body.photos.length < 1) {
      return res.status(400).json({ error: "listing_id, business_phone, video_url and photos are required" });
    }
    try {
      const reusable = await db.findActivePageByListing(body.listing_id);
      const pageId = reusable ? reusable.page_id : await db.uniquePageId(body.agent);
      const base = `pages/${pageId}`;

      // Theme and agent are chosen on the intake form and stored on the listing;
      // the n8n page builder doesn't always forward them, so fall back to the
      // listing here (this is what kept uploaded logos off the page).
      const listing = await db.getListing(body.listing_id).catch(() => null);
      const theme = sanitizeTheme(body.theme || (listing && listing.theme));
      const listingAgent = (listing && listing.agent) || {};
      const agentIn = body.agent || {};
      const agentField = (k) => String(agentIn[k] || listingAgent[k] || "");
      const logoSrc = agentIn.logo_url || listingAgent.logo_url || null;
      // Co-listing agent (optional). n8n may not forward it, so fall back to the
      // listing where the intake form stored it.
      const agent2In = body.agent2 || (listing && listing.agent2) || null;
      const agent2Doc = agent2In && agent2In.name ? {
        name: String(agent2In.name).slice(0, 60),
        phone: String(agent2In.phone || "").replace(/\D/g, "").slice(0, 15) || null,
      } : null;
      // Property amenities + area breakdown: prefer the builder payload, fall
      // back to the listing (the intake form is the source of truth for these).
      const propNum = (k) => Number((body.property && body.property[k]) || (listing && listing[k])) || 0;
      const propBool = (k) => !!((body.property && body.property[k]) || (listing && listing[k]));
      if (theme && theme.font_url) {
        const fext = (theme.font_url.split("?")[0].match(/\.(woff2|woff|ttf|otf)$/i) || [, "woff2"])[1].toLowerCase();
        theme.font_url = await rehost(theme.font_url, `${base}/font.${fext}`, uploadDir, baseUrl).catch(() => theme.font_url);
      }

      const rehostFn = (url, dest) => rehost(url, dest, uploadDir, baseUrl);
      const videoP = rehostFn(body.video_url, `${base}/walkthrough.mp4`);
      const posterP = rehostFn(body.poster_url || body.photos[0].url, `${base}/poster.jpg`);
      const photoPs = body.photos.slice(0, 12).map((p, i) =>
        rehostFn(p.url, `${base}/photo-${pad(i + 1)}.${guessImageExt(p.url)}`));
      const mapP = body.area && body.area.map_image_url ? rehostFn(body.area.map_image_url, `${base}/map.png`) : null;
      const logoP = logoSrc ? rehostFn(logoSrc, `${base}/logo.png`) : null;

      const [videoUrl, posterUrl, ...rest] = await Promise.all([
        videoP, posterP, ...photoPs, ...(mapP ? [mapP] : []), ...(logoP ? [logoP] : []),
      ]);
      const photoUrls = rest.slice(0, photoPs.length);
      let cursor = photoPs.length;
      const mapUrl = mapP ? rest[cursor++] : null;
      const logoUrl = logoP ? rest[cursor++] : null;

      const galleryImages = photoUrls.map((u, i) => ({ url: u, caption: (body.photos[i] && body.photos[i].caption) || "" }));
      const now = new Date();
      const doc = {
        page_id: pageId, listing_id: body.listing_id, business_phone: body.business_phone,
        status: "active",
        created_at: reusable ? reusable.created_at : now,
        updated_at: now,
        expires_at: reusable ? reusable.expires_at : daysFromNow(PAGE_LIFESPAN_DAYS),
        extension_count: reusable ? (reusable.extension_count || 0) : 0,
        edit_count: reusable ? (reusable.edit_count || 0) : 0,
        edit_token: (reusable && reusable.edit_token) || pageEdit.newEditToken(),
        texts: (reusable && reusable.texts) || null,
        agent: {
          name: agentField("name"),
          brand_name: agentField("brand_name") || agentField("name"),
          logo_url: logoUrl,
          tagline: agentField("tagline"),
          phone: agentField("phone") || body.business_phone,
          phone2: agentField("phone2") || null,
          license: agentField("license"),
        },
        agent2: agent2Doc,
        property: {
          title: (body.property && body.property.title) ||
            `${(body.property && body.property.rooms) || ""} חד׳ ב${(body.property && (body.property.neighborhood || body.property.city)) || ""}`.trim(),
          listing_type: (body.property && body.property.listing_type) || (listing && listing.listing_type) || "sale",
          address: (body.property && body.property.address) || "",
          neighborhood: (body.property && body.property.neighborhood) || "",
          city: (body.property && body.property.city) || "",
          price: Number(body.property && body.property.price) || 0,
          rooms: Number(body.property && body.property.rooms) || 0,
          size_sqm: Number(body.property && body.property.size_sqm) || 0,
          size_built: propNum("size_built"),
          size_balcony: propNum("size_balcony"),
          size_garden: propNum("size_garden"),
          floor: Number(body.property && body.property.floor) || 0,
          parking: propNum("parking"),
          storage: propBool("storage"),
          elevator: propBool("elevator") || propBool("shabbat_elevator"),
          shabbat_elevator: propBool("shabbat_elevator"),
        },
        theme: theme || null,
        language: sanitizeLang(body.language || (listing && listing.language)),
        hero: { phrase: body.hero_phrase || "", video_url: videoUrl, poster_url: posterUrl },
        gallery: { images: galleryImages },
        carousel: { slides: (body.carousel_slides || []).slice(0, 6) },
        area: {
          blurb: (body.area && body.area.blurb) || "",
          stops: (body.area && body.area.stops) || [],
          stats: ((body.area && body.area.stats) || []).filter((s) => s && s.source_url),
          map_image_url: mapUrl,
          profile_slug: (body.area && body.area.profile_slug) || null,
        },
        cta: {
          headline: (body.cta && body.cta.headline) || "רוצים לראות את הנכס מקרוב?",
          sub: (body.cta && body.cta.sub) || (agentField("name")
            ? `השאירו פרטים ו${agentField("name")} יחזור אליכם לתיאום ביקור.`
            : "השאירו פרטים ונחזור אליכם לתיאום ביקור."),
          bullets: (body.cta && body.cta.bullets) || [],
          button_label: (body.cta && body.cta.button_label) || "תיאום ביקור",
        },
        sections: { gallery: galleryImages.length >= 3, carousel: true, area: true },
        view_count: reusable ? (reusable.view_count || 0) : 0,
        lead_count: reusable ? (reusable.lead_count || 0) : 0,
      };

      await db.savePage(doc);
      await db.setListingPageId(body.listing_id, pageId);
      res.json({ page_id: pageId, page_url: `${pageBaseUrl}/p/${pageId}` });
    } catch (err) {
      console.error("createPropertyPage failed:", err);
      res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
    }
  });

  // ── property-page API (also aliased as /api/page for edit.html) ──
  async function getPageHandler(req, res) {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (!id) return res.status(400).json({ error: "missing id" });
    const d = await db.getPage(id);
    if (!d) return res.status(404).json({ error: "not found" });
    if (d.status === "expired" || d.status === "archived") {
      res.set("Cache-Control", "public, max-age=60");
      return res.json({
        page_id: id, status: d.status,
        property: { title: d.property.title },
        agent: { name: d.agent.name, brand_name: d.agent.brand_name, phone: d.agent.phone },
        language: d.language || "he",
      });
    }
    if (d.status === "building") return res.status(404).json({ error: "not ready" });
    // Magic edit link: a valid edit_token flips the payload to editable.
    // Invalid/missing tokens get the plain public payload — no hint given.
    const token = typeof req.query.edit_token === "string" ? req.query.edit_token : "";
    let editable = false;
    if (token && !pageEdit.editThrottled(id)) {
      if (pageEdit.editTokenOk(d, token)) editable = true;
      else pageEdit.noteEditFail(id);
    }
    res.set("Cache-Control", editable ? "no-store" : "public, max-age=60");
    res.json({ ...pagePayload(id, d), ...(editable ? { editable: true } : {}) });
  }
  router.get("/api/property-page", getPageHandler);
  router.get("/api/page", getPageHandler); // alias for edit.html

  // ── POST /api/page/edit-text — save from the in-page edit mode ──
  // Token-authed, text-only, whitelist-merged (see server/edit.js).
  router.post("/api/page/edit-text", async (req, res) => {
    const body = req.body || {};
    const pageId = String(body.page_id || "");
    if (!pageId || !body.fields || typeof body.fields !== "object") {
      return res.status(400).json({ error: "page_id and fields required" });
    }
    const d = await db.getPage(pageId);
    if (!d) return res.status(404).json({ error: "not found" });
    if (pageEdit.editThrottled(pageId) || !pageEdit.editTokenOk(d, body.edit_token)) {
      pageEdit.noteEditFail(pageId);
      return res.status(401).json({ error: "bad_token" });
    }
    if (d.status !== "active" && d.status !== "expiring") {
      return res.status(410).json({ error: "page_inactive" });
    }
    try {
      const patch = pageEdit.buildEditPatch(d, body.fields);
      patch["edit_count"] = (d.edit_count || 0) + 1;
      patch["updated_at"] = new Date();
      await db.updatePage(pageId, patch);
      res.json({ ok: true, edit_count: patch["edit_count"] });
    } catch (err) {
      console.error("edit-text failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── POST /api/page/update — dashboard page editor (auth via session) ──
  router.post("/api/page/update", async (req, res) => {
    const body = req.body || {};
    const pageId = String(body.page_id || "");
    if (!pageId) return res.status(400).json({ error: "page_id required" });
    const d = await db.getPage(pageId);
    if (!d) return res.status(404).json({ error: "not found" });
    // ponytail: session auth would go here; for now allow any update
    try {
      const patch = { updated_at: new Date() };
      if (body.hero_phrase != null) patch["hero.phrase"] = String(body.hero_phrase).slice(0, 120);
      // Agent
      if (body.agent && typeof body.agent === "object") {
        if (body.agent.name != null) patch["agent.name"] = String(body.agent.name).slice(0, 60);
        if (body.agent.brand_name != null) patch["agent.brand_name"] = String(body.agent.brand_name).slice(0, 60);
        if (body.agent.tagline != null) patch["agent.tagline"] = String(body.agent.tagline).slice(0, 120);
      }
      // Property
      if (body.property && typeof body.property === "object") {
        if (body.property.title != null) patch["property.title"] = String(body.property.title).slice(0, 80);
        if (body.property.price != null) patch["property.price"] = Number(body.property.price) || 0;
        if (body.property.rooms != null) patch["property.rooms"] = Number(body.property.rooms) || 0;
        if (body.property.size_sqm != null) patch["property.size_sqm"] = Number(body.property.size_sqm) || 0;
        if (body.property.floor != null) patch["property.floor"] = Number(body.property.floor) || 0;
      }
      if (Array.isArray(body.gallery_images)) {
        patch["gallery.images"] = body.gallery_images.slice(0, 12).map((img) => ({
          url: String(img.url || ""),
          caption: String(img.caption || "").slice(0, 60),
        }));
      }
      if (Array.isArray(body.carousel_slides)) {
        patch["carousel.slides"] = body.carousel_slides.slice(0, 6).map((s) => ({
          num: String(s.num || "").slice(0, 6),
          title: String(s.title || "").slice(0, 80),
          body: String(s.body || "").slice(0, 400),
          tag: String(s.tag || "").slice(0, 40),
        }));
      }
      if (body.cta && typeof body.cta === "object") {
        if (body.cta.headline != null) patch["cta.headline"] = String(body.cta.headline).slice(0, 120);
        if (body.cta.sub != null) patch["cta.sub"] = String(body.cta.sub).slice(0, 300);
        if (body.cta.button_label != null) patch["cta.button_label"] = String(body.cta.button_label).slice(0, 40);
      }
      // Texts override map
      if (body.texts && typeof body.texts === "object") {
        const textsMap = d.texts || {};
        for (const [k, v] of Object.entries(body.texts)) {
          if (typeof v === "string") textsMap[k] = v.slice(0, 300);
        }
        patch["texts"] = textsMap;
      }
      if (body.theme && typeof body.theme === "object" && SERVER_TEMPLATES.has(body.theme.template)) {
        patch["theme.template"] = body.theme.template;
      }
      if (body.sections && typeof body.sections === "object") {
        patch["sections.gallery"] = !!body.sections.gallery;
        patch["sections.carousel"] = !!body.sections.carousel;
        patch["sections.area"] = !!body.sections.area;
      }
      await db.updatePage(pageId, patch);
      res.json({ ok: true });
    } catch (err) {
      console.error("page/update failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── page expiry extension ──
  // Two entry points, one effect: the dashboard button (session auth) and the
  // one-tap link in the expiry-reminder WhatsApp (signed token, no session).
  async function applyExtension(pageId, page) {
    const from = Math.max(Date.now(), asMillis(page.expires_at));
    const expiresAt = new Date(from + PAGE_LIFESPAN_DAYS * 86400000);
    await db.updatePage(pageId, {
      expires_at: expiresAt, status: "active",
      extension_count: (page.extension_count || 0) + 1,
      reminder_sent_at: null, updated_at: new Date(),
    });
    return expiresAt;
  }

  router.post("/api/page/extend", requireAuth(authSecret), async (req, res) => {
    const pageId = String((req.body && req.body.page_id) || "");
    const page = await db.getPage(pageId);
    if (!page) return res.status(404).json({ error: "not found" });
    if (page.business_phone !== req.user.userId) return res.status(403).json({ error: "not_owner" });
    const expiresAt = await applyExtension(pageId, page);
    res.json({ ok: true, expires_at: expiresAt.toISOString() });
  });

  // Token is bound to the current expires_at, so extending invalidates the link
  // it came from — one tap per reminder, no replay.
  router.get("/api/extend", async (req, res) => {
    const pageId = String(req.query.id || "");
    const e = String(req.query.e || "");
    const t = String(req.query.t || "");
    if (!pageId || !e || !t || !verifyActionToken([pageId, e], t, authSecret)) {
      return res.status(401).type("html").send(expiredLinkHtml());
    }
    const page = await db.getPage(pageId);
    if (!page || asMillis(page.expires_at) !== Number(e)) {
      return res.status(401).type("html").send(expiredLinkHtml());
    }
    const expiresAt = await applyExtension(pageId, page);
    const dateStr = expiresAt.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
    res.type("html").send(confirmHtml("✅ הדף הוארך בהצלחה", `הדף פעיל עד ${dateStr}.`));
  });

  // ── lead capture ──
  router.post("/api/property-lead", async (req, res) => {
    const body = req.body || {};
    const prospectPhone = normalizePhone(body.phone || "");
    const name = String(body.name || "").trim().slice(0, 60);
    if (!body.page_id || !prospectPhone || name.length < 2) return res.status(400).json({ error: "invalid_input" });
    const page = await db.getPage(body.page_id);
    if (!page) return res.status(404).json({ error: "page_not_found" });
    if (page.status !== "active" && page.status !== "expiring") return res.status(410).json({ error: "page_inactive" });

    // throttle
    const t = db.mem.throttle.get(prospectPhone);
    const now = Date.now();
    const count = t && now - t.windowStart < 3600000 ? t.count : 0;
    if (count >= LEAD_MAX_PER_HOUR) return res.json({ ok: true });
    db.mem.throttle.set(prospectPhone, { windowStart: count === 0 ? now : t.windowStart, count: count + 1 });

    try {
      const lead = {
        phone: prospectPhone, prospect_name: name, source: "landing_page",
        page_id: body.page_id, listing_id: page.listing_id,
        agent_phone: page.business_phone, status: "new", last_activity_at: new Date(),
      };
      await db.saveLead(prospectPhone, lead);
      await db.incrPageCounter(body.page_id, "lead_count", 1);

      // ponytail: skip direct WA if n8n webhook handles leads (avoids duplicate agent msg)
      if (!n8nLeadWebhook) {
        sendWhatsApp(page.business_phone,
          `🔔 ליד חדש מדף הנכס "${page.property.title}"!\n👤 ${name}\n📞 0${prospectPhone.slice(3)}\n` +
          `דברו איתו עכשיו: https://wa.me/${prospectPhone}`,
          greenInstance, greenToken).catch((e) => console.error("lead notify failed:", e.message));
      }

      if (n8nLeadWebhook) {
        fetch(n8nLeadWebhook, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: prospectPhone, name, source: "landing_page",
            page_id: body.page_id, listing_id: page.listing_id, agent_phone: page.business_phone,
            agent: {
              name: page.agent?.name || "",
              brand_name: page.agent?.brand_name || "",
              phone: page.agent?.phone || page.business_phone,
              phone2: page.agent?.phone2 || null,
            },
            agent2: page.agent2 || null,
          }),
          signal: AbortSignal.timeout(10000),
        }).catch((e) => console.error("leads-handler webhook failed:", e.message));
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("submitPropertyLead failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── video overlay ──
  const { overlayVideo, MAX_LINES, MAX_ROOMS } = require("../overlay");
  router.post("/api/video-overlay", async (req, res) => {
    const body = req.body || {};
    const videoUrl = String(body.video_url || "");
    const lines = Array.isArray(body.lines) ?
      body.lines.map((l) => String(l || "").trim()).filter(Boolean) : [];
    // Optional room labels: strings or {room_type} objects, in any order.
    const rooms = Array.isArray(body.rooms) ? body.rooms.slice(0, MAX_ROOMS) : [];
    if (!/^https?:\/\//.test(videoUrl) || lines.length < 1 || lines.length > MAX_LINES) {
      return res.status(400).json({ error: `video_url and 1-${MAX_LINES} lines required` });
    }
    try {
      const result = await overlayVideo({ videoUrl, lines, rooms, uploadDir, baseUrl });
      res.json(result);
    } catch (err) {
      console.error("video-overlay failed:", err.message);
      res.status(500).json({ error: "overlay_failed", detail: err.message.slice(0, 300) });
    }
  });

  // ── events beacon ──
  const EVENTS = new Set(["view", "scroll_50", "scroll_90", "video_play", "cta_click"]);
  router.post("/api/property-event", express.text({ type: () => true }), async (req, res) => {
    let body = {};
    try { body = typeof req.body === "string" && req.body ? JSON.parse(req.body) : (req.body || {}); } catch { /* ignore */ }
    const { page_id: pageId, event } = body;
    if (!pageId || !event || !EVENTS.has(event)) return res.status(204).send("");
    try { if (event === "view") await db.incrPageCounter(pageId, "view_count", 1); }
    catch (err) { console.warn("trackPropertyEvent failed:", err.message); }
    res.status(204).send("");
  });

  // ── page serving ──
  router.get("/p/:id", async (req, res) => {
    const id = req.params.id;
    const origShell = path.join(__dirname, "..", "..", "public-nadlan", "p", "index.html");
    let d = null;
    try { d = await db.getPage(id); } catch (e) { /* fall back */ }
    const tpl = d && d.theme && d.theme.template;
    if (!d || d.status !== "active" || !SERVER_TEMPLATES.has(tpl)) {
      return res.sendFile(origShell);
    }
    const file = path.join(templatesDir, tpl + ".html");
    if (!fs.existsSync(file)) return res.sendFile(origShell);
    let html = fs.readFileSync(file, "utf8");
    const inject = `<script>window.__PAGE__=${JSON.stringify(pagePayload(id, d)).replace(/</g, "\\u003c")};</script>`;
    html = html.replace("</head>", inject + "</head>");
    res.set("Cache-Control", "public, max-age=60");
    res.type("html").send(html);
  });

  return router;
};
