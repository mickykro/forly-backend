/*
 * reel.js — the narrated walkthrough reel (WW1 V4): MiniMax H3 clips, Hebrew
 * voice (Gemini TTS) and music (Lyria 2) on fal.ai, rendered here with ffmpeg.
 *
 * n8n drives it (routes/walkthrough.js): submit the clips, poll them, then one
 * render call that voices the script, makes the music and returns four files:
 *   reel      the post: subtitles, opening tag, end card, voice + ducked music
 *   clean     the page's background video: no text, no audio, no end card
 *   narration the voice alone, timed to `clean` from 0 (audio-only MP4)
 *   music     the music alone, level baked in (iOS ignores audio.volume)
 * Audio goes out as MP4 (AAC) because /files only stores the types it can sniff.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { assertPublicHttpUrl, readCapped } = require("./utils");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const FONTS_DIR = path.join(__dirname, "assets", "fonts");
const FAL_QUEUE = "https://queue.fal.run";
const FAL_RUN = "https://fal.run";
const CLIP_MODEL = process.env.REEL_CLIP_MODEL || "minimax/h3/reference-to-video";
const TTS_MODEL = process.env.REEL_TTS_MODEL || "fal-ai/gemini-3.1-flash-tts";
const MUSIC_MODEL = process.env.REEL_MUSIC_MODEL || "fal-ai/lyria2";
const TTS_VOICE = process.env.REEL_TTS_VOICE || "Kore";
const TTS_STYLE = "Read in natural, warm Israeli Hebrew, like an upbeat real-estate agent presenting a home on Instagram. " +
  "Steady pace, no pauses at the start or end.";
// fal list prices (USD), for the cost line n8n reports.
const PRICE = { clipPerSecond: 0.05, ttsPer1kChars: 0.05, musicPerTrack: 0.1 };

const W = 720, H = 1280, FPS = 30;
const XF = 0.3; // crossfade between shots
const VO_IN = 0.25; // a line starts this far into its shot
const MIN_SHOT = 4;
const CARD = 3.4; // end card
const VO_TEMPO = 1.08;
const MAX_STRETCH = 1.25; // a clip is slowed at most this much to fit its line; past that its last frame holds
// Per downloaded file. A 15 s H3 clip, a line of TTS wav or a Lyria track is a few MB.
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024;

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} failed: ${String(stderr).trim().split("\n").slice(-4).join(" | ").slice(-400)}`));
      else resolve(String(stdout));
    });
  });
}

async function duration(file) {
  const out = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], 30000);
  const d = Number(out.trim());
  if (!(d > 0)) throw new Error(`no duration for ${path.basename(file)}`);
  return d;
}

async function download(url, dest) {
  const safe = await assertPublicHttpUrl(url);
  // redirect "error": a redirect could point past assertPublicHttpUrl to a private host (same policy as utils.rehost)
  const resp = await fetch(safe, { signal: AbortSignal.timeout(120000), redirect: "error" });
  if (!resp.ok) throw new Error(`fetch ${resp.status} ${String(url).slice(0, 80)}`);
  fs.writeFileSync(dest, await readCapped(resp, MAX_DOWNLOAD_BYTES));
}

// ── fal ──
async function fal(url, init = {}, timeoutMs = 60000) {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY not set");
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Key ${key}`, "content-type": "application/json", ...(init.headers || {}) } });
  if (!resp.ok) throw new Error(`fal ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}
const falQueueUrl = (u) => typeof u === "string" && u.startsWith(`${FAL_QUEUE}/`);

/** Queue one H3 clip per plan clip → [{clip_index, duration, request_id, status_url, response_url}]. */
async function submitClips(clips) {
  return Promise.all(clips.map(async (c, i) => {
    const r = await fal(`${FAL_QUEUE}/${CLIP_MODEL}`, { method: "POST", body: JSON.stringify({
      prompt: c.prompt, reference_image_urls: c.image_urls.slice(0, 9), duration: c.duration,
      resolution: "768P", aspect_ratio: "9:16", prompt_expansion_mode: "disabled" }) });
    if (!r.request_id) throw new Error(`clip ${i}: fal returned no request_id`);
    return { clip_index: c.clip_index ?? i, duration: c.duration, request_id: r.request_id,
      status_url: r.status_url, response_url: r.response_url };
  }));
}

/** One poll of every clip → { all_complete, failed:[clip_index], video_urls (clip order, when complete) }. */
async function clipStatus(requests) {
  const rows = await Promise.all(requests.map(async (r) => {
    if (!falQueueUrl(r.status_url) || !falQueueUrl(r.response_url)) throw new Error("status/response urls must be fal queue urls");
    const st = (await fal(r.status_url)).status;
    if (st !== "COMPLETED") return { ...r, status: st };
    const out = await fal(r.response_url).catch((e) => ({ error: e.message }));
    const url = out && out.video && out.video.url;
    return { ...r, status: url ? "COMPLETED" : "FAILED", video_url: url || null };
  }));
  const ordered = rows.slice().sort((a, b) => a.clip_index - b.clip_index);
  const allComplete = rows.every((r) => r.status === "COMPLETED");
  return {
    all_complete: allComplete,
    failed: rows.filter((r) => /FAILED|ERROR|CANCELLED/.test(r.status)).map((r) => r.clip_index),
    statuses: ordered.map((r) => r.status),
    video_urls: allComplete ? ordered.map((r) => r.video_url) : [],
  };
}

async function tts(text) {
  const r = await fal(`${FAL_RUN}/${TTS_MODEL}`, { method: "POST", body: JSON.stringify({
    prompt: text, style_instructions: TTS_STYLE, voice: TTS_VOICE, language_code: "Hebrew (Israel)", output_format: "wav" }) }, 120000);
  if (!r.audio || !r.audio.url) throw new Error("tts returned no audio");
  return r.audio.url;
}

async function music(prompt) {
  const r = await fal(`${FAL_RUN}/${MUSIC_MODEL}`, { method: "POST", body: JSON.stringify({
    prompt, negative_prompt: "vocals, singing, voice, choir, lyrics, low quality, distortion, harsh drums, sudden loud changes" }) }, 180000);
  if (!r.audio || !r.audio.url) throw new Error("music returned no audio");
  return r.audio.url;
}

// ── timeline + subtitles (pure) ──

/**
 * Shot k lasts long enough for its whole line (+0.7 s), at least MIN_SHOT, and
 * a multi-angle clip keeps nearly all its angles. Shots overlap by XF. A line
 * never runs into the next one: a clip too short for its line is slowed (up to
 * MAX_STRETCH), then holds its last frame for the rest.
 * → { shots:[{len, start, stretch, hold}], total (incl. end card), videoEnd }
 */
function timeline(clips, voDurations) {
  const shots = clips.map((c, k) => {
    const len = Math.max(MIN_SHOT, voDurations[k] + 0.7, (c.shot_count || 1) > 1 ? c.duration - 0.5 : 0);
    const usable = c.duration - 0.05;
    const stretch = Math.min(MAX_STRETCH, Math.max(1, len / usable));
    return { len, stretch, hold: Math.max(0, len - usable * stretch) };
  });
  let t = 0;
  shots.forEach((s, k) => { s.start = t; t += s.len - (k < shots.length - 1 ? XF : 0); });
  const videoEnd = t;
  return { shots, videoEnd, total: videoEnd - XF + CARD };
}

const assTime = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const assText = (s, max = 80) => String(s || "").replace(/[{}\r\n\t]/g, " ").replace(/\\(?!N)/g, " ").trim().slice(0, max);

/**
 * The ASS file. Encoding -1 on every style: libass then runs full bidi, so
 * Hebrew mixed with digits ("3 חדרים", phone numbers) keeps its order.
 */
function buildAss({ shots, total }, subtitles, tag, card) {
  const style = (name, font, size, colour, border, outline, shadow, align, marginV, back = "&H80000000") =>
    `Style: ${name},${font},${size},${colour},${colour},&H00000000,${back},0,0,0,0,100,100,0,0,${border},${outline},${shadow},${align},50,50,${marginV},-1`;
  const head = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 2", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style("Sub", "Heebo SemiBold", 52, "&H00FFFFFF", 1, 3, 2, 2, 230),
    "Style: Tag,Heebo ExtraBold,44,&H00FFFFFF,&H00FFFFFF,&H5A000000,&H5A000000,0,0,0,0,100,100,0,0,3,14,0,8,40,40,150,-1",
    style("Name", "Heebo ExtraBold", 76, "&H00FFFFFF", 1, 2, 3, 5, 0),
    style("Card", "Heebo SemiBold", 44, "&H00FFFFFF", 1, 2, 2, 5, 0),
    style("Phone", "Heebo ExtraBold", 70, "&H0037AFD4", 1, 2, 3, 5, 0),
    style("Small", "Heebo SemiBold", 38, "&H00FFFFFF", 1, 2, 2, 5, 0),
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const ev = (layer, a, b, st, text) => `Dialogue: ${layer},${assTime(a)},${assTime(b)},${st},,0,0,0,,${text}`;
  const out = subtitles.map((s, k) => ev(0, shots[k].start + 0.15, shots[k].start + shots[k].len - XF, "Sub", `{\\fad(150,150)}${assText(s)}`));
  if (tag) out.push(ev(1, 0.3, shots[0].len - XF, "Tag", `{\\fad(250,200)}${assText(tag, 40)}`));
  const cs = total - CARD + 0.15;
  const rows = [["Name", 440, card.name], ["Card", 530, card.brand], ["Phone", 650, card.phone], ["Card", 760, card.cta], ["Small", 880, card.facts]];
  for (const [st, y, text] of rows) if (text) out.push(ev(2, cs, total, st, `{\\fad(300,0)\\pos(${W / 2},${y})}${assText(text, 60)}`));
  return head.concat(out).join("\n") + "\n";
}

// ── render ──
const FIT = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p,setsar=1`;
const ENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-maxrate", "2500k", "-bufsize", "5000k", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

function videoChain(tl, n) {
  const f = tl.shots.map((s, k) => `[${k}:v]setpts=${s.stretch.toFixed(4)}*(PTS-STARTPTS)${s.hold > 0 ? `,tpad=stop_mode=clone:stop_duration=${(s.hold + 0.1).toFixed(3)}` : ""},trim=0:${s.len.toFixed(3)},setpts=PTS-STARTPTS,${FIT}[v${k}]`);
  let prev = "v0";
  for (let k = 1; k < n; k++) {
    f.push(`[${prev}][v${k}]xfade=transition=fade:duration=${XF}:offset=${tl.shots[k].start.toFixed(3)}[x${k}]`);
    prev = `x${k}`;
  }
  return { f, last: prev };
}

function voiceChain(tl, first) {
  const f = tl.shots.map((s, k) => {
    const ms = Math.round((s.start + VO_IN) * 1000);
    return `[${first + k}:a]adelay=${ms}|${ms},aformat=sample_rates=44100:channel_layouts=stereo[a${k}]`;
  });
  f.push(`${tl.shots.map((_, k) => `[a${k}]`).join("")}amix=inputs=${tl.shots.length}:normalize=0[voice]`);
  return f;
}

/**
 * Render the four files. `subtitles`, `narrationUrls` in clip order;
 * store(buf) → url. Returns their URLs, the duration and the fal cost.
 */
async function renderReel({ clips, clipUrls, script, narrationUrls, musicUrl, endBgUrl, store }) {
  const n = clipUrls.length;
  if (!n || n !== clips.length || narrationUrls.length !== n || script.lines.length !== n) throw new Error("clips, clip urls, narration and script lines must match");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reel-"));
  const p = (f) => path.join(tmp, f);
  try {
    await Promise.all(clipUrls.map((u, k) => download(u, p(`clip${k}.mp4`))));
    await Promise.all(narrationUrls.map((u, k) => download(u, p(`vo${k}_raw`))));
    await download(musicUrl, p("music_raw"));
    await download(endBgUrl, p("card.jpg"));
    // Each line: silence trimmed off both ends, then a touch faster.
    const trim = "silenceremove=start_periods=1:start_threshold=-45dB";
    await Promise.all(narrationUrls.map((_, k) => run(FFMPEG, ["-y", "-loglevel", "error", "-i", p(`vo${k}_raw`),
      "-af", `${trim},areverse,${trim},areverse,atempo=${VO_TEMPO}`, "-ar", "44100", p(`vo${k}.wav`)], 60000)));
    const clipDur = await Promise.all(clipUrls.map((_, k) => duration(p(`clip${k}.mp4`))));
    const voDur = await Promise.all(narrationUrls.map((_, k) => duration(p(`vo${k}.wav`))));
    const tl = timeline(clips.map((c, k) => ({ ...c, duration: Math.min(c.duration, clipDur[k]) })), voDur);
    fs.writeFileSync(p("subs.ass"), buildAss(tl, script.lines.map((l) => l.subtitle), script.tag, script.end_card), "utf8");

    const clipIn = clipUrls.flatMap((_, k) => ["-i", p(`clip${k}.mp4`)]);
    const voIn = narrationUrls.flatMap((_, k) => ["-i", p(`vo${k}.wav`)]);
    const v = videoChain(tl, n);
    const total = tl.total.toFixed(3);

    // 1. reel: clips + blurred end card + subtitles, voice over music ducked lightly (no fades)
    const reelGraph = [...v.f,
      `[${n}:v]${FIT},gblur=sigma=28,eq=brightness=-0.22[card]`,
      `[${v.last}][card]xfade=transition=fade:duration=${XF}:offset=${(tl.videoEnd - XF).toFixed(3)}[vx]`,
      `[vx]ass=${p("subs.ass")}:fontsdir=${FONTS_DIR}[vout]`,
      ...voiceChain(tl, n + 1),
      `[voice]asplit[v1][v2]`,
      `[${2 * n + 1}:a]atrim=0:${total},aformat=sample_rates=44100:channel_layouts=stereo[m]`,
      `[m][v1]sidechaincompress=threshold=0.1:ratio=2:attack=20:release=400[md]`,
      `[v2][md]amix=inputs=2:normalize=0,alimiter=limit=0.95,apad,atrim=0:${total}[aout]`].join(";");
    await run(FFMPEG, ["-y", "-loglevel", "error", ...clipIn, "-loop", "1", "-t", String(CARD + XF), "-i", p("card.jpg"), ...voIn,
      "-stream_loop", "-1", "-i", p("music_raw"), "-filter_complex", reelGraph, "-map", "[vout]", "-map", "[aout]",
      ...ENC, "-c:a", "aac", "-b:a", "128k", "-t", total, p("reel.mp4")], 600000);

    // 2. clean: the same shots, nothing on them, no sound
    await run(FFMPEG, ["-y", "-loglevel", "error", ...clipIn, "-filter_complex", v.f.join(";"), "-map", `[${v.last}]`, "-an",
      ...ENC, "-t", tl.videoEnd.toFixed(3), p("clean.mp4")], 600000);

    // 3. narration alone, on the clean video's clock
    await run(FFMPEG, ["-y", "-loglevel", "error", ...voIn, "-filter_complex", voiceChain(tl, 0).join(";") + `;[voice]apad,atrim=0:${tl.videoEnd.toFixed(3)}[o]`,
      "-map", "[o]", "-ac", "1", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-f", "mp4", p("narration.mp4")], 120000);

    // 4. music alone, ~3 dB under its raw level (no ducking on the page: two players)
    await run(FFMPEG, ["-y", "-loglevel", "error", "-i", p("music_raw"), "-af", "volume=0.7", "-vn", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", "-f", "mp4", p("music.mp4")], 120000);

    const [reelUrl, cleanUrl, narrationUrl, musicTrackUrl] = await Promise.all(
      ["reel.mp4", "clean.mp4", "narration.mp4", "music.mp4"].map((f) => store(fs.readFileSync(p(f)))));
    const chars = script.lines.reduce((s, l) => s + l.narration.length, 0);
    const clipSeconds = clips.reduce((s, c) => s + c.duration, 0);
    const cost = {
      clips: +(clipSeconds * PRICE.clipPerSecond).toFixed(3),
      tts: +(chars / 1000 * PRICE.ttsPer1kChars).toFixed(3),
      music: PRICE.musicPerTrack,
    };
    cost.total = +(cost.clips + cost.tts + cost.music).toFixed(3);
    return {
      reel_url: reelUrl, clean_video_url: cleanUrl, narration_url: narrationUrl, music_url: musicTrackUrl,
      duration: +tl.total.toFixed(2), clean_duration: +tl.videoEnd.toFixed(2),
      reel_bytes: fs.statSync(p("reel.mp4")).size, cost, clip_seconds: clipSeconds, narration_chars: chars,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { submitClips, clipStatus, tts, music, renderReel, PRICE, _test: { download, MAX_DOWNLOAD_BYTES, timeline, buildAss, assTime, assText, falQueueUrl, XF, CARD } };
