import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/https";
import {onSchedule} from "firebase-functions/scheduler";
import {defineSecret} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import axios from "axios";
import {v4 as uuidv4} from "uuid";

admin.initializeApp();
setGlobalOptions({region: "europe-west1", maxInstances: 10});

const bucket = admin.storage().bucket();
const db = admin.firestore();

const greenApiInstance = defineSecret("GREENAPI_INSTANCE");
const greenApiToken = defineSecret("GREENAPI_TOKEN");
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

const ALLOWED_ORIGIN = "https://editor.call4li.com";

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

// ────────────────────────────────────────────────────────────
// slideChat — the per-slide AI assistant. Takes the current slide HTML + a
// natural-language instruction (+ short chat history) and returns a one-line
// reply plus the full, modified slide HTML.
// ────────────────────────────────────────────────────────────
const SLIDE_CHAT_MODEL = "claude-sonnet-4-6";

const SLIDE_CHAT_SYSTEM = `You are an expert front-end designer editing ONE \
Instagram carousel slide. The slide is a self-contained HTML document that \
renders at exactly 1080x1350 px, right-to-left (Hebrew).

You receive the slide's full current HTML and an instruction. Apply ONLY the \
requested change and return the COMPLETE updated HTML document.

Hard rules:
- Keep the canvas exactly 1080x1350; keep body { width:1080px; height:1350px; \
overflow:hidden; direction:rtl }.
- Preserve everything not mentioned in the instruction (structure, text, \
colours, positions). Make the smallest change that satisfies the request.
- Self-contained only: inline <style>, optional Google Fonts <link>. NEVER add \
<script>, event handlers, or external JS.
- Keep all content within ~60px safe margins; never let text overflow the right \
edge (it gets clipped in export).
- Do not add editor-only classes/attributes (e.g. __editor-*, contenteditable).

Respond in this exact format:
1) One short sentence (in the user's language) summarising what you changed.
2) Then the full HTML inside a single \`\`\`html code fence.`;

function extractReplyAndHtml(text: string): {reply: string; html: string} {
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const html = fence ? fence[1].trim() : "";
  let reply = fence ? text.slice(0, fence.index).trim() : text.trim();
  reply = reply.replace(/```/g, "").trim();
  return {reply: reply || "עודכן.", html};
}

function sanitizeSlideHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<script[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");
}

interface ChatTurn { role: "user" | "assistant"; content: string }

export const slideChat = onRequest(
  {timeoutSeconds: 120, memory: "512MiB", cors: false, secrets: [anthropicApiKey]},
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

    const body = req.body as {
      html?: string;
      message?: string;
      history?: ChatTurn[];
    };
    const html = (body.html || "").trim();
    const message = (body.message || "").trim();
    if (!html || !message) {
      res.status(400).json({error: "html and message are required"});
      return;
    }

    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .slice(-8)
      .map((t) => ({role: t.role, content: t.content}));

    const messages = [
      ...history,
      {role: "user" as const, content: `Current slide HTML:\n\n${html}\n\n---\nInstruction: ${message}`},
    ];

    try {
      const resp = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {model: SLIDE_CHAT_MODEL, max_tokens: 8000, system: SLIDE_CHAT_SYSTEM, messages},
        {
          headers: {
            "x-api-key": anthropicApiKey.value(),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          timeout: 110000,
        }
      );

      const data = resp.data as {content?: Array<{type: string; text?: string}>};
      const text = (data.content || [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text as string)
        .join("");
      const {reply, html: newHtml} = extractReplyAndHtml(text);
      if (!newHtml) {
        res.status(502).json({error: "assistant did not return HTML", reply});
        return;
      }
      res.json({reply, html: sanitizeSlideHtml(newHtml)});
    } catch (err) {
      logger.error("slideChat failed:", err);
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
