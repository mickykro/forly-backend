import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import axios from "axios";
import {FieldValue} from "firebase-admin/firestore";
import {
  db, normalizePhone, sendWhatsAppMessage,
  greenApiInstance, greenApiToken, n8nLeadWebhookUrl,
} from "../shared";
import {PropertyPage} from "./types";

const LEAD_MAX_PER_HOUR = 3;

// ────────────────────────────────────────────────────────────
// submitPropertyLead — POST { page_id, name, phone } from the /p/ form
// ────────────────────────────────────────────────────────────
export const submitPropertyLead = onRequest(
  {secrets: [greenApiInstance, greenApiToken], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const body = req.body as {page_id?: string; name?: string; phone?: string; message?: string};
    const prospectPhone = normalizePhone(body.phone || "");
    const name = String(body.name || "").trim().slice(0, 60);
    const message = String(body.message || "").trim().slice(0, 500);
    if (!body.page_id || !prospectPhone || name.length < 2) {
      res.status(400).json({error: "invalid_input"});
      return;
    }

    const pageDoc = await db.collection("property_pages").doc(body.page_id).get();
    if (!pageDoc.exists) {
      res.status(404).json({error: "page_not_found"});
      return;
    }
    const page = pageDoc.data() as PropertyPage;
    if (page.status !== "active" && page.status !== "expiring") {
      res.status(410).json({error: "page_inactive"});
      return;
    }

    // Throttle: max N submissions per prospect phone per hour. Silently
    // accept over-limit requests (return ok, skip side effects) so the page
    // never shows an error for double-taps.
    const throttleRef = db.collection("lead_throttle").doc(prospectPhone);
    const allowed = await db.runTransaction(async (tx) => {
      const t = await tx.get(throttleRef);
      const now = Date.now();
      const windowStart = t.exists ? (t.get("window_start") as number) : 0;
      const count = t.exists && now - windowStart < 3600_000 ? (t.get("count") as number) : 0;
      if (count >= LEAD_MAX_PER_HOUR) return false;
      tx.set(throttleRef, {
        window_start: count === 0 ? now : windowStart,
        count: count + 1,
      });
      return true;
    });
    if (!allowed) {
      res.json({ok: true});
      return;
    }

    try {
      // 1) Lead doc — never downgrade a converted lead.
      const leadRef = db.collection("leads").doc(prospectPhone);
      const lead = await leadRef.get();
      const existingStatus = lead.exists ? (lead.get("status") as string) : null;
      await leadRef.set({
        phone: prospectPhone,
        prospect_name: name,
        source: "landing_page",
        page_id: body.page_id,
        listing_id: page.listing_id,
        agent_phone: page.business_phone,
        ...(existingStatus === "converted" ? {} : {status: existingStatus || "new"}),
        last_activity_at: new Date(),
      }, {merge: true});

      // 2) Immutable per-submission record — every CTA form submit is kept,
      // stamped with the real-estate agent behind the page.
      await db.collection("lead_submissions").add({
        page_id: body.page_id,
        listing_id: page.listing_id,
        prospect_name: name,
        prospect_phone: prospectPhone,
        message: message || null,
        source: "landing_page",
        property_title: page.property?.title || "",
        agent: {
          name: page.agent?.name || "",
          brand_name: page.agent?.brand_name || "",
          phone: page.agent?.phone || page.business_phone,
          license: page.agent?.license || "",
        },
        agent_phone: page.business_phone,
        created_at: new Date(),
      });

      // 3) Counter.
      await pageDoc.ref.update({lead_count: FieldValue.increment(1)});

      // 4) WhatsApp the agent — best-effort.
      try {
        await sendWhatsAppMessage(
          page.business_phone,
          `🔔 ליד חדש מדף הנכס "${page.property.title}"!\n` +
          `👤 ${name}\n📞 0${prospectPhone.slice(3)}\n` +
          `דברו איתו עכשיו: https://wa.me/${prospectPhone}`,
          greenApiInstance.value(),
          greenApiToken.value()
        );
      } catch (err) {
        logger.error("lead notify failed (lead still saved):", err);
      }

      // 5) Hand into Forly Leads Handler — fire and forget.
      const webhook = n8nLeadWebhookUrl.value();
      if (webhook) {
        axios.post(webhook, {
          phone: prospectPhone,
          name,
          message: message || null,
          source: "landing_page",
          page_id: body.page_id,
          listing_id: page.listing_id,
          agent_phone: page.business_phone,
          agent: {
            name: page.agent?.name || "",
            brand_name: page.agent?.brand_name || "",
            phone: page.agent?.phone || page.business_phone,
            license: page.agent?.license || "",
          },
        }, {timeout: 10000}).catch((err) => {
          logger.error("leads-handler webhook failed:", err?.message || err);
        });
      }

      res.json({ok: true});
    } catch (err) {
      logger.error("submitPropertyLead failed:", err);
      res.status(500).json({error: "internal"});
    }
  }
);

// ────────────────────────────────────────────────────────────
// trackPropertyEvent — POST beacon { page_id, event }
// ────────────────────────────────────────────────────────────
const EVENTS = new Set(["view", "scroll_50", "scroll_90", "video_play", "cta_click"]);

export const trackPropertyEvent = onRequest({cors: false}, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("POST only");
    return;
  }
  // sendBeacon posts text/plain — parse either shape.
  let body: {page_id?: string; event?: string} = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch { /* ignore */ }
  const {page_id: pageId, event} = body;
  if (!pageId || !event || !EVENTS.has(event)) {
    res.status(204).send("");
    return;
  }
  try {
    const ref = db.collection("property_pages").doc(pageId);
    const day = new Date().toISOString().slice(0, 10);
    const updates: Promise<unknown>[] = [
      ref.collection("metrics").doc(day)
        .set({[event]: FieldValue.increment(1)}, {merge: true}),
    ];
    if (event === "view") {
      updates.push(ref.update({view_count: FieldValue.increment(1)}));
    }
    await Promise.all(updates);
  } catch (err) {
    logger.warn("trackPropertyEvent failed:", err);
  }
  res.status(204).send("");
});
