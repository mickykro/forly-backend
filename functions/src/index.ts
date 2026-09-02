import {onRequest} from "firebase-functions/https";
import {onSchedule} from "firebase-functions/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import axios from "axios";
import {v4 as uuidv4} from "uuid";
import {
  db, bucket, pad, setCors, uploadBuffer, downloadAndUpload,
  greenApiInstance, greenApiToken,
} from "./shared";

const ALLOWED_ORIGIN = "https://editor.call4li.com";

// cleanupExpiredDrafts (below) relies on this being stamped at creation time.
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The carousel_id (a v4 UUID) is the editor's capability — the editor page has
// no login. These caps bound what someone who obtains a draft id can do:
// they cannot spam the owner's WhatsApp on every save, run the draft's edit
// count / storage up without limit, or push oversized slide payloads.
const MAX_DRAFT_EDITS = 100;
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000; // ≤1 WhatsApp notification / 5 min / draft
const MAX_SLIDE_HTML_BYTES = 256 * 1024;
const MAX_SLIDE_PNG_BYTES = 6 * 1024 * 1024;
const MAX_SLIDES = 5;

interface InboundSlide {
  index: number;
  png_url: string;
  html_url: string;
}

interface SavedSlideEdit {
  index: number;
  html: string;
  png_base64: string;
}

interface StoredSlide {
  index: number;
  png_url: string;
  html_url: string;
}

// ────────────────────────────────────────────────────────────
// 1) createCarouselDraft — called from n8n after Manus completes
// ────────────────────────────────────────────────────────────
export const createCarouselDraft = onRequest(
  {timeoutSeconds: 120, memory: "512MiB", cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const body = req.body as {
      business_phone?: string;
      caption?: string;
      format?: string;
      slides?: InboundSlide[];
    };
    if (!body.slides || body.slides.length !== 5) {
      res.status(400).json({error: "slides must have exactly 5 items"});
      return;
    }

    const carouselId = uuidv4();
    const now = Date.now();

    try {
      const uploadResults = await Promise.all(
        body.slides.flatMap((slide) => [
          downloadAndUpload(
            slide.png_url,
            `carousel_drafts/${carouselId}/slide-${pad(slide.index)}.png`,
            "image/png"
          ),
          downloadAndUpload(
            slide.html_url,
            `carousel_drafts/${carouselId}/slide-${pad(slide.index)}.html`,
            "text/html"
          ),
        ])
      );

      const slidesByIndex: Record<number, StoredSlide> = {};
      body.slides.forEach((s, i) => {
        slidesByIndex[s.index] = {
          index: s.index,
          png_url: uploadResults[i * 2].publicUrl,
          html_url: uploadResults[i * 2 + 1].publicUrl,
        };
      });

      await db.collection("carousel_drafts").doc(carouselId).set({
        business_phone: body.business_phone,
        created_at: new Date(now),
        expires_at: new Date(now + DRAFT_TTL_MS),
        status: "active",
        slide_count: 5,
        format: body.format || "1080x1350",
        caption: body.caption || "",
        edit_count: 0,
        slides: Object.values(slidesByIndex),
      });

      res.json({
        carousel_id: carouselId,
        editor_url: `https://call4li.web.app/c/${carouselId}`,
        slide_png_urls: Object.values(slidesByIndex).map((s) => s.png_url),
      });
    } catch (err) {
      logger.error("createCarouselDraft failed:", err);
      const msg = err instanceof Error ? err.message : "internal error";
      res.status(500).json({error: msg});
    }
  }
);

// ────────────────────────────────────────────────────────────
// 2) getCarouselDraft — called from the editor page on load
// ────────────────────────────────────────────────────────────
export const getCarouselDraft = onRequest({cors: false}, async (req, res) => {
  setCors(res, ALLOWED_ORIGIN);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  const id = typeof req.query.id === "string" ? req.query.id : undefined;
  if (!id) {
    res.status(400).json({error: "missing id"});
    return;
  }

  const doc = await db.collection("carousel_drafts").doc(id).get();
  if (!doc.exists) {
    res.status(404).json({error: "not found"});
    return;
  }

  const data = doc.data() as admin.firestore.DocumentData;

  res.json({
    carousel_id: id,
    slides: data.slides,
    caption: data.caption,
    format: data.format,
    edit_count: data.edit_count,
  });
});

// ────────────────────────────────────────────────────────────
// 3) saveCarouselDraft — called from the editor on save
// ────────────────────────────────────────────────────────────
export const saveCarouselDraft = onRequest(
  {
    timeoutSeconds: 300,
    memory: "1GiB",
    secrets: [greenApiInstance, greenApiToken],
    cors: false,
  },
  async (req, res) => {
    setCors(res, ALLOWED_ORIGIN);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }

    const {carousel_id: carouselId, slides} = req.body as {
      carousel_id?: string;
      slides?: SavedSlideEdit[];
    };
    if (!carouselId || !Array.isArray(slides) || slides.length < 1 || slides.length > MAX_SLIDES) {
      res.status(400).json({error: "invalid body"});
      return;
    }
    // Reject oversized slide payloads before doing any work.
    for (const s of slides) {
      const htmlBytes = Buffer.byteLength(String(s.html || ""), "utf8");
      const pngBytes = Math.ceil(String(s.png_base64 || "").length * 3 / 4);
      if (htmlBytes > MAX_SLIDE_HTML_BYTES || pngBytes > MAX_SLIDE_PNG_BYTES) {
        res.status(413).json({error: "slide too large"});
        return;
      }
    }

    const docRef = db.collection("carousel_drafts").doc(carouselId);
    const doc = await docRef.get();
    if (!doc.exists) {
      res.status(404).json({error: "not found"});
      return;
    }
    const data = doc.data() as admin.firestore.DocumentData;

    // Bound total edits per draft (storage + abuse).
    if (((data.edit_count as number) || 0) >= MAX_DRAFT_EDITS) {
      res.status(429).json({error: "edit_limit_reached"});
      return;
    }

    const editVersion = ((data.edit_count as number) || 0) + 1;

    try {
      const newSlides: StoredSlide[] = await Promise.all(
        slides.map(async (slide) => {
          const htmlPath =
            `carousel_drafts/${carouselId}/v${editVersion}/slide-${pad(slide.index)}.html`;
          const pngPath =
            `carousel_drafts/${carouselId}/v${editVersion}/slide-${pad(slide.index)}.png`;

          const htmlUpload = await uploadBuffer(htmlPath, Buffer.from(slide.html, "utf8"), "text/html");
          const pngBuffer = Buffer.from(
            slide.png_base64.replace(/^data:image\/png;base64,/, ""),
            "base64"
          );
          const pngUpload = await uploadBuffer(pngPath, pngBuffer, "image/png");

          return {
            index: slide.index,
            html_url: htmlUpload.publicUrl,
            png_url: pngUpload.publicUrl,
          };
        })
      );

      // Throttle owner notifications: at most one WhatsApp per cooldown window
      // per draft, so a save loop (or someone editing a draft they shouldn't)
      // can't flood the owner's phone.
      const lastNotifiedMs = data.last_notified_at ?
        (data.last_notified_at as admin.firestore.Timestamp).toMillis() : 0;
      const mayNotify = Date.now() - lastNotifiedMs >= NOTIFY_COOLDOWN_MS;

      await docRef.update({
        slides: newSlides,
        edit_count: editVersion,
        last_edited_at: new Date(),
        status: "edited",
        ...(mayNotify && data.business_phone ? {last_notified_at: new Date()} : {}),
      });

      // WhatsApp send is best-effort — never let it fail the whole save.
      if (data.business_phone && mayNotify) {
        try {
          await sendUpdatedPngsToWhatsApp(
            data.business_phone as string,
            newSlides,
            greenApiInstance.value(),
            greenApiToken.value()
          );
        } catch (err) {
          logger.error("Green-API send failed (save still succeeded):", err);
        }
      }

      res.json({
        carousel_id: carouselId,
        edit_version: editVersion,
        slide_png_urls: newSlides.map((s) => s.png_url),
      });
    } catch (err) {
      logger.error("saveCarouselDraft failed:", err);
      const msg = err instanceof Error ? err.message : "internal error";
      res.status(500).json({error: msg});
    }
  }
);

async function sendUpdatedPngsToWhatsApp(
  phone: string,
  slides: StoredSlide[],
  instance: string,
  token: string
): Promise<void> {
  const chatId = `${phone}@c.us`;
  const baseUrl = `https://api.green-api.com/waInstance${instance}`;
  const REQ_TIMEOUT_MS = 20000;

  await axios.post(`${baseUrl}/sendMessage/${token}`, {
    chatId,
    message: "✏️ הקרוסלה המעודכנת שלך:",
  }, {timeout: REQ_TIMEOUT_MS});

  // Send all 5 PNGs in parallel — Green-API handles concurrent calls fine.
  await Promise.all(slides.map((s) =>
    axios.post(`${baseUrl}/sendFileByUrl/${token}`, {
      chatId,
      urlFile: s.png_url,
      fileName: `slide-${pad(s.index)}.png`,
      caption: `${s.index}/${slides.length}`,
    }, {timeout: REQ_TIMEOUT_MS})
  ));
}

// ────────────────────────────────────────────────────────────
// 4) cleanupExpiredDrafts — scheduled, every 6 hours
// ────────────────────────────────────────────────────────────
export const cleanupExpiredDrafts = onSchedule("every 6 hours", async () => {
  const now = new Date();
  const expired = await db
    .collection("carousel_drafts")
    .where("expires_at", "<", now)
    .limit(100)
    .get();

  for (const doc of expired.docs) {
    try {
      await bucket.deleteFiles({prefix: `carousel_drafts/${doc.id}/`});
      await doc.ref.delete();
    } catch (err) {
      logger.error(`cleanup failed for ${doc.id}:`, err);
    }
  }
  logger.log(`cleaned ${expired.size} expired drafts`);
});

// ════════════════════════════════════════════════════════════
// SIGNUP WEB FORM — moved out of Functions.
// The 15-field profile form ("השלמת פרופיל") now lives entirely in the
// intake server: public-agent/profile.html, server/routes/profile.js and
// server/profile-onboarding.js, reached at agent.call4li.com/profile.
// signupGet / signupSave / signupComplete / signupUpload took the phone from
// the request body with no authentication, so any caller could read or
// overwrite any agent's profile; the server routes take it from the session
// cookie instead. Portrait and logo uploads go through the shared
// /api/upload-urls flow rather than a base64 endpoint.
// ════════════════════════════════════════════════════════════
