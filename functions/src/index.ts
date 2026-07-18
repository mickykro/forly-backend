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
    if (!carouselId || !Array.isArray(slides)) {
      res.status(400).json({error: "invalid body"});
      return;
    }

    const docRef = db.collection("carousel_drafts").doc(carouselId);
    const doc = await docRef.get();
    if (!doc.exists) {
      res.status(404).json({error: "not found"});
      return;
    }
    const data = doc.data() as admin.firestore.DocumentData;

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

      await docRef.update({
        slides: newSlides,
        edit_count: editVersion,
        last_edited_at: new Date(),
        status: "edited",
      });

      // WhatsApp send is best-effort — never let it fail the whole save.
      if (data.business_phone) {
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
// SIGNUP WEB FORM (Forly onboarding — phone-based, no JWT)
// Companion to the WhatsApp signup bot. Lets an impatient agent
// finish the 15-field profile on the web instead of in chat.
// Data model per signup design doc §4/§9.
// ════════════════════════════════════════════════════════════

const TONE_VALUES = ["professional", "friendly", "energetic", "luxury"];
const GENDER_VALUES = ["male", "female", "neutral"];

function normalizePhone(raw: unknown): string {
  return String(raw || "").replace(/[^\d]/g, "");
}

// GET /api/signup-get?phone=...  → returns saved partial so the form prefills
export const signupGet = onRequest({cors: false}, async (req, res) => {
  setCors(res, ALLOWED_ORIGIN);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  const phone = normalizePhone(req.query.phone);
  if (!phone) {
    res.status(400).json({error: "missing phone"});
    return;
  }

  const doc = await db.collection("businesses").doc(phone).get();
  const d = (doc.exists ? doc.data() : {}) as admin.firestore.DocumentData;
  const partial = (d.onboarding_partial || {}) as admin.firestore.DocumentData;

  // merge top-level + partial so the form shows whatever exists
  res.json({
    phone,
    already_complete: d.onboarding_state === "complete",
    profile: {
      full_name: d.full_name ?? partial.full_name ?? "",
      activity_areas: d.activity_areas ?? partial.activity_areas ?? [],
      specialty: d.specialty ?? partial.specialty ?? "",
      license_number: d.license_number ?? partial.license_number ?? "",
      portrait_url: d.portrait_url ?? partial.portrait_url ?? "",
      slogan: d.slogan ?? partial.slogan ?? "",
      tone: d.tone ?? partial.tone ?? "",
      gender_pref: d.gender_pref ?? partial.gender_pref ?? "",
      brand_colors: d.brand_colors ?? partial.brand_colors ?? [],
      logo_url: d.logo_url ?? partial.logo_url ?? "",
      site: d.site ?? partial.site ?? "",
      instagram: d.instagram ?? partial.instagram ?? "",
      facebook: d.facebook ?? partial.facebook ?? "",
      years_experience: d.years_experience ?? partial.years_experience ?? null,
      privacy_consent: Boolean(d.privacy_consent ?? partial.privacy_consent ?? false),
    },
  });
});

// POST /api/signup-upload  {phone, kind:'portrait'|'logo', base64, content_type}
// → uploads to Storage, returns a permanent tokened URL
export const signupUpload = onRequest(
  {timeoutSeconds: 60, memory: "512MiB", cors: false},
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
    const {phone: rawPhone, kind, base64, content_type: contentType} = req.body as {
      phone?: string; kind?: string; base64?: string; content_type?: string;
    };
    const phone = normalizePhone(rawPhone);
    if (!phone || !base64 || (kind !== "portrait" && kind !== "logo")) {
      res.status(400).json({error: "phone, kind (portrait|logo), base64 required"});
      return;
    }
    try {
      const ct = contentType || "image/jpeg";
      const ext = ct.includes("png") ? "png" : "jpg";
      const folder = kind === "portrait" ? "portraits" : "logos";
      const destPath = `${folder}/${phone}.${ext}`;
      const data = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ""), "base64");
      const {publicUrl} = await uploadBuffer(destPath, data, ct);
      res.json({url: publicUrl});
    } catch (err) {
      logger.error("signupUpload failed:", err);
      res.status(500).json({error: "upload failed"});
    }
  }
);

// POST /api/signup-complete  {phone, profile}
// → writes businesses/{phone} (set-merge), inits quota, converts lead, marks complete
export const signupComplete = onRequest(
  {timeoutSeconds: 60, memory: "256MiB", cors: false},
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
    const {phone: rawPhone, profile} = req.body as {
      phone?: string; profile?: Record<string, unknown>;
    };
    const phone = normalizePhone(rawPhone);
    const p = profile || {};
    if (!phone) {
      res.status(400).json({error: "missing phone"});
      return;
    }
    if (p.privacy_consent !== true) {
      res.status(400).json({error: "privacy_consent_required"});
      return;
    }

    // doc §4 60% gate: require the three essentials
    const fullName = String(p.full_name || "").trim();
    const areas = Array.isArray(p.activity_areas) ? p.activity_areas : [];
    const portrait = String(p.portrait_url || "").trim();
    if (!fullName || areas.length === 0 || !portrait) {
      res.status(400).json({
        error: "missing required fields",
        need: ["full_name", "activity_areas", "portrait_url"],
      });
      return;
    }

    const tone = TONE_VALUES.includes(String(p.tone)) ? String(p.tone) : "";
    const gender = GENDER_VALUES.includes(String(p.gender_pref)) ? String(p.gender_pref) : "";
    const years = Number(p.years_experience);

    // completeness percentage (60 essentials + up to 40 optional)
    const optional = [
      p.specialty, p.license_number, p.slogan, tone, gender,
      p.site, p.instagram, p.facebook,
      (Array.isArray(p.brand_colors) && p.brand_colors.length) ? "x" : "",
      p.logo_url, (years > 0 ? "x" : ""),
    ];
    const optN = optional.filter((v) => v !== "" && v != null).length;
    const pct = 60 + Math.round((optN / 11) * 40);
    const now = new Date();

    try {
      const businessRef = db.collection("businesses").doc(phone);
      await businessRef.set({
        full_name: fullName,
        phone,
        activity_areas: areas,
        portrait_url: portrait,
        specialty: String(p.specialty || ""),
        license_number: String(p.license_number || ""),
        slogan: String(p.slogan || ""),
        tone,
        gender_pref: gender,
        brand_colors: Array.isArray(p.brand_colors) ? p.brand_colors : [],
        logo_url: String(p.logo_url || ""),
        site: String(p.site || ""),
        instagram: String(p.instagram || ""),
        facebook: String(p.facebook || ""),
        years_experience: Number.isFinite(years) ? years : 0,
        plan: "trial",
        paid: false,
        onboarding_state: "complete",
        onboarding_pct: pct,
        privacy_consent: true,
        privacy_consent_at: now,
        updated_at: now,
        created_at: now,
      }, {merge: true});

      // init quota/current (subcollection doc) if absent
      const quotaRef = businessRef.collection("quota").doc("current");
      const quotaSnap = await quotaRef.get();
      if (!quotaSnap.exists) {
        await quotaRef.set({
          walkthroughs_used: 0,
          walkthroughs_cap: 4,
          period_start: now,
          reset_at: now,
        });
      }

      // convert lead if one exists
      const leadRef = db.collection("leads").doc(phone);
      const leadSnap = await leadRef.get();
      if (leadSnap.exists) {
        await leadRef.set({status: "converted", converted_at: now}, {merge: true});
      }

      res.json({ok: true, phone, onboarding_pct: pct});
    } catch (err) {
      logger.error("signupComplete failed:", err);
      res.status(500).json({error: "save failed"});
    }
  }
);

// POST /api/signup-save  {phone, profile}
// → autosave: merges into onboarding_partial (shared with the WhatsApp bot), no completion
export const signupSave = onRequest(
  {timeoutSeconds: 30, memory: "256MiB", cors: false},
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
    const {phone: rawPhone, profile} = req.body as {
      phone?: string; profile?: Record<string, unknown>;
    };
    const phone = normalizePhone(rawPhone);
    const p = profile || {};
    if (!phone) {
      res.status(400).json({error: "missing phone"});
      return;
    }
    // No consent yet → nothing gets persisted, not even a partial save.
    if (p.privacy_consent !== true) {
      res.json({ok: false, error: "privacy_consent_required"});
      return;
    }
    try {
      await db.collection("businesses").doc(phone).set({
        privacy_consent: true,
        onboarding_partial: {
          full_name: String(p.full_name || ""),
          activity_areas: Array.isArray(p.activity_areas) ? p.activity_areas : [],
          specialty: String(p.specialty || ""),
          license_number: String(p.license_number || ""),
          portrait_url: String(p.portrait_url || ""),
          slogan: String(p.slogan || ""),
          tone: String(p.tone || ""),
          gender_pref: String(p.gender_pref || ""),
          brand_colors: Array.isArray(p.brand_colors) ? p.brand_colors : [],
          logo_url: String(p.logo_url || ""),
          site: String(p.site || ""),
          instagram: String(p.instagram || ""),
          facebook: String(p.facebook || ""),
          years_experience: Number(p.years_experience) || 0,
        },
        updated_at: new Date(),
      }, {merge: true});
      res.json({ok: true});
    } catch (err) {
      logger.error("signupSave failed:", err);
      res.status(500).json({error: "save failed"});
    }
  }
);
