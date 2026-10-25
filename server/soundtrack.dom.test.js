// server/soundtrack.dom.test.js
/* The page soundtrack (public-nadlan/templates/runtime.js) in real Chromium:
   narration + music follow the hero video. Audio may play muted, sound only
   after a gesture (as on a phone). Covers the first unmute after a whole muted
   pass, pause/resume, seeking, a heard narration staying silent on later loops,
   and the Movie template's Play. Skips cleanly without a Chromium binary. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const express = require("express");

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) { const exe = path.join(root, d, "chrome-linux", "chrome"); if (fs.existsSync(exe)) return exe; }
  }
  return null;
}

// A mono 16-bit sine as a WAV file.
function wav(seconds, hz) {
  const rate = 8000, n = Math.round(seconds * rate), buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * hz * i / rate)), 44 + i * 2);
  return buf;
}

const TPL = path.join(__dirname, "..", "public-nadlan", "templates");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("soundtrack.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] }); }
  catch { console.log("soundtrack.dom.test.js skipped (launch failed)"); return; }

  const app = express();
  // Served static, as /files is: a seek needs Range requests.
  const media = fs.mkdtempSync(path.join(require("os").tmpdir(), "soundtrack-"));
  fs.writeFileSync(path.join(media, "voice.wav"), wav(2, 660));
  fs.writeFileSync(path.join(media, "music.wav"), wav(20, 440));
  app.use(express.static(media));
  app.get("/templates/:f.html", (req, res) => res.type("html").send(fs.readFileSync(path.join(TPL, `${req.params.f}.html`), "utf8")
    .replace('<script src="/tpl/demo.js"></script>', '<script src="/tpl/demo.js"></script><script>__DEMO__.hero.narration_url="/voice.wav";__DEMO__.hero.music_url="/music.wav";</script>')));
  app.use(["/tpl", "/templates"], express.static(TPL));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function open(tpl) {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const A = window.Audio; window.__tracks = [];
      window.Audio = function (u) { const a = new A(u); window.__tracks.push(a); return a; };
      // a phone's rule: audio plays muted; with sound only after a gesture
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!(this instanceof HTMLVideoElement) && !this.muted && !window.__sound) return Promise.reject(new DOMException("no gesture", "NotAllowedError"));
        return play.call(this);
      };
    });
    await page.goto(`${base}/templates/${tpl}.html`);
    const ev = (fn) => page.evaluate(fn, undefined, {}, false); // the page's own world (patchright isolates by default)
    const state = () => ev(() => {
      const v = document.querySelector("[data-video]") || document.querySelector("[data-video-manual]"), [n, m] = window.__tracks;
      return { vt: v.currentTime, vPaused: v.paused, vMuted: v.muted, nt: n.currentTime, nPaused: n.paused, nMuted: n.muted, nEnded: n.ended, mPaused: m.paused };
    });
    return { page, state, ev };
  }

  try {
    // ── a looping hero (Atelier) ──
    {
      const { page, state, ev } = await open("atelier");
      await wait(3500);
      let s = await state();
      assert.ok(s.vMuted && s.nMuted && s.nEnded && s.vt > 2.5, `the narration plays through muted: ${JSON.stringify(s)}`);
      await ev(() => { window.__sound = true; [...document.querySelectorAll("body > button")].pop().click(); });
      await wait(400);
      s = await state();
      assert.ok(!s.vMuted && !s.nMuted && !s.nPaused && !s.mPaused, `first unmute: sound on, both tracks playing: ${JSON.stringify(s)}`);
      assert.ok(s.vt < 0.8 && Math.abs(s.vt - s.nt) < 0.3, `first unmute: video and narration from 0: ${JSON.stringify(s)}`);
      await ev(() => document.querySelector("[data-video]").pause()); await wait(200);
      s = await state();
      assert.ok(s.nPaused && s.mPaused, "pausing the video pauses the soundtrack");
      await ev(() => document.querySelector("[data-video]").play()); await wait(300);
      s = await state();
      assert.ok(!s.nPaused && Math.abs(s.vt - s.nt) < 0.3, `resume: narration in step: ${JSON.stringify(s)}`);
      await ev(() => { document.querySelector("[data-video]").currentTime = 0.2; }); await wait(400);
      s = await state();
      assert.ok(Math.abs(s.vt - s.nt) < 0.3, `a seek moves the narration with it: ${JSON.stringify(s)}`);
      await wait(2300);
      assert.ok((await state()).nEnded, "the narration ended while audible");
      await ev(() => { document.querySelector("[data-video]").currentTime = 0.1; }); await wait(500); // as the loop does
      s = await state();
      assert.ok(s.nPaused && !s.mPaused, `a heard narration stays silent on the next loop; the music goes on: ${JSON.stringify(s)}`);
      await ev(() => { document.getElementById("vMute").click(); }); await wait(200);
      assert.ok((await state()).vMuted && (await ev(() => window.__tracks[1].muted)), "the template's own mute button mutes the soundtrack");
      await page.close();
    }
    // ── a tour started by Play (Movie: [data-video-manual]) ──
    {
      const { page, state, ev } = await open("movie");
      await wait(500);
      let s = await state();
      assert.ok(s.vPaused && s.nPaused && s.mPaused, "nothing plays before Play");
      await ev(() => { window.__sound = true; });
      await page.click("#playHero"); await wait(800);
      s = await state();
      assert.ok(!s.vPaused && !s.nPaused && !s.mPaused && !s.nMuted && Math.abs(s.vt - s.nt) < 0.3, `Play starts the soundtrack with the video: ${JSON.stringify(s)}`);
      await page.close();
    }
    console.log("soundtrack.dom.test.js ok");
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(media, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
