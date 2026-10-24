# WW1 Walkthrough V4 — MiniMax H3 + Hebrew voice + music (plan)

**Goal:** a new n8n workflow, *WW1 Walkthrough V4*, that turns a listing's photos into
(1) a narrated Hebrew reel for WhatsApp/groups (subtitles, opening tag, end card,
music, ≈5 MB) and (2) the property page's clean video + separate narration and
music tracks, which the page plays (runtime.js, commit `e02c182`).
V3 (`HScWoZXiVjXoRQLt`) stays untouched and live until V4 is switched in.

**Proven in this session** (listing rymks-78k72): space-mapped multi-reference
clips on `minimax/h3/reference-to-video`, narration on `fal-ai/gemini-3.1-flash-tts`,
music on `fal-ai/lyria2`, ffmpeg render (scratch `render2.py`), ≈ $1.30 per reel.

## Architecture

n8n keeps orchestration and every paid model call (so models/prices are swappable
in n8n, like V3's Seedance node). The Forly server keeps what n8n can't do well:
planning (vision + prompts) and ffmpeg. Same split as V3.

```
Execute Trigger → Check Quota → Validate Quota → Quota OK?
  → Plan Reel            POST /api/walkthrough/plan {…, model:"h3", script:true}
  → Split Lines → TTS (fal sync, 1 item per line)       ┐
  → Music (fal sync, Lyria 2, 1 item)                   ├ run before clips: cheap, ~20 s
  → Split Clips → Submit H3 (fal queue)                 ┘
  → Prepare Polling → Poll Loop → Wait 15s → Fan Out → Poll H3 Status → Aggregate
      (failed → resubmit once, same static-data retry as V3)
  → Collect Clip URLs
  → Render Reel          POST /api/reel/render
  → Send reel to agent → Send reel to admin group
  → Build Landing Page   webhook property-page-builder (+ narration_url, music_url)
  → Log Cost             (Code → admin group message / Firestore)
```

## Server work (Forly, this repo — I build + test it)

1. **Space map joins the same room** — `server/space-map.js` prompt. Today
   photos 2/3/4 of one living room (same sofa, hanging chair, pendants) came back
   as 3 spaces. Add the rule "same distinctive furniture seen from another angle =
   same space" and a test with that case in `space-map.test.js`.
2. **H3 mode for the plan** — `server/walkthrough-plan.js` + `routes/walkthrough.js`:
   `model:"h3"` → prompts reference `Image N` (not `@imageN`), durations 5–15 s
   (H3 minimum 5), multi-photo spaces get a 2-shot "hard cut between angles" clip
   (the living-room clip that worked). Max 9 refs/clip stays.
3. **Script in the plan** — same endpoint, `script:true`: one Claude Haiku call
   writes, per clip, `narration` (Hebrew, numbers in words, ≤ the clip's
   seconds × ~13 chars) and `subtitle` (digits, explicit `\N` line break), plus
   `tag` ("למכירה · <city>") and `end_card` {name, brand, phone, price_line}
   from `property_details` + agent. Validated server-side (lengths, Hebrew only,
   phone format); falls back to template lines on failure. Tests.
4. **`POST /api/reel/render`** — new `server/reel.js` (port of `render2.py`),
   reusing `overlay.js` helpers (download, probe, run, Heebo fontsdir):
   - in: `clip_urls[]`, `narration_urls[]` (per clip), `music_url`, `subtitles[]`,
     `tag`, `end_card`, `end_bg_image_url`
   - per line: trim silence, atempo 1.08; shot = max(min, narration + 0.7 s);
     clip slowed to fit if shorter than its shot; 0.3 s fade crossfades; line
     starts 0.25 s into its shot; ASS styles all `Encoding: -1`; 3.4 s end card
     over the blurred last photo; music under voice with light ducking
     (threshold 0.1, ratio 2), no fades; libx264 crf 23, maxrate 2.5M, aac 128k.
   - out (uploaded to /files): `reel_url` (≈5 MB), `clean_video_url` (no text,
     no audio, no end card), `narration_url` (one timed track, mp3),
     `music_url` (bed, level baked ~-3 dB — iOS ignores audio.volume),
     `duration`.
   - Unit tests for the timeline math and ASS builder; one ffmpeg smoke test.
5. **Page create/update stores the tracks** — `routes/pages.js`: accept
   `narration_url` / `music_url` on create (rehost like `video_url`) into
   `hero.narration_url` / `hero.music_url`. Tests.
6. **Deploy** templates (runtime.js) to hosting and the server — only on your go.

## n8n work — new workflow "WW1 Walkthrough V4"

Start as a duplicate of V3 (keeps credentials: quota googleApi, plan header
auth, WhatsApp). New credential: **fal** (Header Auth, `Authorization: Key <FAL_KEY>`).

| Node | Type | Config |
|---|---|---|
| Plan Reel | HTTP POST (V3's Plan Walkthrough) | body adds `model:"h3", script:true`, timeout 180 s |
| Split Lines | Code | `plan.script.lines` → 1 item per line `{i, text}` |
| TTS | HTTP POST `https://fal.run/fal-ai/gemini-3.1-flash-tts` | `{prompt: text, voice:"Kore", language_code:"Hebrew (Israel)", output_format:"wav", style_instructions:"warm Israeli Hebrew, upbeat agent, no pauses at start/end"}`, fal cred, timeout 120 s, retry 2 |
| Music | HTTP POST `https://fal.run/fal-ai/lyria2` | `{prompt: plan.script.music_prompt, negative_prompt:"vocals, singing, low quality"}`, execute once, timeout 180 s |
| Split Clips | Code (V3) | unchanged |
| Submit H3 | HTTP POST `https://queue.fal.run/minimax/h3/reference-to-video` | `{prompt, reference_image_urls: image_urls, duration, resolution:"768P", aspect_ratio:"9:16", prompt_expansion_mode:"disabled"}` |
| Prepare Polling | Code (V3) | keep `status_url` + `response_url` per clip instead of `task_id` |
| Poll H3 Status | HTTP GET `{{status_url}}` | fal cred |
| Aggregate Clip Status | Code (V3) | `COMPLETED` → GET `response_url` → `video.url`; `FAILED` → retry once |
| Render Reel | HTTP POST `/api/reel/render` | clips + TTS `audio.url`s + Lyria `audio.url` + plan script; timeout 600 s, retry on fail |
| Send file ×2 | (V3) | `file_url = reel_url` |
| Build Landing Page | (V3) | `video_url = clean_video_url`, `post_video_url = reel_url`, + `narration_url`, `music_url` |
| Log Cost | Code → WhatsApp admin group | H3 `$0.05 × Σduration` + TTS `$0.05/1k chars` + Lyria `$0.10` |

**Property Page Builder** (`csEnTziNFrNNHaE9`): its publish node must forward
`narration_url` and `music_url` to `POST /api/page` — one body edit.

**Switch-over:** the gateways (Dashboard Intake, Router) call V3 via Execute
Workflow; point them at V4 only after tests pass. V3 stays as rollback.

## Test plan

1. Server: `npm test` (new space-map, plan, script, render, pages tests).
2. V4 manual run with pinned trigger data for rymks-78k72 (8 photos) → compare
   to today's reel: living room joined into one 2-angle clip, subtitles in
   order, end card, file ≈ 5 MB, page assets present.
3. Page: staging page with the three URLs, check tap-to-start on a real iPhone
   and Android Chrome (autoplay with sound is blocked until a tap).
4. One real WhatsApp group post to confirm size/quality.

## Cost per reel (fal list prices)

| Item | Estimate |
|---|---|
| H3 768P, 4–6 clips, 23–35 s | $1.15–1.75 |
| Gemini TTS, ~200–300 chars | $0.01–0.04 |
| Lyria 2, one 30 s track | $0.10 |
| Claude Haiku map + script | ~$0.03 |
| **Total** | **≈ $1.30–1.90** |

## Risks

- H3 invents views not in the photos (the bedroom reverse angle). Mitigation:
  single-photo spaces get a stricter "stay in the photo's frame" prompt; the
  admin-group copy lets you spot bad cuts before posting.
- Lyria loop seam on pages longer than 32 s; TTS pacing varies per line (shots
  stretch to fit, clips slow ≤ ~15%).
- Browsers never autoplay sound before a tap — the page starts on first tap.
