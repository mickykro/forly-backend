// n8n "Parse Prompt" node (WW1 Walkthrough V2), pasted verbatim into the Code node.

const SEEDANCE_PROMPT_MAX = 5000;
const CLEAN_TAIL = " The video must contain no watermarks, no logos, and no on-screen text, captions or graphic overlays of any kind - completely clean footage.";

function clampPrompt(p) {
  const s = String(p || "").replace(/\s+$/, "");
  if (s.length <= SEEDANCE_PROMPT_MAX) return s;
  const room = SEEDANCE_PROMPT_MAX - CLEAN_TAIL.length;
  let cut = s.slice(0, room);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  if (stop > room * 0.5) cut = cut.slice(0, stop + 1);
  return cut.replace(/\s+$/, "") + CLEAN_TAIL;
}

// Sonnet retypes the image URLs, and one wrong character in a UUID makes
// Seedance 404 the download and fail the whole clip. Keep the model's chosen
// ORDER, but every URL must be one we actually sent: snap anything else to the
// closest unused planned URL (a retyped UUID differs by a character or two).
function snapUrls(returned, allowed) {
  const set = new Set(allowed);
  const used = new Set();
  let repaired = 0;
  const images = returned.map((r, k) => {
    const url = r && typeof r.url === "string" ? r.url : "";
    if (set.has(url) && !used.has(url)) { used.add(url); return { ...r, url }; }
    let best = null, bestDiff = Infinity;
    for (const a of allowed) {
      if (used.has(a) || a.length !== url.length) continue;
      let d = 0;
      for (let j = 0; j < a.length && d <= 4; j++) if (a[j] !== url[j]) d++;
      if (d < bestDiff) { bestDiff = d; best = a; }
    }
    if (best === null || bestDiff > 4) best = allowed.find(a => !used.has(a)) || allowed[k];
    used.add(best); repaired++;
    return { ...r, url: best };
  });
  return { images, repaired };
}

// Opener/closer were chosen in Curate Photos; Sonnet may reorder the middle
// but not move them: the opener is clip 0's first shot, the closer clip 1's last.
const curatedAll = $("Curate Photos").first().json.curated || [];
const PIN = [curatedAll[0] && curatedAll[0].url, curatedAll.length ? curatedAll[curatedAll.length - 1].url : null];

const OUTDOOR_OPENER = $("Curate Photos").first().json.opener_group === "outdoor";
const plans = $("Plan Clips").all();
const phone = $("Validate Quota").first().json.phone;
return $input.all().map((item, i) => {
  const text = item.json.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Sonnet reply for clip " + i + " had no JSON object");
  const parsed = JSON.parse(match[0]);
  const plan = plans[i] ? plans[i].json : {};
  const allowed = plan.image_urls || [];
  const returned = Array.isArray(parsed.ordered_images) ? parsed.ordered_images : [];
  const src = returned.length === allowed.length
    ? returned
    : allowed.map(u => ({ url: u, room_type: null }));
  const { images, repaired } = allowed.length ? snapUrls(src, allowed) : { images: src, repaired: 0 };
  const clipIndex = plan.clip_index ?? i;
  const pinned = PIN[clipIndex === 0 ? 0 : 1];
  const want = clipIndex === 0 ? 0 : images.length - 1;
  const at = images.findIndex(x => x.url === pinned);
  let pinRepaired = false;
  if (pinned && at !== -1 && at !== want) {
    const [m] = images.splice(at, 1);
    images.splice(want, 0, m);
    pinRepaired = true;
  }
  const BANNED = /\b(rising|descend\w*|starting above|pull-?back|pull-?out|orbit\w*|horizon|golden hour|sunset|sunrise|dusk|dawn|dissolve\w*|blend\w*|morph\w*|fades?|seamless|walk\w*|steps?|stepping|person|first-person|pov|handheld|phone)\b/i;
  const TAIL = " Cut on movement between shots, no morphing or blending. Everything stays exactly as in the photos: nothing is added, removed, moved or restyled. No people, hands or shadows of the camera operator. Clean frame with no text, logos or watermarks.";
  const per = plan.seconds_per_shot || 3.5;
  const safe = images.map((_, k) => `Shot ${k + 1} (${per}s): @image${k + 1}, the camera glides slowly forward toward the center of the frame.`).join(" ") + TAIL;
  // The fixed closing sentence itself says "morphing or blending", so check only the part before it.
  const body = String(parsed.prompt || "").split("Cut on movement between shots")[0];
  const bad = body.match(BANNED);
  const prompt = bad ? safe : clampPrompt(parsed.prompt);
  // Only say the tour starts outside when Curate Photos actually opened on an
  // outdoor photo; otherwise Seedance invents a garden/entrance before @image1.
  const HEAD = clipIndex === 0
    ? (OUTDOOR_OPENER
      ? "One continuous cinematic tour of a single property, starting outside and moving toward the house. "
      : "One continuous cinematic tour of a single property, starting inside, in the room shown in @image1. ")
    : "The same continuous tour continues inside the house. ";
  const finalPrompt = HEAD + prompt;
  return { json: {
    phone,
    clip_index: clipIndex,
    duration: plan.duration,
    image_count: plan.image_count,
    ...parsed,
    ordered_images: images,
    prompt: finalPrompt,
    prompt_fallback: !!bad,
    prompt_fallback_word: bad ? bad[0] : null,
    prompt_chars: finalPrompt.length,
    prompt_clamped: prompt.length !== String(parsed.prompt || "").length,
    images_repaired: repaired,
    pin_repaired: pinRepaired
  } };
});
