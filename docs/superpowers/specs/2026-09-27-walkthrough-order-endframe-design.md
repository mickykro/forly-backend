# Walkthrough video: frame order, drone opener, end-frame style

Workflow: n8n "WW1 Walkthrough V2" (`YrEYXgCgjKg8vje9`). Server: `server/overlay.js`.
Motivating run: execution 145395 — opened on a master bedroom, bathroom mid-video,
end titles on a black box.

## Goals

1. The video opens and closes on the property's best, most flattering frames.
2. An exterior opener reads as a drone flying into the property.
3. End titles match the reference style (bold Hebrew, warm colour, gold swoosh),
   legible on light and dark closing frames.

Out of scope: WhatsApp edit requests (separate spec).

## 1. Opener / closer selection — n8n `Curate Photos`

Runs on **all** tagged photos (`is_real_estate !== false && quality_score >= 4`),
before the 12-photo cap, so the chosen frames are never cut.

Type groups (Vision Tagger `room_type`):

| Group | Types |
|---|---|
| OUTDOOR | exterior, garden, roof, pool, view |
| LOUNGE | living_room, open_plan |
| BALCONY | balcony |
| BANNED_EDGE | bedroom, master_bedroom, kids_room, bathroom, toilet, hallway, and any type containing `shower` |

"Best" = highest `quality_score`; ties keep upload order.

- **Opener**: best OUTDOOR → else best LOUNGE → else best photo not in BANNED_EDGE.
- **Closer** (from photos other than the opener):
  - opener OUTDOOR → best LOUNGE → else best BALCONY
  - opener LOUNGE → best BALCONY → else best remaining LOUNGE
  - fallback → best photo not in BANNED_EDGE
- If every photo is BANNED_EDGE, keep the current behaviour (upload order) — never
  fail a video over ordering.
- **Middle**: remaining photos by `quality_score` desc, capped so the total ≤ 12.
- Output `curated = [opener, ...middle, closer]` plus `opener_group`
  (`outdoor` | `lounge` | `other`).

`Plan Clips` keeps its half split, so the opener is clip 0 `@image1` and the
closer is the last image of clip 1.

## 2. Pinning — `Plan Clips` + `Parse Prompt`

- Clip 0 prompt: "@image1 is FIXED as the opening shot; order the others freely."
- Clip 1 prompt: "@image{n} is FIXED as the final shot; order the others freely."
- `Parse Prompt`, after `snapUrls`: if the pinned URL is not in its slot, move it
  there (others keep Sonnet's relative order). Record `pin_repaired: true`.

## 3. Drone opener — `Plan Clips`

When `opener_group === "outdoor"`, clip 0's OPENING SHOT instruction becomes:
"Aerial drone shot: start high and wide above the building, descend and glide
toward it, fly in through the entrance or a window, and dissolve into the next
room." Otherwise: a slow establishing dolly-in on the lounge.

## 4. End-frame style — `server/overlay.js`

- Font: Heebo (OFL), committed as `server/assets/fonts/Heebo[wght].ttf`, passed
  to the `ass` filter via `fontsdir`. Title ExtraBold, other lines SemiBold.
  Heebo ships Latin digits, so no DejaVu fallback is needed for these lines.
- Brightness: one ffmpeg frame grab at `duration - 0.1s`, mean luma of the
  bottom third. `luma > 135` → **light**, else **dark**.
  - light: text `#3B2314` (title, details and phone), no shadow.
  - dark: text `#F7F3EC`, soft blurred shadow (`\shad` + `\blur`).
- Gold swoosh `#C9A45C` under the title: an ASS vector drawing (`\p1`), tapered
  ends, ~85% of the title width, 6px below it.
- Remove the 47% black box (BorderStyle 3) from Title/Sub.
- If the brightness probe fails, default to **dark** (cream + shadow reads on
  anything).
- Room labels stay out of the final `OVERLAY_SECONDS` (existing behaviour, now
  covered by a test).
- Response adds `end_style: "light" | "dark"` for debugging.

## 5. Testing & rollout

- Server unit tests (`overlay.test.js`): luma → style threshold; `buildAss`
  emits Heebo, no BorderStyle 3 on titles, brown vs cream colours per style, a
  `\p1` swoosh event; no room segment overlaps the title window.
- n8n: ordering function tested locally in node against the 145395 tags (and a
  no-exterior and an all-bedroom case) before pasting into the Code node.
- Deploy server to staging, replay 145395's stitch against staging.
- Duplicate the workflow as "WW1 Walkthrough V2 – staging" with the stitch node
  pointed at `staging.srv1173890.hstgr.cloud`; one full run (2 Seedance clips).
- After approval: apply the same node changes to the live workflow and merge the
  server change to `main`.
