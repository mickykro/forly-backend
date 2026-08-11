/*
 * Describes the listing photos — one short Hebrew line per picture, saying what
 * is actually in it.
 *
 * The gallery needs a caption and a sentence per photo. Neither has ever
 * arrived: the page-builder payload has a `caption` field nobody fills, and the
 * Vision Tagger's per-photo output is collapsed into an unordered vocabulary
 * before it reaches this service (see rooms.js). Rather than wait on the
 * workflow, look at the photos here — the same thing overlay.js already does to
 * label rooms in the walkthrough, pointed at stills instead of frames, with the
 * same key and the same model.
 *
 * Everything is best-effort and skipped unless ANTHROPIC_API_KEY is set: a
 * listing whose photos cannot be described publishes with whatever captions it
 * had, exactly as before.
 *
 * Accuracy is the whole point of the exercise, so the prompt is written the way
 * the copy generator's is — only what is plainly visible, no adjectives the
 * picture does not support, and an empty string in preference to a guess.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { roomLabel } = require("./rooms");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const MODEL = process.env.PHOTO_VISION_MODEL || process.env.OVERLAY_VISION_MODEL ||
  "claude-haiku-4-5-20251001";
// The gallery shows at most 12 photos, and one call covers the lot.
const MAX_PHOTOS = 12;
const CAPTION_MAX = 40;
const DESC_MAX = 110;
// 420px on the long edge is enough to tell a kitchen from a bathroom and keeps
// twelve images inside a cheap call.
const LONG_EDGE = 420;

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

function clean(s, max) {
  return String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/**
 * The instruction sent alongside the images. Split out so a test can hold it to
 * its promises without spending a vision call.
 */
function buildPrompt(count, hints) {
  const vocab = hints.filter(Boolean);
  return (
    `להלן ${count} תמונות של אותו נכס, לפי הסדר.\n` +
    `עבור כל תמונה החזר אובייקט {"caption": ..., "desc": ...}:\n` +
    `- caption: שם החלל בעברית, 1-3 מילים (למשל "המטבח", "סוויטת ההורים", "המרפסת").\n` +
    `- desc: משפט אחד קצר בעברית שמתאר מה נראה בתמונה — עד 15 מילים.\n` +
    `כתוב אך ורק על מה שנראה בבירור בתמונה עצמה: חללים, ריהוט קבוע, חלונות, ` +
    `חומרים, כיווני אור, נוף שנראה מהחלון. אל תמציא שטח, כיווני אוויר, שנת שיפוץ, ` +
    `קומה, מחיר או כל פרט שאינו נראה. אל תשתמש בסופרלטיבים ("נדיר", "פעם בעשור", ` +
    `"מרהיב"). אם התמונה לא ברורה או לא מראה חלל של הנכס — החזר מחרוזות ריקות.\n` +
    (vocab.length ? `סוגי החללים שדווחו עבור הנכס: ${vocab.join(", ")}.\n` : "") +
    `החזר JSON בלבד: מערך של בדיוק ${count} אובייקטים, כאשר איבר i מתאים לתמונה i.`
  );
}

/**
 * Coerce a model reply into exactly `count` {caption, desc} pairs. Anything
 * missing, over-long or the wrong shape becomes empty strings rather than
 * reaching a page.
 */
function parseReply(text, count) {
  const m = String(text || "").match(/\[[\s\S]*\]/);
  if (!m) throw new Error("vision reply had no JSON array");
  const arr = JSON.parse(m[0]);
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = arr[i];
    if (e && typeof e === "object") {
      out.push({ caption: clean(e.caption, CAPTION_MAX), desc: clean(e.desc, DESC_MAX) });
    } else {
      out.push({ caption: "", desc: "" });
    }
  }
  return out;
}

async function shrink(src, dest) {
  await run(FFMPEG, ["-y", "-i", src, "-vf",
    `scale='if(gt(iw,ih),${LONG_EDGE},-2)':'if(gt(iw,ih),-2,${LONG_EDGE})'`,
    "-q:v", "5", dest], 30000);
}

/**
 * Describe `files` (absolute paths to the already-rehosted photos, in gallery
 * order). `rooms` is the Vision Tagger's vocabulary for this listing, used only
 * as a hint. Returns one {caption, desc} per file — never throws, never returns
 * a different length.
 */
async function describePhotos(files, rooms) {
  const blank = files.map(() => ({ caption: "", desc: "" }));
  if (!process.env.ANTHROPIC_API_KEY) return blank;
  if (process.env.PHOTO_VISION === "0") return blank;
  if (!files.length) return blank;

  const use = files.slice(0, MAX_PHOTOS);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "photo-vision-"));
  try {
    const content = [];
    for (let i = 0; i < use.length; i++) {
      const small = path.join(tmp, `p${i}.jpg`);
      await shrink(use[i], small);
      content.push({ type: "text", text: `תמונה ${i + 1}:` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(small).toString("base64") },
      });
    }
    const hints = [...new Set((rooms || []).map(roomLabel).filter(Boolean))];
    content.push({ type: "text", text: buildPrompt(use.length, hints) });

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2000, temperature: 0,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!resp.ok) throw new Error(`vision api ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const text = (data.content || []).map((b) => b.text || "").join("");
    const described = parseReply(text, use.length);
    // pad back out if the listing had more photos than one call covers
    return blank.map((b, i) => described[i] || b);
  } catch (err) {
    console.warn("photo-vision: describing photos failed, publishing without:", err.message);
    return blank;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  describePhotos, MAX_PHOTOS, CAPTION_MAX, DESC_MAX,
  _test: { buildPrompt, parseReply, clean },
};
