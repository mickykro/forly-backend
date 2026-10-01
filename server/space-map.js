/*
 * space-map.js — groups a listing's photos into the physical spaces they show.
 *
 * Seedance invents what a reference photo does not show: a door past the frame
 * edge, a corridor to "walk" from one room into the next. The walkthrough is
 * therefore planned per space (walkthrough-plan.js): every clip stays inside one
 * space and gets every photo of it as a reference. This module builds that map
 * with one vision call over all the photos:
 *
 * It also replaces the n8n Vision Tagger: each photo gets a 1-10 quality score,
 * and photos that are not of the property land in `unassigned`.
 *
 *   spaces[]   which photos show the same physical space (an open-plan kitchen,
 *              dining area and lounge are one space when a photo shows them
 *              together), and what large objects each photo plainly shows —
 *              the only things the camera may move toward.
 *   sees[]     photo A shows part of what photo B shows.
 *   off_limits seen but never photographed (an en-suite through an open door,
 *              the front door): never a camera target.
 *
 * Best-effort like photo-vision.js: any failure falls back to one space per
 * photo, which is exactly the old one-shot-per-photo plan.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { assertPublicHttpUrl } = require("./utils");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const MODEL = process.env.SPACE_MAP_MODEL || process.env.PHOTO_VISION_MODEL || "claude-haiku-4-5-20251001";
const MAX_PHOTOS = 54;
// ~1000px keeps furniture recognisable across photos, and stays far under the
// 2000px per-image limit that applies to requests with more than 20 images.
const LONG_EDGE = 1000;
const MAX_SHOWS = 6;
// ~100 output tokens per photo (shows, quality, ids) plus links: 54 photos need
// far more than 4k, and a cut-off reply is invalid JSON → silent fallback.
const MAX_OUTPUT_TOKENS = 12000;
const SHRINK_CONCURRENCY = 6;
const TEXT_MAX = 60;
// The Vision Tagger's room types; walkthrough-plan.js orders spaces by them.
const TYPES = ["living_room", "open_plan", "kitchen", "dining_room", "bedroom", "master_bedroom", "kids_room",
  "bathroom", "toilet", "balcony", "office", "entrance", "hallway", "mamad", "garden", "roof", "parking",
  "storage", "laundry", "exterior", "view", "lobby", "pool", "gym", "other"];

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr).trim().split("\n").slice(-4).join(" | ").slice(-300);
        reject(new Error(`${path.basename(cmd)} failed: ${tail}`));
      } else resolve(String(stdout));
    });
  });
}

const clean = (s, max = TEXT_MAX) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
const typeKey = (s) => clean(s, 40).toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z_]/g, "");

/** The instruction sent after the images. `types[i]` is the tagger's room_type for photo i+1. */
function buildPrompt(count, types) {
  const hints = types.map((t, i) => (t ? `Photo ${i + 1}: tagged ${t}` : "")).filter(Boolean);
  return (
    `Above are ${count} photos of one property for sale, labelled Photo 1 to Photo ${count}.\n` +
    `Group them into the physical spaces they show, for planning a video walkthrough that must ` +
    `never show anything the photos do not show.\n\n` +
    `RULES\n` +
    `- Two photos are the same space only if they visibly share the same features (the same ` +
    `island, sofa, windows, flooring layout). The same room type is NOT enough: two bedrooms ` +
    `are two spaces unless the photos show the same room.\n` +
    `- Kitchen, dining and living areas are one space only if a photo shows them together.\n` +
    `- When unsure, keep photos in separate spaces.\n` +
    `- "shows": up to ${MAX_SHOWS} large, plainly visible things in that photo (e.g. "kitchen ` +
    `island", "sofa", "bed", "window", "balcony doors", "pool"). Nouns only, no adjectives. ` +
    `Never list a door, doorway, hallway or corridor.\n` +
    `- "off_limits": doors, openings or passages in a space that lead somewhere no photo shows ` +
    `(e.g. "en-suite bathroom door", "front door").\n` +
    `- "sees": photo A shows part of what photo B shows (e.g. the dining photo shows the ` +
    `kitchen island that photo B is of). Only list links you can see.\n` +
    `- "unassigned": photos that are not of this property's spaces (floor plans, logos, ` +
    `close-ups of objects).\n` +
    `- Every photo number appears exactly once: in one space or in unassigned.\n` +
    `- "quality": 1-10 per photo — how usable it is in a property ad (sharp, well lit, the ` +
    `space clearly visible = 7-10; blurry, dark, cluttered or an odd crop = 1-3).\n` +
    `- type: exactly one of ${TYPES.join(", ")}.\n` +
    (hints.length ? `\nThe tagger's guesses, for reference only:\n${hints.join("\n")}\n` : "") +
    `\nReturn only this JSON:\n` +
    `{"spaces":[{"id":"S1","type":"open_plan","contains":["kitchen","living_room"],` +
    `"photos":[{"n":1,"quality":8,"shows":["kitchen island","sofa"]}],"off_limits":["front door"]}],` +
    `"sees":[{"from":1,"to":3,"what":"kitchen island"}],"unassigned":[]}`
  );
}

/**
 * Validate a model reply against `count` photos. Never trusts the model: bad
 * numbers are dropped, each photo is kept once (first claim wins), and photos
 * the model forgot become their own single-photo space with the tagger's type.
 */
function normalizeMap(raw, count, types = []) {
  const valid = (n) => Number.isInteger(n) && n >= 1 && n <= count;
  const taken = new Set();
  const spaces = [];
  for (const s of Array.isArray(raw && raw.spaces) ? raw.spaces : []) {
    const photos = [];
    for (const p of Array.isArray(s && s.photos) ? s.photos : []) {
      const n = Number(p && (p.n ?? p.photo));
      if (!valid(n) || taken.has(n)) continue;
      taken.add(n);
      const shows = (Array.isArray(p.shows) ? p.shows : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, MAX_SHOWS);
      const q = Math.round(Number(p.quality));
      photos.push(q >= 1 && q <= 10 ? { n, shows, quality: q } : { n, shows });
    }
    if (!photos.length) continue;
    spaces.push({
      id: `S${spaces.length + 1}`,
      type: typeKey(s.type) || typeKey(types[photos[0].n - 1]) || "room",
      contains: (Array.isArray(s.contains) ? s.contains : []).map(typeKey).filter(Boolean).slice(0, 6),
      photos,
      off_limits: (Array.isArray(s.off_limits) ? s.off_limits : []).map((x) => clean(x)).filter(Boolean).slice(0, 6),
    });
  }
  const unassigned = [];
  for (const u of Array.isArray(raw && raw.unassigned) ? raw.unassigned : []) {
    const n = Number(u);
    if (valid(n) && !taken.has(n)) { taken.add(n); unassigned.push(n); }
  }
  let forgotten = 0;
  for (let n = 1; n <= count; n++) {
    if (taken.has(n)) continue;
    forgotten++;
    spaces.push({ id: `S${spaces.length + 1}`, type: typeKey(types[n - 1]) || "room", contains: [], photos: [{ n, shows: [] }], off_limits: [] });
  }
  const sees = [];
  for (const l of Array.isArray(raw && raw.sees) ? raw.sees : []) {
    const from = Number(l && l.from), to = Number(l && l.to);
    if (valid(from) && valid(to) && from !== to) sees.push({ from, to, what: clean(l.what, 40) });
  }
  return { spaces, sees, unassigned, forgotten };
}

/** One space per photo — the plan the pipeline used before space maps. */
function fallbackMap(count, types = []) {
  return normalizeMap({}, count, types);
}

function parseReply(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("space map reply had no JSON object");
  return JSON.parse(m[0]);
}

async function fetchShrunk(url, dir, i) {
  const safe = await assertPublicHttpUrl(url);
  const resp = await fetch(safe, { signal: AbortSignal.timeout(30000), redirect: "error" });
  if (!resp.ok) throw new Error(`photo ${i + 1} fetch ${resp.status}`);
  const src = path.join(dir, `src${i}`);
  const out = path.join(dir, `p${i}.jpg`);
  fs.writeFileSync(src, Buffer.from(await resp.arrayBuffer()));
  await run(FFMPEG, ["-y", "-i", src, "-vf",
    `scale='if(gt(iw,ih),min(${LONG_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${LONG_EDGE},ih))'`,
    "-frames:v", "1", "-q:v", "4", out], 30000);
  return fs.readFileSync(out).toString("base64");
}

/**
 * Map `photos` ([{url, room_type?}], in upload order). Returns
 * { map, debug } — never throws; on any failure `map` is fallbackMap().
 */
async function mapSpaces(photos) {
  const use = photos.slice(0, MAX_PHOTOS);
  const types = use.map((p) => p.room_type || "");
  if (!use.length) return { map: fallbackMap(0), debug: "no_photos" };
  if (!process.env.ANTHROPIC_API_KEY) return { map: fallbackMap(use.length, types), debug: "no_api_key" };
  if (process.env.SPACE_MAP === "0") return { map: fallbackMap(use.length, types), debug: "disabled" };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "space-map-"));
  try {
    // A few at a time: 54 parallel downloads would also mean 54 ffmpeg processes.
    const images = new Array(use.length);
    let next = 0;
    const worker = async () => { while (next < use.length) { const i = next++; images[i] = await fetchShrunk(use[i].url, tmp, i); } };
    await Promise.all(Array.from({ length: Math.min(SHRINK_CONCURRENCY, use.length) }, worker));
    const content = [];
    images.forEach((data, i) => {
      content.push({ type: "text", text: `Photo ${i + 1}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    });
    content.push({ type: "text", text: buildPrompt(use.length, types) });
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, temperature: 0, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) throw new Error(`vision api ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const text = (data.content || []).map((b) => b.text || "").join("");
    const map = normalizeMap(parseReply(text), use.length, types);
    return { map, debug: map.forgotten ? `ok (${map.forgotten} photos unplaced by the model)` : "ok" };
  } catch (err) {
    console.warn("space-map: mapping failed, one space per photo:", err.message);
    return { map: fallbackMap(use.length, types), debug: "error: " + err.message.slice(0, 200) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { mapSpaces, normalizeMap, fallbackMap, parseReply, buildPrompt, MAX_PHOTOS, TYPES };
