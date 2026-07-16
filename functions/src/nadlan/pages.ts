import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import {v4 as uuidv4} from "uuid";
import {db, pad, downloadAndUpload, pageBaseUrl, nadlanJwtSecret} from "../shared";
import {requireAuth} from "./auth";
import {
  AgentInfo, PropertyInfo, GalleryImage, CarouselSlide, AreaInfo, CtaInfo,
  PropertyPage, PAGE_LIFESPAN_DAYS, daysFromNow,
} from "./types";

const PAGES = "property_pages";

interface CreatePageBody {
  listing_id?: string;
  business_phone?: string;
  video_url?: string;
  poster_url?: string | null;
  photos?: Array<{url: string; caption?: string}>;
  agent?: Partial<AgentInfo>;
  property?: Partial<PropertyInfo>;
  hero_phrase?: string;
  carousel_slides?: CarouselSlide[];
  area?: Partial<AreaInfo>;
  cta?: Partial<CtaInfo>;
}

function guessImageExt(url: string): string {
  const m = url.split("?")[0].match(/\.(png|webp|jpe?g)$/i);
  if (!m) return "jpg";
  return m[1].toLowerCase() === "png" ? "png" : m[1].toLowerCase() === "webp" ? "webp" : "jpg";
}

// ────────────────────────────────────────────────────────────
// createPropertyPage — POST from n8n Property Page Builder.
// Idempotent per listing: an existing non-archived page is updated in place.
// Re-hosts every asset under property_pages/{id}/ so pages never break when
// source URLs expire.
// ────────────────────────────────────────────────────────────
export const createPropertyPage = onRequest(
  {timeoutSeconds: 300, memory: "1GiB", cors: false},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const body = req.body as CreatePageBody;
    if (!body.listing_id || !body.business_phone || !body.video_url ||
        !body.photos || body.photos.length < 1) {
      res.status(400).json({error: "listing_id, business_phone, video_url and photos are required"});
      return;
    }

    // The gallery must never show the same photo twice — drop duplicate
    // source URLs before hosting anything.
    const seenPhotoUrls = new Set<string>();
    const uniquePhotos = body.photos.filter((p) => {
      if (!p.url || seenPhotoUrls.has(p.url)) return false;
      seenPhotoUrls.add(p.url);
      return true;
    });
    if (uniquePhotos.length < 1) {
      res.status(400).json({error: "photos must contain at least one valid url"});
      return;
    }

    try {
      // Idempotency: reuse an existing page for this listing.
      const existing = await db.collection(PAGES)
        .where("listing_id", "==", body.listing_id)
        .limit(5).get();
      const reusable = existing.docs.find((d) => d.get("status") !== "archived");
      const pageId = reusable ? reusable.id : uuidv4();
      const base = `${PAGES}/${pageId}`;

      const videoUp = downloadAndUpload(body.video_url, `${base}/walkthrough.mp4`, "video/mp4");
      const posterUp = body.poster_url ?
        downloadAndUpload(body.poster_url, `${base}/poster.jpg`, "image/jpeg") :
        downloadAndUpload(uniquePhotos[0].url, `${base}/poster.jpg`, "image/jpeg");
      const photoUps = uniquePhotos.slice(0, 12).map((p, i) => {
        const ext = guessImageExt(p.url);
        return downloadAndUpload(p.url, `${base}/photo-${pad(i + 1)}.${ext}`, `image/${ext === "jpg" ? "jpeg" : ext}`);
      });
      const mapUp = body.area?.map_image_url ?
        downloadAndUpload(body.area.map_image_url, `${base}/map.png`, "image/png") : null;
      const logoUp = body.agent?.logo_url ?
        downloadAndUpload(body.agent.logo_url, `${base}/logo.png`, "image/png") : null;

      const [video, poster, ...rest] = await Promise.all([
        videoUp, posterUp, ...photoUps,
        ...(mapUp ? [mapUp] : []), ...(logoUp ? [logoUp] : []),
      ]);
      const photos = rest.slice(0, photoUps.length);
      let cursor = photoUps.length;
      const map = mapUp ? rest[cursor++] : null;
      const logo = logoUp ? rest[cursor++] : null;

      const galleryImages: GalleryImage[] = photos.map((p, i) => ({
        url: p.publicUrl,
        caption: uniquePhotos[i].caption || "",
      }));

      const now = new Date();
      const doc: PropertyPage = {
        page_id: pageId,
        listing_id: body.listing_id,
        business_phone: body.business_phone,
        status: "active",
        created_at: reusable ? (reusable.get("created_at") as Date) : now,
        updated_at: now,
        expires_at: reusable ?
          (reusable.get("expires_at") as Date) : daysFromNow(PAGE_LIFESPAN_DAYS),
        reminder_sent_at: reusable ? (reusable.get("reminder_sent_at") as Date | null) : null,
        extension_count: reusable ? ((reusable.get("extension_count") as number) || 0) : 0,
        edit_count: reusable ? ((reusable.get("edit_count") as number) || 0) : 0,
        agent: {
          name: body.agent?.name || "",
          brand_name: body.agent?.brand_name || body.agent?.name || "",
          logo_url: logo ? logo.publicUrl : null,
          tagline: body.agent?.tagline || "",
          phone: body.agent?.phone || body.business_phone,
          license: body.agent?.license || "",
        },
        property: {
          title: body.property?.title ||
            `${body.property?.rooms || ""} חד׳ ב${body.property?.neighborhood || body.property?.city || ""}`.trim(),
          address: body.property?.address || "",
          neighborhood: body.property?.neighborhood || "",
          city: body.property?.city || "",
          price: Number(body.property?.price) || 0,
          rooms: Number(body.property?.rooms) || 0,
          size_sqm: Number(body.property?.size_sqm) || 0,
          floor: Number(body.property?.floor) || 0,
          parking: Number(body.property?.parking) || 0,
        },
        hero: {
          phrase: body.hero_phrase || "",
          video_url: video.publicUrl,
          poster_url: poster.publicUrl,
        },
        gallery: {images: galleryImages},
        carousel: {slides: (body.carousel_slides || []).slice(0, 6)},
        area: {
          blurb: body.area?.blurb || "",
          stops: body.area?.stops || [],
          stats: (body.area?.stats || []).filter((s) => !!s.source_url),
          map_image_url: map ? map.publicUrl : null,
          profile_slug: body.area?.profile_slug || null,
        },
        cta: {
          headline: body.cta?.headline || "רוצים לראות את הנכס מקרוב?",
          sub: body.cta?.sub || "השאירו פרטים ונחזור אליכם לתיאום ביקור.",
          bullets: body.cta?.bullets || [],
          button_label: body.cta?.button_label || "תיאום ביקור",
        },
        sections: {gallery: galleryImages.length >= 3, carousel: true, area: true},
        view_count: reusable ? ((reusable.get("view_count") as number) || 0) : 0,
        lead_count: reusable ? ((reusable.get("lead_count") as number) || 0) : 0,
      };

      await db.collection(PAGES).doc(pageId).set(doc);
      await db.collection("listings").doc(body.listing_id)
        .set({page_id: pageId}, {merge: true});

      res.json({
        page_id: pageId,
        page_url: `${pageBaseUrl.value()}/p/${pageId}`,
      });
    } catch (err) {
      logger.error("createPropertyPage failed:", err);
      res.status(500).json({error: err instanceof Error ? err.message : "internal error"});
    }
  }
);

// ────────────────────────────────────────────────────────────
// getPropertyPage — GET ?id= ; public payload for the /p/ page
// ────────────────────────────────────────────────────────────
export const getPropertyPage = onRequest({cors: false}, async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    res.status(400).json({error: "missing id"});
    return;
  }
  const doc = await db.collection(PAGES).doc(id).get();
  if (!doc.exists) {
    res.status(404).json({error: "not found"});
    return;
  }
  const d = doc.data() as PropertyPage;

  if (d.status === "expired" || d.status === "archived") {
    res.set("Cache-Control", "public, max-age=60");
    res.json({
      page_id: id,
      status: d.status,
      property: {title: d.property.title},
      agent: {name: d.agent.name, brand_name: d.agent.brand_name, phone: d.agent.phone},
    });
    return;
  }
  if (d.status === "building") {
    res.status(404).json({error: "not ready"});
    return;
  }

  res.set("Cache-Control", "public, max-age=60");
  res.json({
    page_id: id,
    status: d.status,
    agent: d.agent,
    property: d.property,
    hero: d.hero,
    gallery: d.gallery,
    carousel: d.carousel,
    area: d.area,
    cta: d.cta,
    sections: d.sections,
  });
});

// ────────────────────────────────────────────────────────────
// updatePropertyPage — POST from the agent dashboard (owner only).
// Whitelist-merge of editable paths; edit_count++.
// ────────────────────────────────────────────────────────────
export const updatePropertyPage = onRequest(
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
    const body = req.body as {
      page_id?: string;
      hero_phrase?: string;
      property?: Partial<PropertyInfo>;
      gallery_images?: GalleryImage[];
      carousel_slides?: Array<Partial<CarouselSlide>>;
      cta?: Partial<CtaInfo>;
      sections?: Partial<{gallery: boolean; carousel: boolean; area: boolean}>;
    };
    if (!body.page_id) {
      res.status(400).json({error: "missing page_id"});
      return;
    }

    const ref = db.collection(PAGES).doc(body.page_id);
    const doc = await ref.get();
    if (!doc.exists) {
      res.status(404).json({error: "not found"});
      return;
    }
    const d = doc.data() as PropertyPage;
    if (d.business_phone !== phone) {
      res.status(403).json({error: "not_owner"});
      return;
    }

    const update: Record<string, unknown> = {
      updated_at: new Date(),
      edit_count: (d.edit_count || 0) + 1,
    };
    if (typeof body.hero_phrase === "string") {
      update["hero.phrase"] = body.hero_phrase.slice(0, 80);
    }
    if (body.property) {
      const allowed: Array<keyof PropertyInfo> =
        ["title", "address", "neighborhood", "city", "price", "rooms", "size_sqm", "floor", "parking"];
      for (const k of allowed) {
        if (body.property[k] !== undefined) update[`property.${k}`] = body.property[k];
      }
    }
    if (Array.isArray(body.gallery_images)) {
      // Only reorder/caption/remove of already-hosted images (same-bucket URLs).
      // Dedupe by URL so the gallery never ends up with the same image twice.
      const current = new Set(d.gallery.images.map((i) => i.url));
      const kept = new Set<string>();
      const next = body.gallery_images
        .filter((i) => {
          if (!current.has(i.url) || kept.has(i.url)) return false;
          kept.add(i.url);
          return true;
        })
        .map((i) => ({url: i.url, caption: String(i.caption || "").slice(0, 60)}));
      if (next.length >= 1) update["gallery.images"] = next;
    }
    if (Array.isArray(body.carousel_slides)) {
      const slides = d.carousel.slides.map((s, i) => {
        const patch = body.carousel_slides![i] || {};
        return {
          num: s.num,
          title: String(patch.title ?? s.title).slice(0, 60),
          body: String(patch.body ?? s.body).slice(0, 300),
          tag: String(patch.tag ?? s.tag).slice(0, 30),
        };
      });
      update["carousel.slides"] = slides;
    }
    if (body.cta) {
      if (typeof body.cta.headline === "string") update["cta.headline"] = body.cta.headline.slice(0, 80);
      if (typeof body.cta.sub === "string") update["cta.sub"] = body.cta.sub.slice(0, 200);
      if (typeof body.cta.button_label === "string") update["cta.button_label"] = body.cta.button_label.slice(0, 30);
    }
    if (body.sections) {
      for (const k of ["gallery", "carousel", "area"] as const) {
        if (typeof body.sections[k] === "boolean") update[`sections.${k}`] = body.sections[k];
      }
    }

    await ref.update(update);
    res.json({ok: true, edit_count: update.edit_count});
  }
);
