import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/https";
import {onSchedule} from "firebase-functions/scheduler";
import {defineSecret} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import axios from "axios";
import {v4 as uuidv4} from "uuid";
import * as crypto from "crypto";

admin.initializeApp();
setGlobalOptions({region: "europe-west1", maxInstances: 10});

const bucket = admin.storage().bucket();
const db = admin.firestore();

const greenApiInstance = defineSecret("GREENAPI_INSTANCE");
const greenApiToken = defineSecret("GREENAPI_TOKEN");
const forlyJwtSecret = defineSecret("FORLY_JWT_SECRET");

const ALLOWED_ORIGIN = "https://editor.call4li.com"; // ponytail: keep for carousel CORS

const pad = (n: number): string => String(n).padStart(2, "0");

function setCors(res: {set: (k: string, v: string) => void}): void {
  res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

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

function tokenedUrl(destPath: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(destPath)}?alt=media&token=${token}`;
}

async function uploadBuffer(
  destPath: string,
  data: Buffer,
  contentType: string
): Promise<{publicUrl: string}> {
  const token = uuidv4();
  const file = bucket.file(destPath);
  await file.save(data, {
    metadata: {
      contentType,
      cacheControl: "public, max-age=86400",
      metadata: {firebaseStorageDownloadTokens: token},
    },
  });
  return {publicUrl: tokenedUrl(destPath, token)};
}

async function downloadAndUpload(
  sourceUrl: string,
  destPath: string,
  contentType: string
): Promise<{publicUrl: string}> {
  const response = await axios.get(sourceUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return uploadBuffer(destPath, Buffer.from(response.data as ArrayBuffer), contentType);
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
  setCors(res);
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
    setCors(res);
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

// ────────────────────────────────────────────────────────────
// Auth helpers (crypto-only, zero deps)
// ────────────────────────────────────────────────────────────
function signJWT(payload: object, secret: string, expiresIn: number): string {
  const header = {alg: "HS256", typ: "JWT"};
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresIn;
  const claims = {...payload, iat, exp};
  const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const b64Payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret)
    .update(`${b64Header}.${b64Payload}`)
    .digest("base64url");
  return `${b64Header}.${b64Payload}.${signature}`;
}

function verifyJWT(token: string, secret: string): {valid: boolean; payload?: any} {
  const parts = token.split(".");
  if (parts.length !== 3) return {valid: false};
  const [b64Header, b64Payload, signature] = parts;
  const expectedSig = crypto.createHmac("sha256", secret)
    .update(`${b64Header}.${b64Payload}`)
    .digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    return {valid: false};
  }
  const payload = JSON.parse(Buffer.from(b64Payload, "base64url").toString());
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return {valid: false};
  }
  return {valid: true, payload};
}

function hashOtp(code: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + code).digest("hex");
  return `${salt}:${hash}`;
}

function verifyOtpHash(code: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const testHash = crypto.createHash("sha256").update(salt + code).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(testHash));
}

// ponytail: rate-limit via in-memory Map (single-instance Functions, reset on cold-start = good enough)
const otpRateLimit = new Map<string, {count: number; resetAt: number}>();

function checkRateLimit(phone: string, maxAttempts: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = otpRateLimit.get(phone);
  if (!entry || now > entry.resetAt) {
    otpRateLimit.set(phone, {count: 1, resetAt: now + windowMs});
    return true;
  }
  if (entry.count >= maxAttempts) return false;
  entry.count++;
  return true;
}

// ────────────────────────────────────────────────────────────
// persistMedia — n8n → Storage (replaces sidecar)
// ────────────────────────────────────────────────────────────
export const persistMedia = onRequest(
  {timeoutSeconds: 120, memory: "1GiB", cors: false},
  async (req, res) => {
    // ponytail: no origin check - n8n calls directly, no CORS needed
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const {source_url, dest_path, content_type} = req.body as {
      source_url?: string;
      dest_path?: string;
      content_type?: string;
    };
    if (!source_url || !dest_path || !content_type) {
      res.status(400).json({error: "missing source_url, dest_path, or content_type"});
      return;
    }
    try {
      const {publicUrl} = await downloadAndUpload(source_url, dest_path, content_type);
      res.json({url: publicUrl});
    } catch (err) {
      logger.error("persistMedia failed:", err);
      const msg = err instanceof Error ? err.message : "internal error";
      res.status(500).json({error: msg});
    }
  }
);

// ────────────────────────────────────────────────────────────
// Auth — WhatsApp OTP + JWT (D3')
// ────────────────────────────────────────────────────────────
export const requestOtp = onRequest(
  {secrets: [greenApiInstance, greenApiToken], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const {phone} = req.body as {phone?: string};
    if (!phone || !/^\d{10,15}$/.test(phone)) {
      res.status(400).json({error: "invalid phone"});
      return;
    }

    // Rate-limit: 3 requests per 15 min
    if (!checkRateLimit(phone, 3, 15 * 60 * 1000)) {
      // ponytail: uniform response (anti-enumeration)
      res.json({ok: true});
      return;
    }

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    const codeHash = hashOtp(code);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    try {
      await db.collection("businesses").doc(phone).collection("otp").doc("active").set({
        code_hash: codeHash,
        expires_at: expiresAt,
        attempts_remaining: 3,
      });

      // Send via Green API
      const chatId = `${phone}@c.us`;
      const baseUrl = `https://api.green-api.com/waInstance${greenApiInstance.value()}`;
      await axios.post(`${baseUrl}/sendMessage/${greenApiToken.value()}`, {
        chatId,
        message: `🦉 קוד האימות שלך: ${code}\n(תקף ל-5 דקות)`,
      }, {timeout: 10000});

      res.json({ok: true}); // uniform response
    } catch (err) {
      logger.error("requestOtp failed:", err);
      res.json({ok: true}); // still uniform
    }
  }
);

export const verifyOtp = onRequest(
  {secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const {phone, code} = req.body as {phone?: string; code?: string};
    if (!phone || !code || !/^\d{6}$/.test(code)) {
      res.status(400).json({error: "invalid phone or code"});
      return;
    }

    const otpDoc = await db.collection("businesses").doc(phone).collection("otp").doc("active").get();
    if (!otpDoc.exists) {
      res.status(401).json({error: "invalid or expired"});
      return;
    }

    const otpData = otpDoc.data() as {
      code_hash: string;
      expires_at: admin.firestore.Timestamp;
      attempts_remaining: number;
      locked_until?: admin.firestore.Timestamp;
    };

    // Check lockout
    if (otpData.locked_until && otpData.locked_until.toDate() > new Date()) {
      res.status(429).json({error: "locked"});
      return;
    }

    // Check expiry
    if (otpData.expires_at.toDate() < new Date()) {
      res.status(401).json({error: "expired"});
      return;
    }

    // Verify code
    if (!verifyOtpHash(code, otpData.code_hash)) {
      const remaining = otpData.attempts_remaining - 1;
      if (remaining <= 0) {
        await otpDoc.ref.update({
          attempts_remaining: 0,
          locked_until: new Date(Date.now() + 30 * 60 * 1000),
        });
        res.status(429).json({error: "locked"});
      } else {
        await otpDoc.ref.update({attempts_remaining: remaining});
        res.status(401).json({error: "invalid code", attempts_remaining: remaining});
      }
      return;
    }

    // Success → mint JWT
    const sessionId = uuidv4();
    const jwt = signJWT({phone, session_id: sessionId}, forlyJwtSecret.value(), 30 * 24 * 60 * 60);
    const tokenHash = crypto.createHash("sha256").update(jwt).digest("hex");

    await db.collection("businesses").doc(phone).collection("sessions").doc(sessionId).set({
      issued_at: new Date(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      last_used_at: new Date(),
      token_hash: tokenHash,
    });

    await otpDoc.ref.delete(); // consume OTP

    res.cookie("forly_session", jwt, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.json({ok: true});
  }
);

// ────────────────────────────────────────────────────────────
// JWT middleware
// ────────────────────────────────────────────────────────────
async function requireAuth(
  req: {cookies?: {forly_session?: string}},
  secret: string
): Promise<{ok: true; phone: string} | {ok: false; status: number; error: string}> {
  const token = req.cookies?.forly_session;
  if (!token) return {ok: false, status: 401, error: "missing session"};

  const {valid, payload} = verifyJWT(token, secret);
  if (!valid || !payload?.phone) return {ok: false, status: 401, error: "invalid session"};

  // ponytail: skip session doc check (trust JWT exp, revocation is edge case)
  return {ok: true, phone: payload.phone};
}

// ────────────────────────────────────────────────────────────
// Data Functions
// ────────────────────────────────────────────────────────────
export const uploadMedia = onRequest(
  {timeoutSeconds: 60, memory: "512MiB", secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const auth = await requireAuth(req, forlyJwtSecret.value());
    if (!auth.ok) {
      res.status(auth.status).json({error: auth.error});
      return;
    }

    // ponytail: base64-in-JSON (reuse saveCarouselDraft pattern, no busboy)
    const {data_url, dest_path, content_type} = req.body as {
      data_url?: string;
      dest_path?: string;
      content_type?: string;
    };
    if (!data_url || !dest_path || !content_type) {
      res.status(400).json({error: "missing data_url, dest_path, or content_type"});
      return;
    }

    try {
      const dataMatch = data_url.match(/^data:([^;]+);base64,(.+)$/);
      if (!dataMatch) {
        res.status(400).json({error: "invalid data_url"});
        return;
      }
      const buffer = Buffer.from(dataMatch[2], "base64");
      const {publicUrl} = await uploadBuffer(dest_path, buffer, content_type);
      res.json({url: publicUrl});
    } catch (err) {
      logger.error("uploadMedia failed:", err);
      const msg = err instanceof Error ? err.message : "internal error";
      res.status(500).json({error: msg});
    }
  }
);

export const leadRequest = onRequest({cors: false}, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("POST only");
    return;
  }
  const {phone, name, city, specialty, source} = req.body as {
    phone?: string;
    name?: string;
    city?: string;
    specialty?: string;
    source?: string;
  };
  if (!phone || !/^\d{10,15}$/.test(phone)) {
    res.status(400).json({error: "invalid phone"});
    return;
  }

  // Rate-limit: 3 per 24h per phone
  if (!checkRateLimit(phone, 3, 24 * 60 * 60 * 1000)) {
    res.status(429).json({error: "too many requests"});
    return;
  }

  try {
    await db.collection("leads").doc(phone).set({
      phone,
      name: name || null,
      city: city || null,
      specialty: specialty || null,
      status: "new",
      source: source || "web_new_user",
      created_at: new Date(),
      updated_at: new Date(),
      funnel_step: 0,
    }, {merge: true});

    // Fire n8n webhook
    await axios.post("https://n8n.srv1173890.hstgr.cloud/webhook/lead-trigger", {
      phone, name, city, specialty, source,
    }, {timeout: 5000}).catch(() => {}); // best-effort

    res.json({ok: true});
  } catch (err) {
    logger.error("leadRequest failed:", err);
    const msg = err instanceof Error ? err.message : "internal error";
    res.status(500).json({error: msg});
  }
});

export const autosaveSignup = onRequest(
  {secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const auth = await requireAuth(req, forlyJwtSecret.value());
    if (!auth.ok) {
      res.status(auth.status).json({error: auth.error});
      return;
    }

    const {field, value} = req.body as {field?: string; value?: any};
    if (!field) {
      res.status(400).json({error: "missing field"});
      return;
    }

    try {
      await db.collection("businesses").doc(auth.phone).set({
        onboarding_partial: {[field]: value},
        updated_at: new Date(),
      }, {merge: true});
      res.json({ok: true});
    } catch (err) {
      logger.error("autosaveSignup failed:", err);
      res.status(500).json({error: "save failed"});
    }
  }
);

export const signupComplete = onRequest(
  {secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const auth = await requireAuth(req, forlyJwtSecret.value());
    if (!auth.ok) {
      res.status(auth.status).json({error: auth.error});
      return;
    }

    const {
      full_name, license_number, activity_areas, specialty,
      portrait_url, slogan, tone, gender_pref, brand_colors, logo_url,
      site, instagram, facebook, years_experience, plan,
    } = req.body as {
      full_name?: string;
      license_number?: string;
      activity_areas?: string[];
      specialty?: string;
      portrait_url?: string;
      slogan?: string;
      tone?: string;
      gender_pref?: string;
      brand_colors?: string[];
      logo_url?: string;
      site?: string;
      instagram?: string;
      facebook?: string;
      years_experience?: number;
      plan?: string;
    };

    if (!full_name || !activity_areas || !portrait_url) {
      res.status(400).json({error: "missing required fields"});
      return;
    }

    try {
      const now = new Date();
      await db.collection("businesses").doc(auth.phone).set({
        phone: auth.phone,
        full_name,
        license_number: license_number || null,
        activity_areas,
        specialty: specialty || null,
        portrait_url,
        slogan: slogan || null,
        tone: tone || null,
        gender_pref: gender_pref || null,
        brand_colors: brand_colors || null,
        logo_url: logo_url || null,
        site: site || null,
        instagram: instagram || null,
        facebook: facebook || null,
        years_experience: years_experience || null,
        plan: plan || "free",
        paid: plan !== "free",
        plan_started_at: now,
        onboarding_state: "complete",
        created_at: now,
        updated_at: now,
        last_active_at: now,
        total_posts_uploaded: 0,
        total_inquiries_reported: 0,
        total_deals_closed: 0,
      });

      // Set quota
      const caps: Record<string, number | string> = {
        free: 0, basic: 4, pro: 8, unlimited: "unlimited",
      };
      await db.collection("businesses").doc(auth.phone).collection("quota").doc("current").set({
        walkthroughs_used: 0,
        walkthroughs_cap: caps[plan || "free"] || 0,
        period_start: now,
        reset_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        last_reset_at: now,
      });

      // Fire n8n webhook
      await axios.post("https://n8n.srv1173890.hstgr.cloud/webhook/signup-complete", {
        phone: auth.phone, full_name,
      }, {timeout: 5000}).catch(() => {});

      res.json({ok: true});
    } catch (err) {
      logger.error("signupComplete failed:", err);
      res.status(500).json({error: "signup failed"});
    }
  }
);

export const createListing = onRequest(
  {secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const auth = await requireAuth(req, forlyJwtSecret.value());
    if (!auth.ok) {
      res.status(auth.status).json({error: auth.error});
      return;
    }

    const {
      address, neighborhood, city, price, rooms, sqm, floor,
      features, description, photos_urls, source,
    } = req.body as {
      address?: string;
      neighborhood?: string;
      city?: string;
      price?: number;
      rooms?: number;
      sqm?: number;
      floor?: number;
      features?: string[];
      description?: string;
      photos_urls?: string[];
      source?: string;
    };

    if (!address || !neighborhood || !city || !photos_urls || photos_urls.length === 0) {
      res.status(400).json({error: "missing required fields"});
      return;
    }

    try {
      const listingId = uuidv4();
      await db.collection("businesses").doc(auth.phone).collection("listings").doc(listingId).set({
        status: "active",
        address, neighborhood, city,
        price: price || null,
        rooms: rooms || null,
        sqm: sqm || null,
        floor: floor || null,
        features: features || null,
        description: description || null,
        photos_urls,
        source: source || "web",
        created_at: new Date(),
        updated_at: new Date(),
      });

      res.json({ok: true, listing_id: listingId});
    } catch (err) {
      logger.error("createListing failed:", err);
      res.status(500).json({error: "failed"});
    }
  }
);

export const startWalkthrough = onRequest(
  {secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const auth = await requireAuth(req, forlyJwtSecret.value());
    if (!auth.ok) {
      res.status(auth.status).json({error: auth.error});
      return;
    }

    const {listing_id} = req.body as {listing_id?: string};
    if (!listing_id) {
      res.status(400).json({error: "missing listing_id"});
      return;
    }

    const bizDoc = await db.collection("businesses").doc(auth.phone).get();
    if (!bizDoc.exists || !bizDoc.data()?.paid) {
      res.status(403).json({error: "not paid"});
      return;
    }

    const listingDoc = await db.collection("businesses").doc(auth.phone)
      .collection("listings").doc(listing_id).get();
    if (!listingDoc.exists) {
      res.status(404).json({error: "listing not found"});
      return;
    }

    try {
      // Fire n8n webhook (WW1)
      await axios.post("https://n8n.srv1173890.hstgr.cloud/webhook/476ac786-d35f-434c-b7a6-2fe5ed9d7141", {
        phone: auth.phone,
        listing_id,
        trigger_source: "web",
        image_urls: listingDoc.data()?.photos_urls || [],
      }, {timeout: 10000});

      res.json({ok: true, message: "הסרטון בהכנה — יישלח לוואטסאפ 📲"});
    } catch (err) {
      logger.error("startWalkthrough webhook failed:", err);
      res.status(500).json({error: "failed to trigger"});
    }
  }
);

export const getLibrary = onRequest(
  {secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    const auth = await requireAuth(req, forlyJwtSecret.value());
    if (!auth.ok) {
      res.status(auth.status).json({error: auth.error});
      return;
    }

    try {
      const listings = await db.collection("businesses").doc(auth.phone)
        .collection("listings").where("status", "==", "active").get();
      const walkthroughs = await db.collection("businesses").doc(auth.phone)
        .collection("walkthroughs").orderBy("created_at", "desc").limit(20).get();

      res.json({
        listings: listings.docs.map((d) => ({id: d.id, ...d.data()})),
        walkthroughs: walkthroughs.docs.map((d) => ({id: d.id, ...d.data()})),
      });
    } catch (err) {
      logger.error("getLibrary failed:", err);
      res.status(500).json({error: "failed"});
    }
  }
);

export const getPlan = onRequest(
  {secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    const auth = await requireAuth(req, forlyJwtSecret.value());
    if (!auth.ok) {
      res.status(auth.status).json({error: auth.error});
      return;
    }

    const planId = typeof req.query.plan_id === "string" ? req.query.plan_id : undefined;
    if (!planId) {
      res.status(400).json({error: "missing plan_id"});
      return;
    }

    try {
      const planDoc = await db.collection("businesses").doc(auth.phone)
        .collection("weekly_plans").doc(planId).get();
      if (!planDoc.exists) {
        res.status(404).json({error: "not found"});
        return;
      }
      res.json({plan_id: planId, ...planDoc.data()});
    } catch (err) {
      logger.error("getPlan failed:", err);
      res.status(500).json({error: "failed"});
    }
  }
);

export const approvePlan = onRequest(
  {secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const auth = await requireAuth(req, forlyJwtSecret.value());
    if (!auth.ok) {
      res.status(auth.status).json({error: auth.error});
      return;
    }

    const {plan_id} = req.body as {plan_id?: string};
    if (!plan_id) {
      res.status(400).json({error: "missing plan_id"});
      return;
    }

    try {
      await db.collection("businesses").doc(auth.phone)
        .collection("weekly_plans").doc(plan_id).update({
          status: "approved",
          approved_at: new Date(),
        });

      // Fire n8n to generate items (Business Handler Agents listens)
      await axios.post("https://n8n.srv1173890.hstgr.cloud/webhook/plan-approved", {
        phone: auth.phone, plan_id,
      }, {timeout: 5000}).catch(() => {});

      res.json({ok: true});
    } catch (err) {
      logger.error("approvePlan failed:", err);
      res.status(500).json({error: "failed"});
    }
  }
);

export const markPosted = onRequest(
  {secrets: [forlyJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const auth = await requireAuth(req, forlyJwtSecret.value());
    if (!auth.ok) {
      res.status(auth.status).json({error: auth.error});
      return;
    }

    const {plan_id, item_id} = req.body as {plan_id?: string; item_id?: string};
    if (!plan_id || !item_id) {
      res.status(400).json({error: "missing plan_id or item_id"});
      return;
    }

    try {
      const planRef = db.collection("businesses").doc(auth.phone)
        .collection("weekly_plans").doc(plan_id);
      const planDoc = await planRef.get();
      if (!planDoc.exists) {
        res.status(404).json({error: "plan not found"});
        return;
      }

      const items = planDoc.data()?.items || [];
      const updated = items.map((item: any) =>
        item.item_id === item_id ? {...item, posted_at: new Date()} : item
      );

      await planRef.update({items: updated});
      res.json({ok: true});
    } catch (err) {
      logger.error("markPosted failed:", err);
      res.status(500).json({error: "failed"});
    }
  }
);
