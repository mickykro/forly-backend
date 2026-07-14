/*
 * Agent portal — the nadlan/signup Cloud Functions ported to the VPS server:
 *   POST /api/auth/otp              (sendLoginOtp)
 *   POST /api/auth/verify           (verifyLoginOtp)
 *   POST /api/signup                (submitWebSignup)
 *   GET  /api/properties            (listMyProperties)
 *   POST /api/properties/create     (createProperty)
 *   POST /api/properties/delete     (deleteProperty)
 *   POST /api/page/update           (updatePropertyPage)
 *   GET|POST /api/page/extend and /api/extend  (extendPropertyPage, dual auth)
 *   daily lifecycle sweep at 09:00 Asia/Jerusalem (expirePagesDaily)
 *
 * Behavior, Firestore shapes, and error codes match the functions versions so
 * the frontends and existing data need no changes. Requires Firestore (db)
 * and NADLAN_JWT_SECRET; index.js only registers this when both are present.
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  signSession, signActionToken, verifyActionToken,
  requireAuth, hashCode, sessionCookie,
} = require("./session");

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_GAP_MS = 60 * 1000;
const OTP_MAX_SENDS_PER_DAY = 5;
const OTP_MAX_ATTEMPTS = 5;
const PAGE_LIFESPAN_DAYS = 30;
const REMINDER_BEFORE_DAYS = 5;

const todayKey = () => new Date().toISOString().slice(0, 10);

// Firestore admin SDK returns Timestamps; seeded/local data may hold Dates.
function tsMillis(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === "function") return v.toMillis();
  return new Date(v).getTime();
}

function confirmHtml(title, sub) {
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#F7F3EC;color:#17140F;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}
.card{background:#FFFDF9;border:1px solid rgba(185,138,47,.3);border-radius:22px;padding:48px 36px;
max-width:340px;box-shadow:0 20px 60px rgba(23,20,15,.08)}h1{font-size:1.5rem;margin:0 0 10px}
p{color:#5A5348;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${sub}</p></div></body></html>`;
}

function expiredLinkHtml() {
  return confirmHtml("הקישור אינו תקף", "ייתכן שהדף כבר הוארך. ניתן להאריך גם דרך agent.call4li.com");
}

function buildExtendLink(pageId, expiresAtMs, secret, pageBaseUrl) {
  const t = signActionToken([pageId, String(expiresAtMs)], secret);
  return `${pageBaseUrl}/api/extend?id=${pageId}&e=${expiresAtMs}&t=${t}`;
}

function registerPortal(app, deps) {
  const {db, secret, sendWhatsApp, normalizePhone, createListing, pageBaseUrl, uploadDir} = deps;
  const auth = (req) => requireAuth(req, secret);

  // ── POST /api/auth/otp — { phone, mode?: "login" | "signup" } ──
  app.post("/api/auth/otp", async (req, res) => {
    const body = req.body || {};
    const phone = normalizePhone(body.phone || "");
    if (!phone) return res.status(400).json({error: "invalid_phone"});
    const mode = body.mode === "signup" ? "signup" : "login";

    const business = await db.collection("businesses").doc(phone).get();
    if (mode === "login" && !business.exists) return res.status(404).json({error: "unknown_agent"});
    if (mode === "signup" && business.exists) return res.status(409).json({error: "already_registered"});

    const otpRef = db.collection("otp_codes").doc(phone);
    const otpDoc = await otpRef.get();
    const now = Date.now();
    const prev = otpDoc.exists ? otpDoc.data() : {};

    const lastSent = prev.last_sent_at ? tsMillis(prev.last_sent_at) : 0;
    if (now - lastSent < OTP_RESEND_GAP_MS) {
      return res.status(429).json({error: "too_soon", retry_in_s: Math.ceil((OTP_RESEND_GAP_MS - (now - lastSent)) / 1000)});
    }
    const sendsToday = prev.sends_day === todayKey() ? (prev.sends_today || 0) : 0;
    if (sendsToday >= OTP_MAX_SENDS_PER_DAY) return res.status(429).json({error: "daily_limit"});

    const code = String(crypto.randomInt(100000, 1000000));
    await otpRef.set({
      code_hash: hashCode(code, secret),
      expires_at: new Date(now + OTP_TTL_MS),
      attempts: 0,
      mode,
      last_sent_at: new Date(now),
      sends_today: sendsToday + 1,
      sends_day: todayKey(),
    });

    try {
      await sendWhatsApp(phone, `🔐 קוד הכניסה שלך לפורלי: ${code}\nהקוד תקף ל-5 דקות.`);
    } catch (err) {
      console.error("OTP WhatsApp send failed:", err.message);
      return res.status(502).json({error: "whatsapp_send_failed"});
    }
    res.json({ok: true});
  });

  // ── POST /api/auth/verify — { phone, code } → session cookie ──
  app.post("/api/auth/verify", async (req, res) => {
    const body = req.body || {};
    const phone = normalizePhone(body.phone || "");
    const code = String(body.code || "").trim();
    if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({error: "invalid_input"});

    const otpRef = db.collection("otp_codes").doc(phone);
    const otpDoc = await otpRef.get();
    if (!otpDoc.exists) return res.status(400).json({error: "no_code"});
    const otp = otpDoc.data();
    if (tsMillis(otp.expires_at) < Date.now()) {
      await otpRef.delete();
      return res.status(400).json({error: "expired"});
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await otpRef.delete();
      return res.status(429).json({error: "too_many_attempts"});
    }
    if (otp.code_hash !== hashCode(code, secret)) {
      await otpRef.update({attempts: otp.attempts + 1});
      return res.status(401).json({error: "wrong_code", attempts_left: OTP_MAX_ATTEMPTS - otp.attempts - 1});
    }

    await otpRef.delete();
    res.set("Set-Cookie", sessionCookie(signSession(phone, secret)));

    const business = await db.collection("businesses").doc(phone).get();
    const b = business.exists ? business.data() : {};
    res.json({
      ok: true,
      is_new: !business.exists,
      mode: otp.mode || "login",
      agent: {
        name: b.full_name || "",
        brand_name: b.business_name || "",
        logo_url: b.logo_url || null,
      },
    });
  });

  // ── POST /api/signup — session cookie from the signup-mode OTP flow ──
  app.post("/api/signup", async (req, res) => {
    const phone = auth(req);
    if (!phone) return res.status(401).json({error: "unauthenticated"});
    const body = req.body || {};
    const fullName = String(body.full_name || "").trim().slice(0, 60);
    const businessName = String(body.business_name || "").trim().slice(0, 60);
    if (fullName.length < 2 || businessName.length < 2) {
      return res.status(400).json({error: "full_name and business_name required"});
    }

    const ref = db.collection("businesses").doc(phone);
    const existing = await ref.get();
    if (existing.exists && existing.get("signup_completed_at")) {
      return res.status(409).json({error: "already_registered"});
    }

    try {
      // Same doc shape Signup Bot2 produces, so both channels converge.
      await ref.set({
        phone,
        full_name: fullName,
        business_name: businessName,
        city: String(body.city || "").slice(0, 60),
        niche: String(body.niche || "nadlan").slice(0, 40),
        logo_url: body.logo_url || null,
        logo_requested: body.wants_generated_logo === true && !body.logo_url,
        source: "web_signup",
        signup_completed_at: new Date(),
        total_inquiries_reported: 0,
        total_deals_closed: 0,
        created_at: existing.exists ? existing.get("created_at") : new Date(),
      }, {merge: true});

      await ref.collection("quota").doc("current").set({
        plan: "trial",
        period_start: new Date(),
      }, {merge: true});

      sendWhatsApp(phone,
        `ברוכים הבאים לפורלי 🦉\n` +
        `${fullName}, החשבון של ${businessName} מוכן!\n\n` +
        `מה עכשיו? נכנסים ל-agent.call4li.com, פותחים נכס ראשון — ` +
        `ותוך דקות יש לו דף נחיתה עם וידאו, גלריה ומידע על השכונה.`
      ).catch((err) => console.error("welcome send failed (signup still ok):", err.message));

      res.json({ok: true});
    } catch (err) {
      console.error("submitWebSignup failed:", err);
      res.status(500).json({error: "internal"});
    }
  });

  // ── GET /api/properties — dashboard list ──
  app.get("/api/properties", async (req, res) => {
    const phone = auth(req);
    if (!phone) return res.status(401).json({error: "unauthenticated"});
    const [listings, pages] = await Promise.all([
      db.collection("listings")
        .where("business_phone", "==", phone)
        .where("status", "in", ["active", "archived"]).get(),
      db.collection("property_pages")
        .where("business_phone", "==", phone).get(),
    ]);
    const pageById = new Map(pages.docs.map((p) => [p.id, p.data()]));

    const items = listings.docs.map((l) => {
      const d = l.data();
      const page = d.page_id ? pageById.get(d.page_id) : undefined;
      const expiresAt = page && page.expires_at ? tsMillis(page.expires_at) : null;
      return {
        listing_id: d.listing_id,
        page_id: d.page_id,
        title: (page && page.property.title) || d.address,
        address: d.address,
        listing_status: d.status,
        page_status: (page && page.status) || "building",
        days_left: expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000)) : null,
        view_count: (page && page.view_count) || 0,
        lead_count: (page && page.lead_count) || 0,
        page_url: d.page_id ? `${pageBaseUrl}/p/${d.page_id}` : null,
        thumb_url: (page && page.gallery.images[0] && page.gallery.images[0].url) || d.photos_urls[0] || null,
        created_at: d.created_at,
      };
    }).sort((a, b) => tsMillis(b.created_at) - tsMillis(a.created_at));

    res.json({properties: items});
  });

  // ── POST /api/properties/create — authed create → n8n pipeline ──
  app.post("/api/properties/create", async (req, res) => {
    const phone = auth(req);
    if (!phone) return res.status(401).json({error: "unauthenticated"});
    const result = await createListing(phone, req.body || {}, null);
    if (result.error) return res.status(result.code).json({error: result.error});
    res.json({...result, status: "building"});
  });

  // ── POST /api/properties/delete — { listing_id, mode: archive | delete } ──
  app.post("/api/properties/delete", async (req, res) => {
    const phone = auth(req);
    if (!phone) return res.status(401).json({error: "unauthenticated"});
    const {listing_id: listingId, mode} = req.body || {};
    if (!listingId || (mode !== "archive" && mode !== "delete")) {
      return res.status(400).json({error: "listing_id and mode(archive|delete) required"});
    }
    const ref = db.collection("listings").doc(listingId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({error: "not found"});
    if (doc.get("business_phone") !== phone) return res.status(403).json({error: "not_owner"});
    const pageId = doc.get("page_id");

    try {
      if (mode === "archive") {
        await ref.update({status: "archived"});
        if (pageId) await db.collection("property_pages").doc(pageId).update({status: "archived"});
      } else {
        await ref.update({status: "deleted"});
        if (pageId) {
          await db.collection("property_pages").doc(pageId).update({status: "archived"});
          // Page assets re-hosted by this server live under UPLOAD_DIR/pages/{id}.
          // (Assets of pages built by the old Cloud Function live in GCS and are
          // left untouched — they expire with the bucket's own lifecycle.)
          fs.rmSync(path.join(uploadDir, "pages", String(pageId)), {recursive: true, force: true});
        }
      }
      res.json({ok: true});
    } catch (err) {
      console.error("deleteProperty failed:", err);
      res.status(500).json({error: "internal"});
    }
  });

  // ── POST /api/page/update — whitelist-merge of editable paths ──
  app.post("/api/page/update", async (req, res) => {
    const phone = auth(req);
    if (!phone) return res.status(401).json({error: "unauthenticated"});
    const body = req.body || {};
    if (!body.page_id) return res.status(400).json({error: "missing page_id"});

    const ref = db.collection("property_pages").doc(body.page_id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({error: "not found"});
    const d = doc.data();
    if (d.business_phone !== phone) return res.status(403).json({error: "not_owner"});

    const update = {
      updated_at: new Date(),
      edit_count: (d.edit_count || 0) + 1,
    };
    if (typeof body.hero_phrase === "string") update["hero.phrase"] = body.hero_phrase.slice(0, 80);
    if (body.property) {
      for (const k of ["title", "address", "neighborhood", "city", "price", "rooms", "size_sqm", "floor", "parking"]) {
        if (body.property[k] !== undefined) update[`property.${k}`] = body.property[k];
      }
    }
    if (Array.isArray(body.gallery_images)) {
      // Only reorder/caption/remove of already-hosted images.
      const current = new Set(d.gallery.images.map((i) => i.url));
      const next = body.gallery_images
        .filter((i) => current.has(i.url))
        .map((i) => ({url: i.url, caption: String(i.caption || "").slice(0, 60)}));
      if (next.length >= 1) update["gallery.images"] = next;
    }
    if (Array.isArray(body.carousel_slides)) {
      update["carousel.slides"] = d.carousel.slides.map((s, i) => {
        const patch = body.carousel_slides[i] || {};
        return {
          num: s.num,
          title: String(patch.title !== undefined ? patch.title : s.title).slice(0, 60),
          body: String(patch.body !== undefined ? patch.body : s.body).slice(0, 300),
          tag: String(patch.tag !== undefined ? patch.tag : s.tag).slice(0, 30),
        };
      });
    }
    if (body.cta) {
      if (typeof body.cta.headline === "string") update["cta.headline"] = body.cta.headline.slice(0, 80);
      if (typeof body.cta.sub === "string") update["cta.sub"] = body.cta.sub.slice(0, 200);
      if (typeof body.cta.button_label === "string") update["cta.button_label"] = body.cta.button_label.slice(0, 30);
    }
    if (body.sections) {
      for (const k of ["gallery", "carousel", "area"]) {
        if (typeof body.sections[k] === "boolean") update[`sections.${k}`] = body.sections[k];
      }
    }

    await ref.update(update);
    res.json({ok: true, edit_count: update.edit_count});
  });

  // ── extend — dual auth: POST + cookie (dashboard) or GET signed link ──
  async function applyExtension(pageId) {
    const ref = db.collection("property_pages").doc(pageId);
    const doc = await ref.get();
    const d = doc.data();
    const base = Math.max(Date.now(), tsMillis(d.expires_at));
    const newExpiry = new Date(base + PAGE_LIFESPAN_DAYS * 86400000);
    await ref.update({
      expires_at: newExpiry,
      status: "active",
      extension_count: (d.extension_count || 0) + 1,
      reminder_sent_at: null,
      updated_at: new Date(),
    });
    return newExpiry;
  }

  async function handleExtend(req, res) {
    try {
      if (req.method === "POST") {
        const phone = auth(req);
        if (!phone) return res.status(401).json({error: "unauthenticated"});
        const pageId = String((req.body || {}).page_id || "");
        const doc = await db.collection("property_pages").doc(pageId).get();
        if (!doc.exists) return res.status(404).json({error: "not found"});
        if (doc.get("business_phone") !== phone) return res.status(403).json({error: "not_owner"});
        const newExpiry = await applyExtension(pageId);
        return res.json({ok: true, expires_at: newExpiry.toISOString()});
      }

      if (req.method === "GET") {
        const pageId = String(req.query.id || "");
        const e = String(req.query.e || "");
        const t = String(req.query.t || "");
        if (!pageId || !e || !t || !verifyActionToken([pageId, e], t, secret)) {
          return res.status(401).send(expiredLinkHtml());
        }
        const doc = await db.collection("property_pages").doc(pageId).get();
        if (!doc.exists || tsMillis(doc.data().expires_at) !== Number(e)) {
          // expires_at changed → link already used or superseded.
          return res.status(401).send(expiredLinkHtml());
        }
        const newExpiry = await applyExtension(pageId);
        const dateStr = newExpiry.toLocaleDateString("he-IL", {day: "numeric", month: "long", year: "numeric"});
        res.set("Content-Type", "text/html; charset=utf-8");
        return res.send(confirmHtml("✅ הדף הוארך בהצלחה", `הדף פעיל עד ${dateStr}.`));
      }

      res.status(405).send("GET or POST");
    } catch (err) {
      console.error("extendPropertyPage failed:", err);
      res.status(500).json({error: "internal"});
    }
  }
  app.all("/api/extend", handleExtend);
  app.all("/api/page/extend", handleExtend);

  // ── daily lifecycle sweep (was expirePagesDaily, 09:00 Asia/Jerusalem) ──
  async function runLifecycleSweep() {
    const now = Date.now();
    const soon = new Date(now + REMINDER_BEFORE_DAYS * 86400000);
    const expiring = await db.collection("property_pages")
      .where("status", "in", ["active", "expiring"])
      .where("expires_at", "<=", soon)
      .limit(100).get();

    let reminded = 0;
    let expired = 0;
    for (const doc of expiring.docs) {
      const d = doc.data();
      const expMs = tsMillis(d.expires_at);
      try {
        if (expMs < now) {
          await doc.ref.update({status: "expired", updated_at: new Date()});
          expired++;
          continue;
        }
        if (!d.reminder_sent_at) {
          const daysLeft = Math.max(1, Math.ceil((expMs - now) / 86400000));
          const link = buildExtendLink(doc.id, expMs, secret, pageBaseUrl);
          await sendWhatsApp(
            d.business_phone,
            `⏳ דף הנכס "${d.property.title}" יפוג בעוד ${daysLeft} ימים.\n` +
            `להארכה בחינם (30 יום נוספים) בלחיצה אחת:\n${link}\n\n` +
            `לניהול כל הנכסים: agent.call4li.com`
          );
          await doc.ref.update({reminder_sent_at: new Date(), status: "expiring"});
          reminded++;
        }
      } catch (err) {
        console.error(`lifecycle failed for page ${doc.id}:`, err.message);
      }
    }
    console.log(`lifecycle sweep: reminded=${reminded} expired=${expired}`);
  }

  function ilNow() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return {day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24};
  }

  function startLifecycleCron() {
    let lastRunDay = null;
    const timer = setInterval(() => {
      const {day, hour} = ilNow();
      if (hour === 9 && day !== lastRunDay) {
        lastRunDay = day;
        runLifecycleSweep().catch((err) => console.error("lifecycle sweep failed:", err));
      }
    }, 60 * 1000);
    timer.unref();
    console.log("lifecycle cron armed (daily 09:00 Asia/Jerusalem)");
  }

  return {runLifecycleSweep, startLifecycleCron};
}

module.exports = {registerPortal};
