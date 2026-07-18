/*
 * lifecycle.js — page expiry reminders + expiration (was expirePagesDaily on
 * Cloud Functions). Cloud Scheduler ran it at 09:00 Asia/Jerusalem; this server
 * is long-running, so an hourly tick fires the sweep once per Jerusalem day.
 * Reminders are idempotent via reminder_sent_at, so a double tick is harmless.
 */

const db = require("./db");
const { asMillis, sendWhatsApp } = require("./utils");
const { signActionToken } = require("./auth");

const REMINDER_BEFORE_DAYS = 5;
const PAGE_LIFESPAN_DAYS = 30;

// Token is bound to the current expires_at, so extending invalidates this link.
function buildExtendLink(pageId, expiresAtMs, pageBaseUrl, secret) {
  const t = signActionToken([pageId, String(expiresAtMs)], secret);
  return `${pageBaseUrl}/api/extend?id=${pageId}&e=${expiresAtMs}&t=${t}`;
}

async function runExpirySweep(ctx) {
  const now = Date.now();
  const pages = await db.listPagesForExpiry(now + REMINDER_BEFORE_DAYS * 86400000);
  let reminded = 0, expired = 0;
  for (const p of pages) {
    const expMs = asMillis(p.expires_at);
    try {
      if (expMs < now) {
        await db.updatePage(p.page_id, { status: "expired", updated_at: new Date() });
        expired++;
        continue;
      }
      if (p.reminder_sent_at) continue;
      const daysLeft = Math.max(1, Math.ceil((expMs - now) / 86400000));
      const link = buildExtendLink(p.page_id, expMs, ctx.pageBaseUrl, ctx.authSecret);
      await sendWhatsApp(p.business_phone,
        `⏳ דף הנכס "${(p.property && p.property.title) || ""}" יפוג בעוד ${daysLeft} ימים.\n` +
        `להארכה בחינם (${PAGE_LIFESPAN_DAYS} יום נוספים) בלחיצה אחת:\n${link}\n\n` +
        `לניהול כל הנכסים: agent.call4li.com`,
        ctx.greenInstance, ctx.greenToken);
      // Only mark as reminded once the send succeeded, so a WhatsApp outage
      // retries tomorrow instead of silently swallowing the reminder.
      await db.updatePage(p.page_id, { reminder_sent_at: new Date(), status: "expiring" });
      reminded++;
    } catch (err) {
      console.error(`lifecycle failed for page ${p.page_id}:`, err.message);
    }
  }
  console.log(`expirePagesDaily: reminded=${reminded} expired=${expired}`);
}

// Hour + Y-M-D in Asia/Jerusalem without pulling in a tz library.
function jerusalemParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(now);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

function startExpiryScheduler(ctx) {
  let lastSweepDay = "";
  const tick = () => {
    const { day, hour } = jerusalemParts();
    if (hour === 9 && day !== lastSweepDay) {
      lastSweepDay = day;
      runExpirySweep(ctx).catch((e) => console.error("expiry sweep error:", e.message));
    }
  };
  setInterval(tick, 60 * 60 * 1000).unref();
  tick();
}

module.exports = { startExpiryScheduler, runExpirySweep, jerusalemParts, buildExtendLink };
