import {onRequest} from "firebase-functions/https";
import {onSchedule} from "firebase-functions/scheduler";
import * as logger from "firebase-functions/logger";
import {
  db, sendWhatsAppMessage, pageBaseUrl,
  greenApiInstance, greenApiToken, nadlanJwtSecret,
} from "../shared";
import {requireAuth, signActionToken, verifyActionToken} from "./auth";
import {PropertyPage, PAGE_LIFESPAN_DAYS, REMINDER_BEFORE_DAYS} from "./types";

function tsMillis(v: FirebaseFirestore.Timestamp | Date): number {
  return v instanceof Date ? v.getTime() :
    (v as FirebaseFirestore.Timestamp).toMillis();
}

/** Build the one-tap extend link sent in WhatsApp reminders. Bound to the
 *  current expires_at, so extending once invalidates the old link. */
export function buildExtendLink(pageId: string, expiresAtMs: number, secret: string): string {
  const t = signActionToken([pageId, String(expiresAtMs)], secret);
  return `${pageBaseUrl.value()}/api/extend?id=${pageId}&e=${expiresAtMs}&t=${t}`;
}

async function applyExtension(pageId: string): Promise<Date> {
  const ref = db.collection("property_pages").doc(pageId);
  const doc = await ref.get();
  const d = doc.data() as PropertyPage;
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

// ────────────────────────────────────────────────────────────
// extendPropertyPage — dual auth:
//   POST {page_id} + session cookie (dashboard)
//   GET ?id=&e=&t=  signed one-tap link (WhatsApp reminder)
// ────────────────────────────────────────────────────────────
export const extendPropertyPage = onRequest(
  {secrets: [nadlanJwtSecret], cors: false},
  async (req, res) => {
    try {
      if (req.method === "POST") {
        const phone = requireAuth(req);
        if (!phone) {
          res.status(401).json({error: "unauthenticated"});
          return;
        }
        const pageId = String((req.body as {page_id?: string}).page_id || "");
        const doc = await db.collection("property_pages").doc(pageId).get();
        if (!doc.exists) {
          res.status(404).json({error: "not found"});
          return;
        }
        if (doc.get("business_phone") !== phone) {
          res.status(403).json({error: "not_owner"});
          return;
        }
        const newExpiry = await applyExtension(pageId);
        res.json({ok: true, expires_at: newExpiry.toISOString()});
        return;
      }

      if (req.method === "GET") {
        const pageId = String(req.query.id || "");
        const e = String(req.query.e || "");
        const t = String(req.query.t || "");
        if (!pageId || !e || !t ||
            !verifyActionToken([pageId, e], t, nadlanJwtSecret.value())) {
          res.status(401).send(expiredLinkHtml());
          return;
        }
        const doc = await db.collection("property_pages").doc(pageId).get();
        if (!doc.exists || tsMillis((doc.data() as PropertyPage).expires_at) !== Number(e)) {
          // expires_at changed → link already used or superseded.
          res.status(401).send(expiredLinkHtml());
          return;
        }
        const newExpiry = await applyExtension(pageId);
        const dateStr = newExpiry.toLocaleDateString("he-IL", {day: "numeric", month: "long", year: "numeric"});
        res.set("Content-Type", "text/html; charset=utf-8");
        res.send(confirmHtml(`✅ הדף הוארך בהצלחה`, `הדף פעיל עד ${dateStr}.`));
        return;
      }

      res.status(405).send("GET or POST");
    } catch (err) {
      logger.error("extendPropertyPage failed:", err);
      res.status(500).json({error: "internal"});
    }
  }
);

function confirmHtml(title: string, sub: string): string {
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#F7F3EC;color:#17140F;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}
.card{background:#FFFDF9;border:1px solid rgba(185,138,47,.3);border-radius:22px;padding:48px 36px;
max-width:340px;box-shadow:0 20px 60px rgba(23,20,15,.08)}h1{font-size:1.5rem;margin:0 0 10px}
p{color:#5A5348;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${sub}</p></div></body></html>`;
}

function expiredLinkHtml(): string {
  return confirmHtml("הקישור אינו תקף", "ייתכן שהדף כבר הוארך. ניתן להאריך גם דרך agent.call4li.com");
}

// ────────────────────────────────────────────────────────────
// expirePagesDaily — 09:00 Asia/Jerusalem
// ────────────────────────────────────────────────────────────
export const expirePagesDaily = onSchedule(
  {
    schedule: "every day 09:00",
    timeZone: "Asia/Jerusalem",
    secrets: [greenApiInstance, greenApiToken, nadlanJwtSecret],
  },
  async () => {
    const now = Date.now();
    const soon = new Date(now + REMINDER_BEFORE_DAYS * 86400000);

    // 1) Reminders for pages expiring within the window.
    const expiring = await db.collection("property_pages")
      .where("status", "in", ["active", "expiring"])
      .where("expires_at", "<=", soon)
      .limit(100).get();

    let reminded = 0;
    let expired = 0;
    for (const doc of expiring.docs) {
      const d = doc.data() as PropertyPage;
      const expMs = tsMillis(d.expires_at);
      try {
        if (expMs < now) {
          await doc.ref.update({status: "expired", updated_at: new Date()});
          expired++;
          continue;
        }
        if (!d.reminder_sent_at) {
          const daysLeft = Math.max(1, Math.ceil((expMs - now) / 86400000));
          const link = buildExtendLink(doc.id, expMs, nadlanJwtSecret.value());
          await sendWhatsAppMessage(
            d.business_phone,
            `⏳ דף הנכס "${d.property.title}" יפוג בעוד ${daysLeft} ימים.\n` +
            `להארכה בחינם (30 יום נוספים) בלחיצה אחת:\n${link}\n\n` +
            `לניהול כל הנכסים: agent.call4li.com`,
            greenApiInstance.value(),
            greenApiToken.value()
          );
          await doc.ref.update({reminder_sent_at: new Date(), status: "expiring"});
          reminded++;
        }
      } catch (err) {
        logger.error(`lifecycle failed for page ${doc.id}:`, err);
      }
    }
    logger.log(`expirePagesDaily: reminded=${reminded} expired=${expired}`);
  }
);
