# n8n — WW1: carry the agent's own video into the gallery

Goal: when an agent uploads **both** a video and photos and chooses "create a
tour from my photos too", we still generate the tour (hero video) from the
photos **and** show the agent's uploaded video as the **first** item in the
gallery.

## What changed on the backend

`functions/src/nadlan/properties.ts` now sends a new field on the WW1 webhook
payload (the generate-from-photos path). The uploaded video is stored on the
listing as `gallery_video_url` and forwarded to WW1:

```json
{
  "phone": "9725XXXXXXXX",
  "image_urls": ["https://…/photo-1.jpg", "…"],
  "gallery_video_url": "https://…/agent-upload.mp4",   // NEW — may be null
  "listing_id": "…",
  "trigger_source": "dashboard",
  "property_details": { "address": "…", "city": "…", "price": 0, "…": "…" }
}
```

- `gallery_video_url` is **null** in the normal case (photos only, or the agent
  chose "use my video" — that path skips WW1 entirely and hits the Pipeline
  webhook with `own_video_url` instead). Only act when it is a non-empty string.
- The generated tour video is unchanged: it is still the **hero** video.
  `gallery_video_url` is a **separate** clip that belongs in the **gallery**,
  not the hero.

## What WW1 must do

**One change: forward `gallery_video_url` unchanged to the Property Page
Builder call.** WW1 already generates the tour from `image_urls` and then POSTs
to `createPropertyPage`. Add `gallery_video_url` to that POST body:

```jsonc
// POST → createPropertyPage (Property Page Builder)
{
  "listing_id":     "{{ $json.listing_id }}",
  "business_phone": "{{ $json.phone }}",
  "video_url":      "{{ $json.generated_tour_url }}",   // hero — unchanged
  "gallery_video_url": "{{ $json.gallery_video_url }}", // NEW — pass through as-is
  "photos":         [ /* { url, caption } … as today */ ]
}
```

Do **not** generate anything from `gallery_video_url` — it is a finished asset.
Just pass the URL straight through. If it is null/absent, omit it or send null;
the builder treats that as "no gallery video" (today's behaviour).

## Backend side still required (not n8n)

`createPropertyPage` (`functions/src/nadlan/pages.ts`) must accept the new
`gallery_video_url`, re-host it under `property_pages/{id}/`, and **prepend** it
to the gallery as the first item. This needs:

1. `GalleryImage` (in `types.ts`) to gain an optional media type so a gallery
   item can be a video, e.g. `{ url, caption, kind?: "image" | "video" }`.
2. `createPropertyPage` to host `gallery_video_url` (like it hosts
   `video_url`) and unshift `{ url, kind: "video" }` onto `galleryImages`.
3. The page templates + gallery renderer to play a `kind: "video"` item.

Until (1)–(3) ship, forwarding `gallery_video_url` from WW1 is a no-op: the
builder ignores unknown fields, so it is safe to add the pass-through first.

> Note: because `createPropertyPage` already loads the listing from Firestore
> (for the agent fallback, see `pages.ts` ~L77), an alternative to the WW1
> pass-through is to read `gallery_video_url` directly off the listing doc there
> and skip the n8n change entirely. Pick one path; don't do both.
