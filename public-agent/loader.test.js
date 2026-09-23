/* Loader state machine: a hide lets the pass on screen finish (never a whole
   extra one), so the animation is never cut off, and must not depend on media
   events that blocked autoplay would never deliver.
   Run: node public-agent/loader.test.js */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CLIP_MS = 5042;   // the real /assets/loading.mp4 cycle
const CYCLE_MS = 1800;  // target length of one on-screen pass
const BUDGET_MS = CYCLE_MS + 250; // at most the rest of one pass, plus slack

// Minimal fake DOM — just enough of the shape api.js touches.
function setup() {
  const listeners = {};
  const video = {
    duration: CLIP_MS / 1000, currentTime: 0, paused: false,
    play: () => Promise.resolve(),
    pause: () => { video.paused = true; },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    closest: () => box,
  };
  const box = {
    classes: new Set(),
    classList: {
      add: (c) => box.classes.add(c),
      remove: (c) => box.classes.delete(c),
      contains: (c) => box.classes.has(c),
    },
    querySelector: (s) => (s === "video" ? video : { textContent: "" }),
  };
  const docListeners = {};
  global.window = {};
  global.document = {
    querySelector: (s) => (s === ".vloader" ? box : null),
    querySelectorAll: () => [video],
    addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); },
  };
  const src = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");
  new Function(src)();
  (docListeners.DOMContentLoaded || []).forEach((fn) => fn()); // wires the "ended" handler
  return { FLY: global.window.FLY, box, video, fire: (ev) => (listeners[ev] || []).forEach((f) => f()) };
}

const hide = (FLY) => new Promise((resolve) => {
  const t0 = Date.now();
  FLY.loaderHide(() => resolve(Date.now() - t0));
});

(async () => {
  // ── a hide mid-playback waits for the end of that pass, not a new one ──
  {
    const { FLY, box, video } = setup();
    FLY.loaderShow("loading");
    video.currentTime = 3; // 3s into the 5.04s source = past half the pass
    const expect = (CLIP_MS - 3000) / video.playbackRate;
    const ms = await hide(FLY);
    assert.ok(Math.abs(ms - expect) < 120, `revealed in ${ms}ms, expected ~${Math.round(expect)}ms (end of the pass)`);
    assert.equal(box.classes.has("hidden"), true, "loader is hidden once the work is done");
    assert.equal(box.classes.has("vloader-out"), false, "the fade class is cleaned up");
    assert.equal(video.paused, true, "the clip stops decoding once hidden");
  }

  // ── a loader up from first paint reveals just as fast ──
  {
    const { FLY, box } = setup(); // no loaderShow(): markup ships it visible
    const ms = await hide(FLY);
    assert.ok(ms < BUDGET_MS, `revealed in ${ms}ms, must be within one pass (${BUDGET_MS}ms)`);
    assert.equal(box.classes.has("hidden"), true, "loader hides");
  }

  // ── an instant response still shows the loader long enough to not flicker ──
  {
    const { FLY } = setup();
    FLY.loaderShow();
    const ms = await hide(FLY);
    assert.ok(ms >= 300, `revealed after ${ms}ms, too fast to read as anything but a flash`);
  }

  // ── blocked autoplay must not strand the page ──
  {
    const { FLY, box } = setup(); // "ended" never fires, playback never starts
    FLY.loaderShow();
    const ms = await hide(FLY);
    assert.ok(ms < BUDGET_MS, `revealed in ${ms}ms (within one pass) even with playback blocked`);
    assert.equal(box.classes.has("hidden"), true, "loader hides without any media event");
  }

  // ── the clip is paced to one pass per CYCLE_MS, whatever the source length ──
  {
    const { video } = setup(); // paced on wire-up, the clip is already autoplaying
    const pass = (CLIP_MS / video.playbackRate);
    assert.ok(Math.abs(pass - CYCLE_MS) < 1, `one pass takes ${Math.round(pass)}ms, expected ${CYCLE_MS}ms`);
    assert.equal(video.defaultPlaybackRate, video.playbackRate, "survives a source reload");
  }

  // ── pacing falls back to the known clip length before metadata lands ──
  {
    const { FLY, video } = setup();
    video.duration = NaN; // metadata not in yet
    FLY.loaderShow();
    const pass = (CLIP_MS / video.playbackRate);
    assert.ok(Math.abs(pass - CYCLE_MS) < 1, `unpaced before metadata: one pass takes ${Math.round(pass)}ms`);
  }

  // ── while still loading, "ended" keeps the clip looping ──
  {
    const { FLY, box, video, fire } = setup();
    FLY.loaderShow();
    video.currentTime = 4;
    fire("ended");
    assert.equal(video.currentTime, 0, "replays from the start");
    assert.equal(box.classes.has("hidden"), false, "keeps looping while still loading");
  }

  // ── once hidden, a late "ended" does not restart playback ──
  {
    const { FLY, box, video, fire } = setup();
    FLY.loaderShow();
    await hide(FLY);
    video.currentTime = 4;
    fire("ended");
    assert.equal(video.currentTime, 4, "no replay behind a hidden loader");
    assert.equal(box.classes.has("hidden"), true, "stays hidden");
  }

  // ── hiding an already-hidden loader is a no-op that still reveals ──
  {
    const { FLY } = setup();
    await hide(FLY);
    const ms = await hide(FLY);
    assert.ok(ms < 50, `second hide took ${ms}ms, should be immediate`);
  }

  // ── a clip frozen on its first frame is un-paced and replayed ──
  {
    const { FLY, video } = setup();
    let plays = 0; video.play = () => { plays++; return Promise.resolve(); };
    FLY.loaderShow();
    const playsAtShow = plays;
    await new Promise((r) => setTimeout(r, 1200)); // currentTime never moves
    assert.equal(video.playbackRate, 1, "falls back to normal speed when stuck");
    assert.ok(plays > playsAtShow, "retries playback when stuck");
    await hide(FLY);
  }

  // ── a clip that is advancing is left alone ──
  {
    const { FLY, video } = setup();
    FLY.loaderShow();
    const rate = video.playbackRate;
    const iv = setInterval(() => { video.currentTime += 0.1; }, 50);
    await new Promise((r) => setTimeout(r, 1200));
    clearInterval(iv);
    assert.equal(video.playbackRate, rate, "pacing kept while the clip plays");
    await hide(FLY);
  }

  // ── play() refused (Low Power Mode / never auto-play) → animated image ──
  {
    const { FLY, video } = setup();
    let swapped = null;
    global.document.createElement = () => ({ setAttribute() {} });
    video.parentNode = {};
    video.replaceWith = (n) => { swapped = n; };
    video.play = () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    FLY.loaderShow();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(swapped, "video replaced when playback is not allowed");
    assert.equal(swapped.src, "/assets/loading.webp", "with the animated image");
    await hide(FLY);
  }

  console.log("loader.test.js: all checks passed");
})();
