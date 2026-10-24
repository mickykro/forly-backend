/*
 * reel-script.js — the Hebrew voice-over, subtitles, opening tag and end card
 * for a narrated walkthrough reel (WW1 V4). One narration + subtitle per clip
 * of the walkthrough plan, in clip order.
 *
 * The words come from one Claude call that sees only the listing details and
 * what each clip shows (the space map), so it cannot praise what is not there.
 * The tag and end card are built here from the listing data, never by the
 * model: names, phone and price must be exact. Any model failure falls back to
 * template lines, so a reel never fails for want of a script.
 */

const MODEL = process.env.REEL_SCRIPT_MODEL || "claude-haiku-4-5-20251001";
// Spoken Hebrew at the 1.08x the render applies runs ~13 chars/s; a line may
// overrun its clip a little (the render stretches the shot), not by much.
const CHARS_PER_SECOND = 13;
const SUB_LINE_MAX = 28;
const MUSIC_PROMPT = "Warm, modern, uplifting instrumental background music for a real-estate Instagram reel. " +
  "Soft electric piano and light acoustic guitar, gentle deep-house beat, airy pads, 110 BPM, bright and " +
  "optimistic, steady energy with no big drops. Sits quietly under a voice-over.";

const HE_ROOM = {
  living_room: "סלון", open_plan: "חלל מגורים פתוח", kitchen: "מטבח", dining_room: "פינת אוכל", bedroom: "חדר שינה",
  master_bedroom: "חדר הורים", kids_room: "חדר ילדים", bathroom: "חדר רחצה", toilet: "שירותים", balcony: "מרפסת",
  office: "חדר עבודה", entrance: "כניסה", hallway: "מסדרון", mamad: "ממ״ד", garden: "גינה", roof: "גג",
  parking: "חניה", storage: "מחסן", laundry: "חדר כביסה", exterior: "הבניין", view: "הנוף", lobby: "לובי",
  pool: "בריכה", gym: "חדר כושר", other: "חלל נוסף",
};

const num = (v) => Number(v) || 0;
const isRent = (d) => d.listing_type === "rent";
const clean = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f{}\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const hasHebrew = (s) => /[֐-׿]/.test(s);

/** "972546582548" / "0546582548" → "054-658-2548"; anything else unchanged. */
function formatPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  const local = d.startsWith("972") ? "0" + d.slice(3) : d;
  return /^0\d{9}$/.test(local) ? `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}` : String(p || "");
}

function tagFor(d = {}) {
  const city = clean(d.city, 30);
  return (isRent(d) ? "להשכרה" : "למכירה") + (city ? ` · ${city}` : "");
}

/** The end card: name, brand, phone (gold in the render), a call to action and one facts line. */
function buildEndCard(d = {}, agent = {}) {
  const price = num(d.price);
  const facts = [
    price ? `${price.toLocaleString("en-US")} ₪${isRent(d) ? " לחודש" : ""}` : "",
    num(d.size_sqm) ? `${num(d.size_sqm)} מ״ר` : "",
    num(d.floor) ? `קומה ${num(d.floor)}` : "",
  ].filter(Boolean).join(" · ");
  return {
    name: clean(agent.name, 40),
    brand: clean(agent.brand_name && agent.brand_name !== agent.name ? agent.brand_name : "", 40),
    phone: formatPhone(agent.phone),
    cta: "לפרטים ותיאום ביקור",
    facts,
  };
}

// "a b c d" → "a b\Nc d", breaking at the space nearest the middle.
function wrapSubtitle(text) {
  const t = clean(text, SUB_LINE_MAX * 2 + 4);
  if (t.length <= SUB_LINE_MAX) return t;
  const mid = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? t : `${t.slice(0, best)}\\N${t.slice(best + 1)}`;
}

const capFor = (clip) => Math.round((num(clip.duration) + 1) * CHARS_PER_SECOND);

function describeClip(clip, spaces) {
  return (clip.spaces || []).map((id) => {
    const s = spaces.find((x) => x.id === id);
    if (!s) return "";
    const shows = [...new Set(s.photos.flatMap((p) => p.shows || []))].slice(0, 6).join(", ");
    return `${HE_ROOM[s.type] || s.type}${shows ? ` (${shows})` : ""}`;
  }).filter(Boolean).join(" + ") || "חלל בנכס";
}

function buildPrompt(clips, spaces, d = {}) {
  const facts = [
    `deal: ${isRent(d) ? "for rent" : "for sale"}`,
    num(d.rooms) && `rooms: ${num(d.rooms)}`, num(d.size_sqm) && `size: ${num(d.size_sqm)} sqm`,
    num(d.floor) && `floor: ${num(d.floor)}`, d.neighborhood && `neighborhood: ${clean(d.neighborhood, 40)}`,
    d.city && `city: ${clean(d.city, 40)}`, num(d.parking) && `parking: ${num(d.parking)}`,
    Array.isArray(d.tags) && d.tags.length && `features: ${d.tags.slice(0, 8).map((t) => clean(t, 20)).join(", ")}`,
  ].filter(Boolean).join("\n");
  const list = clips.map((c, i) => `Clip ${i + 1} (${c.duration}s, narration max ${capFor(c)} chars): ${describeClip(c, spaces)}`).join("\n");
  return (
    `You write the Hebrew voice-over for a short vertical real-estate reel (Instagram / WhatsApp).\n\n` +
    `LISTING\n${facts}\n\nCLIPS, in order\n${list}\n\n` +
    `Write one line per clip, in order.\n` +
    `- "narration": spoken Hebrew, warm and natural, like an agent showing the home. Numbers as Hebrew words ` +
    `(e.g. "חמישה חדרים", "קומה תשע"). Stay under the clip's max length. Mention only the rooms and things ` +
    `listed for that clip and the listing facts — never invent a feature, view or material.\n` +
    `- Line 1 opens with a short hook ("בואו תראו את זה...") and says the rooms, neighborhood and city.\n` +
    `- The last line ends with "הפרטים כאן על המסך".\n` +
    `- "subtitle": the same line for the screen, shorter, digits allowed, split into two short parts with " | " ` +
    `(each part at most ${SUB_LINE_MAX} characters).\n` +
    `- Hebrew only, no emojis, no quotes.\n\n` +
    `Return only this JSON: {"lines":[{"narration":"...","subtitle":"... | ..."}]} with exactly ${clips.length} lines.`
  );
}

/** Check a model reply against the clips; throws on anything unusable. */
function validateScript(raw, clips) {
  const lines = raw && Array.isArray(raw.lines) ? raw.lines : null;
  if (!lines || lines.length !== clips.length) throw new Error(`script has ${lines ? lines.length : 0} lines, want ${clips.length}`);
  return lines.map((l, i) => {
    const narration = clean(l && l.narration, 400);
    const sub = clean(l && l.subtitle, 120);
    if (!hasHebrew(narration) || !hasHebrew(sub)) throw new Error(`line ${i + 1} is not Hebrew`);
    if (narration.length > capFor(clips[i]) * 1.4) throw new Error(`line ${i + 1} too long (${narration.length})`);
    const parts = sub.split("|").map((x) => x.trim()).filter(Boolean).slice(0, 2);
    const subtitle = parts.length === 2 && parts.every((x) => x.length <= SUB_LINE_MAX + 4)
      ? `${parts[0]}\\N${parts[1]}` : wrapSubtitle(parts.join(" "));
    return { narration, subtitle };
  });
}

/** Template lines when the model is unavailable: plain, factual, never wrong. */
function fallbackScript(clips, spaces, d = {}) {
  const place = [d.neighborhood && `ב${clean(d.neighborhood, 30)}`, d.city && clean(d.city, 30)].filter(Boolean).join(", ");
  return clips.map((c, i) => {
    const room = describeClip(c, spaces).split(" (")[0];
    let text;
    if (i === 0) text = `בואו תראו את זה... ${num(d.rooms) ? `${num(d.rooms)} חדרים` : "דירה"}${place ? ` ${place}` : ""}`;
    else text = room;
    if (i === clips.length - 1 && clips.length > 1) text += "... הפרטים כאן על המסך";
    return { narration: text + ".", subtitle: wrapSubtitle(text) };
  });
}

function parseReply(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("script reply had no JSON object");
  return JSON.parse(m[0]);
}

/**
 * → { lines:[{narration, subtitle}], tag, end_card, music_prompt, debug }. Never throws.
 * `clips` and `spaces` from the walkthrough plan and space map; `agent` {name, brand_name, phone}.
 */
async function writeScript({ clips, spaces = [], details = {}, agent = {}, fetchFn = fetch }) {
  const base = { tag: tagFor(details), end_card: buildEndCard(details, agent), music_prompt: MUSIC_PROMPT };
  if (!process.env.ANTHROPIC_API_KEY) return { ...base, lines: fallbackScript(clips, spaces, details), debug: "no_api_key" };
  try {
    const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, temperature: 0.4,
        messages: [{ role: "user", content: buildPrompt(clips, spaces, details) }] }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`script api ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const text = (data.content || []).map((b) => b.text || "").join("");
    return { ...base, lines: validateScript(parseReply(text), clips), debug: "ok" };
  } catch (err) {
    console.warn("reel-script: model script failed, using template lines:", err.message);
    return { ...base, lines: fallbackScript(clips, spaces, details), debug: "fallback: " + err.message.slice(0, 160) };
  }
}

module.exports = { writeScript, validateScript, fallbackScript, buildPrompt, buildEndCard, tagFor, formatPhone, wrapSubtitle, MUSIC_PROMPT };
