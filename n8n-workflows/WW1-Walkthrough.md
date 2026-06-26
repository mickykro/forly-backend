# WW1 — Walkthrough Sub-Workflow

**Type:** Sub-workflow (called by Business Handler Agents, Forly Walkthrough Trigger)
**Status:** New (inactive draft)
**Input:** `{phone, listing_id, trigger_source, image_urls[]}`
**Output:** `{ok: bool, video_url?: string, failed_reason?: string}`

## Flow (Part 10.3)

### 1. Trigger
- executeWorkflowTrigger
- Receives: phone, listing_id, trigger_source, image_urls[]

### 2. Idempotency check
- **Code node**: `idempotency_key = sha1(listing_id + trigger_source + YYYY-MM-DD)`
- **Firestore GET**: `businesses/{phone}/walkthroughs` where `idempotency_key == key`
  - If `status == "generating"` → return `{ok: false, message: "כבר בייצור ⏳"}`
  - If `status == "completed"` → return existing video_url
  - Else continue

### 3. Quota transaction
- **Firestore GET**: `businesses/{phone}/quota/current`
- **Code node**:
  ```js
  if (cap === "unlimited") return {proceed: true};
  if (used >= cap) return {proceed: false, reason: "quota"};
  return {proceed: true, charge: true};
  ```
- **If quota exceeded**:
  - WhatsApp send: "הגעת לתקרה השבועית 🦉 (מתאפס יום שני). 'שדרוג'?"
  - Return `{ok: false}`
- **Else**: Firestore UPDATE quota `used++`, set `quota_charged: true`

### 4. Create walkthrough doc
- **Firestore CREATE**: `businesses/{phone}/walkthroughs/{uuid}`
  ```json
  {
    listing_id, trigger_source, idempotency_key,
    status: "generating", created_at: now, total_chunks: 0,
    chunks: [], ordered_image_refs: []
  }
  ```

### 5. Vision tags
- **Firestore GET**: `businesses/{phone}/listings/{listing_id}`
- **Code**: check if `photo_tags` exist & fresh (`tagged_at > now-7d`)
  - If fresh → use cached
  - Else → Execute Vision Tagger → store tags on listing

### 6. Curation (Code node)
```js
// Drop non-RE & low-quality
const curated = tags
  .filter(t => t.is_real_estate !== false && t.quality_score >= 4)
  // Dedupe by room_type, keep top 3/type
  .reduce((acc, t) => {
    const group = acc[t.room_type] || [];
    if (group.length < 3) group.push(t);
    acc[t.room_type] = group.sort((a,b) => b.quality_score - a.quality_score);
    return acc;
  }, {});
const final = Object.values(curated).flat().slice(0, 25);

if (final.length < 3) {
  // Refund quota, send WhatsApp "צריך לפחות 3 תמונות 📸"
  return {ok: false, reason: "insufficient_photos"};
}
return {curated: final};
```

### 7. Prompt generation (Sonnet, D33)
- **HTTP Request**: Anthropic API
  - Model: `claude-sonnet-4-5-20250929`
  - Max tokens: 2000
  - System: "You order real-estate photos cinematically and generate a Seedance prompt referencing them as @image1…@imageN."
  - User: JSON of curated tags
  - Expected JSON output:
    ```json
    {
      "ordered_images": [{url, room_type}, ...],
      "prompt": "Camera glides from @image1 (exterior wide) to @image2 (entrance close-up)…",
      "final_title_1": "דירה בתל אביב",
      "final_title_2": "3 חדרים, קומה 2"
    }
    ```
  - Append GUARDRAIL to prompt: "Do not invent rooms, doors, hallways, or furniture not visible. Maintain exact architecture. One smooth transition — no double cuts, no flashbacks."
- **Fallback on bad JSON**: deterministic room_arc sort + generic cinematic prompt

### 8. Chunker (Code)
```js
const n = ordered_images.length;
const chunks = n <= 9 ? [[0, n]] :
               n <= 17 ? [[0, 9], [8, n]] :  // overlap last frame as bridge
               [[0, 9], [8, 17], [16, n]];   // cap 25
return {chunks, total_chunks: chunks.length};
```

### 9. Per-chunk loop (sequential)
For each `chunk_index` in `0…total_chunks-1`:

#### 9a. Progress update
- WhatsApp send: `⚙️ יוצרת חלק ${chunk_index+1}/${total_chunks}…`

#### 9b. Seedance submit
- **HTTP POST**: `https://api.seedance2.ai/v1/videos/generations`
- **Headers**: `Authorization: Bearer {{$credentials.seedanceApi.apiKey}}`
- **Body**:
  ```json
  {
    "model": "seedance-2-0-fast",
    "task_type": "reference-to-video",
    "aspect_ratio": "9:16",
    "resolution": "720p",
    "duration": 8,
    "generate_audio": true,
    "return_last_frame": (total_chunks > 1 && chunk_index < total_chunks-1),
    "image_urls": ordered_images.slice(chunk.start, chunk.end).map(i => i.url),
    "prompt": generated_prompt + GUARDRAIL,
    "negative_prompt": "people, faces, text overlay, watermark, distorted architecture"
  }
  ```
- **Response**: `{taskId, credits}`
- **Firestore PATCH** walkthrough chunk: `{task_id, status: "generating", started_at}`
- **Firestore CREATE** event: `walkthrough_credit_used {credits, cost_usd}`

#### 9c. Poll Seedance (Wait 30s loop, max 20 iterations)
- **Wait 30s**
- **HTTP GET**: `https://api.seedance2.ai/v1/tasks/{taskId}`
- **Status**:
  - `completed`:
    - HTTP POST `persistMedia` Function: `{source_url: video_url, dest_path: videos/{wt_id}/chunk_{i}.mp4, content_type: video/mp4}` → get Storage URL
    - If `return_last_frame` requested: persist `last_frame_url` → `bridge_frames/{wt_id}/{i}.jpg`
    - Patch chunk: `{status: "completed", video_url, last_frame_url?, completed_at}`
  - `queued|generating`: continue loop
  - `failed`:
    - Retry once (submit again)
    - If still fails: refund quota, notify, patch chunk `{status: "failed"}`

#### 9d. Mid-poll update (at poll #10)
- WhatsApp send: "עדיין יוצרים… ⏳ הכל תקין!"

#### 9e. Bridge frame handling (multi-chunk)
- If chunk > 0 && prior chunk has `last_frame_url`:
  - Prepend `last_frame_url` to current chunk's `image_urls` (overlap for smooth transition)

### 10. Stitch (multi-chunk, deferred — build-gated)
**Skipped in MVP.** Multi-chunk only ships when a listing needs >9 photos.
- When built: `ffmpegConcat` Function (Cloud Function with static-ffmpeg binary, 2GiB mem)
- For single-chunk: `final_video_url = chunk_0.video_url`

### 11. Deliver (Green API)
- **HTTP POST**: `https://api.green-api.com/waInstance{INSTANCE}/sendFileByUrl/{TOKEN}`
- **Body**:
  ```json
  {
    "chatId": "{phone}@c.us",
    "urlFile": final_video_url,
    "fileName": "walkthrough.mp4",
    "caption": "{address}, {rooms} חדרים, {sqm}מ\"ר, {price}₪\n💡 שעת שיא: 18:00-20:00\n\nלערוך? כתוב 'עריכה'"
  }
  ```
- **Retry once** on failure

### 12. Finalize
- **Firestore PATCH** walkthrough:
  ```json
  {
    status: "completed",
    completed_at: now,
    final_video_url,
    generated_prompt,
    ordered_image_refs: ordered_images.map(i => i.url)
  }
  ```
- **Firestore PATCH** listing: `last_walkthrough_id`
- **Firestore CREATE** event: `walkthrough_completed`

### 13. Library link (+30s delay)
- **Wait 30s**
- WhatsApp send: "📚 https://app.call4li.com/library"

## Credentials

- Firestore: Google Service Account OAuth2
- Anthropic: Header Auth (`x-api-key`)
- Seedance: Header Auth (`Authorization: Bearer`)
- Green API: Instance/Token in URL
- persistMedia: Function URL (no auth needed from n8n)

## Error handling

- Quota exceeded → refund + notify
- <3 photos after curation → refund + notify
- Seedance fail after retry → refund + notify + mark failed
- All errors write to `failed_reason` field

## Notes

- Single-chunk MVP (≤9 photos)
- Multi-chunk build-gated (D6)
- No prompt templates (D33) — generated per-property
- Native audio from Seedance (D4)
- Progress updates (D29) reduce abandonment
