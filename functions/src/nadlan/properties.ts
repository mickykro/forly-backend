import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import axios from "axios";
import {v4 as uuidv4} from "uuid";
import {
  db, bucket, tokenedUrl, nadlanJwtSecret, demoSecret, pageBaseUrl,
  n8nWw1WebhookUrl, n8nPipelineWebhookUrl,
} from "../shared";
import {requireAuth} from "./auth";
import {AgentInfo, Listing, PropertyPage} from "./types";

const MAX_UPLOAD_FILES = 12;
const MAX_UPLOAD_MB = 10;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime"]);

// ────────────────────────────────────────────────────────────
// getUploadUrls — POST { files: [{name, contentType}] }
// V4 signed PUT URLs; browser uploads straight to Storage.
// Auth: session cookie OR demo secret header (x-demo-key).
// NOTE: runtime SA needs roles/iam.serviceAccountTokenCreator for V4 signing.
// ────────────────────────────────────────────────────────────
export const getUploadUrls = onRequest(
  {secrets: [nadlanJwtSecret, demoSecret], cors: false},
  async (req, res) => {
    // DEBUG: dump the whole request to diagnose auth. Remove before launch.
    const gotKey = String(req.headers["x-demo-key"] || "");
    logger.info("getUploadUrls DEBUG", {
      method: req.method,
      headers: req.headers,
      body: req.body,
      cookie: req.headers.cookie || null,
      demo_key_received: gotKey,
      demo_key_received_len: gotKey.length,
      demo_secret_len: demoSecret.value().length,
      demo_key_matches: gotKey === demoSecret.value() && demoSecret.value().length > 0,
    });
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const phone = requireAuth(req);
    const isDemo = String(req.headers["x-demo-key"] || "") === demoSecret.value() &&
      demoSecret.value().length > 0;
    if (!phone && !isDemo) {
      res.status(401).json({error: "unauthenticated"});
      return;
    }
    const owner = phone || "demo";
    const body = req.body as {files?: Array<{name?: string; contentType?: string}>};
    if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > MAX_UPLOAD_FILES) {
      res.status(400).json({error: `1-${MAX_UPLOAD_FILES} files`});
      return;
    }

    try {
      const results = await Promise.all(body.files.map(async (f) => {
        const ct = String(f.contentType || "");
        const isVideo = VIDEO_TYPES.has(ct);
        if (!IMAGE_TYPES.has(ct) && !isVideo) {
          throw new Error(`unsupported type: ${ct}`);
        }
        const ext = ct === "image/png" ? "png" : ct === "image/webp" ? "webp" :
          isVideo ? "mp4" : "jpg";
        const token = uuidv4();
        const path = `agent_uploads/${owner}/${uuidv4()}.${ext}`;
        const file = bucket.file(path);
        const [uploadUrl] = await file.getSignedUrl({
          version: "v4",
          action: "write",
          expires: Date.now() + 15 * 60 * 1000,
          contentType: ct,
          extensionHeaders: {"x-goog-meta-firebaseStorageDownloadTokens": token},
        });
        return {
          name: f.name || path,
          upload_url: uploadUrl,
          content_type: ct,
          public_url: tokenedUrl(path, token),
          max_mb: isVideo ? 120 : MAX_UPLOAD_MB,
        };
      }));
      res.json({files: results});
    } catch (err) {
      logger.error("getUploadUrls failed:", err);
      res.status(400).json({error: err instanceof Error ? err.message : "bad request"});
    }
  }
);

// ── shared create logic ──

interface CreateBody {
  address?: string;
  neighborhood?: string;
  city?: string;
  price?: number;
  rooms?: number;
  size_sqm?: number;
  floor?: number;
  parking?: number;
  description?: string;
  photos_urls?: string[];
  own_video_url?: string | null;
  agent?: Partial<AgentInfo>;
}

async function createListingAndKickPipeline(
  phone: string,
  body: CreateBody,
  agentOverride: Partial<AgentInfo> | null
): Promise<{listing_id: string} | {error: string; code: number}> {
  if (!body.address || !body.city || !body.price || !body.rooms) {
    return {error: "address, city, price, rooms are required", code: 400};
  }
  if (!Array.isArray(body.photos_urls) || body.photos_urls.length < 3) {
    return {error: "at least 3 photos required", code: 400};
  }

  const listingId = uuidv4();
  const listing: Listing = {
    listing_id: listingId,
    business_phone: phone,
    source: "dashboard",
    address: String(body.address).slice(0, 120),
    neighborhood: String(body.neighborhood || "").slice(0, 60),
    city: String(body.city).slice(0, 60),
    price: Number(body.price) || 0,
    rooms: Number(body.rooms) || 0,
    size_sqm: Number(body.size_sqm) || 0,
    floor: Number(body.floor) || 0,
    parking: Number(body.parking) || 0,
    description: String(body.description || "").slice(0, 2000),
    photos_urls: body.photos_urls.slice(0, MAX_UPLOAD_FILES),
    own_video_url: body.own_video_url || null,
    status: "active",
    page_id: null,
    agent: agentOverride ? {
      name: String(agentOverride.name || ""),
      brand_name: String(agentOverride.brand_name || agentOverride.name || ""),
      logo_url: agentOverride.logo_url || null,
      tagline: String(agentOverride.tagline || ""),
      phone: String(agentOverride.phone || phone),
      license: String(agentOverride.license || ""),
    } : null,
    created_at: new Date(),
  };
  await db.collection("listings").doc(listingId).set(listing);

  // Own video → straight to Page Builder; otherwise the WW1 gateway generates
  // the video and WW1's end-hook calls the builder. Bodies match each
  // workflow's input contract exactly.
  const webhook = listing.own_video_url ?
    n8nPipelineWebhookUrl.value() : n8nWw1WebhookUrl.value();
  const hookPayload = listing.own_video_url ? {
    listing_id: listingId,
    business_phone: phone,
    video_url: listing.own_video_url,
  } : {
    phone,
    image_urls: listing.photos_urls,
    listing_id: listingId,
    trigger_source: "dashboard",
    property_details: {
      address: listing.address,
      neighborhood: listing.neighborhood,
      city: listing.city,
      price: listing.price,
      rooms: listing.rooms,
      size_sqm: listing.size_sqm,
      floor: listing.floor,
      parking: listing.parking,
      description: listing.description,
    },
  };
  if (webhook) {
    axios.post(webhook, hookPayload, {timeout: 15000}).catch((err) => {
      logger.error("pipeline webhook failed:", err?.message || err);
    });
  } else {
    logger.warn("no pipeline webhook configured; listing created without page build");
  }
  return {listing_id: listingId};
}

// ────────────────────────────────────────────────────────────
// createProperty — POST (session cookie)
// ────────────────────────────────────────────────────────────
export const createProperty = onRequest(
  {secrets: [nadlanJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const phone = requireAuth(req);
    if (!phone) {
      res.status(401).json({error: "unauthenticated"});
      return;
    }
    const result = await createListingAndKickPipeline(phone, req.body as CreateBody, null);
    if ("error" in result) {
      res.status(result.code).json({error: result.error});
      return;
    }
    res.json({...result, status: "building"});
  }
);

// ────────────────────────────────────────────────────────────
// demoCreateProperty — POST (x-demo-key) with inline agent info.
// Same body as createProperty + agent{}; used for prospect demos.
// ────────────────────────────────────────────────────────────
export const demoCreateProperty = onRequest(
  {secrets: [demoSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    if (String(req.headers["x-demo-key"] || "") !== demoSecret.value() ||
        demoSecret.value().length === 0) {
      res.status(401).json({error: "unauthenticated"});
      return;
    }
    const body = req.body as CreateBody;
    const agentPhone = body.agent?.phone ? String(body.agent.phone) : "";
    if (!agentPhone) {
      res.status(400).json({error: "agent.phone required"});
      return;
    }
    const result = await createListingAndKickPipeline(agentPhone, body, body.agent || {});
    if ("error" in result) {
      res.status(result.code).json({error: result.error});
      return;
    }
    res.json({...result, status: "building"});
  }
);

// ────────────────────────────────────────────────────────────
// getListingStatus — GET ?id= ; building-screen polling
// (open by design: exposes only build progress + page URL)
// ────────────────────────────────────────────────────────────
export const getListingStatus = onRequest({cors: false}, async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    res.status(400).json({error: "missing id"});
    return;
  }
  const doc = await db.collection("listings").doc(id).get();
  if (!doc.exists) {
    res.status(404).json({error: "not found"});
    return;
  }
  const pageId = doc.get("page_id") as string | null;
  res.json({
    listing_id: id,
    page_id: pageId,
    page_url: pageId ? `${pageBaseUrl.value()}/p/${pageId}` : null,
  });
});

// ────────────────────────────────────────────────────────────
// listMyProperties — GET (session cookie)
// ────────────────────────────────────────────────────────────
export const listMyProperties = onRequest(
  {secrets: [nadlanJwtSecret], cors: false},
  async (req, res) => {
    const phone = requireAuth(req);
    if (!phone) {
      res.status(401).json({error: "unauthenticated"});
      return;
    }
    const [listings, pages] = await Promise.all([
      db.collection("listings")
        .where("business_phone", "==", phone)
        .where("status", "in", ["active", "archived"]).get(),
      db.collection("property_pages")
        .where("business_phone", "==", phone).get(),
    ]);
    const pageById = new Map(pages.docs.map((p) => [p.id, p.data() as PropertyPage]));

    const items = listings.docs.map((l) => {
      const d = l.data() as Listing;
      const page = d.page_id ? pageById.get(d.page_id) : undefined;
      const expiresAt = page?.expires_at ?
        (page.expires_at as FirebaseFirestore.Timestamp).toMillis?.() ??
        new Date(page.expires_at as Date).getTime() : null;
      return {
        listing_id: d.listing_id,
        page_id: d.page_id,
        title: page?.property.title || d.address,
        address: d.address,
        listing_status: d.status,
        page_status: page?.status || "building",
        days_left: expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000)) : null,
        view_count: page?.view_count || 0,
        lead_count: page?.lead_count || 0,
        page_url: d.page_id ? `${pageBaseUrl.value()}/p/${d.page_id}` : null,
        thumb_url: page?.gallery.images[0]?.url || d.photos_urls[0] || null,
        created_at: d.created_at,
      };
    }).sort((a, b) => {
      const ta = (a.created_at as FirebaseFirestore.Timestamp).toMillis?.() ?? 0;
      const tb = (b.created_at as FirebaseFirestore.Timestamp).toMillis?.() ?? 0;
      return tb - ta;
    });

    res.json({properties: items});
  }
);

// ────────────────────────────────────────────────────────────
// deleteProperty — POST { listing_id, mode: "archive" | "delete" }
// ────────────────────────────────────────────────────────────
export const deleteProperty = onRequest(
  {secrets: [nadlanJwtSecret], cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const phone = requireAuth(req);
    if (!phone) {
      res.status(401).json({error: "unauthenticated"});
      return;
    }
    const {listing_id: listingId, mode} = req.body as {listing_id?: string; mode?: string};
    if (!listingId || (mode !== "archive" && mode !== "delete")) {
      res.status(400).json({error: "listing_id and mode(archive|delete) required"});
      return;
    }
    const ref = db.collection("listings").doc(listingId);
    const doc = await ref.get();
    if (!doc.exists) {
      res.status(404).json({error: "not found"});
      return;
    }
    if (doc.get("business_phone") !== phone) {
      res.status(403).json({error: "not_owner"});
      return;
    }
    const pageId = doc.get("page_id") as string | null;

    try {
      if (mode === "archive") {
        await ref.update({status: "archived"});
        if (pageId) {
          await db.collection("property_pages").doc(pageId).update({status: "archived"});
        }
      } else {
        await ref.update({status: "deleted"});
        if (pageId) {
          await db.collection("property_pages").doc(pageId).update({status: "archived"});
          await bucket.deleteFiles({prefix: `property_pages/${pageId}/`});
        }
      }
      res.json({ok: true});
    } catch (err) {
      logger.error("deleteProperty failed:", err);
      res.status(500).json({error: "internal"});
    }
  }
);
