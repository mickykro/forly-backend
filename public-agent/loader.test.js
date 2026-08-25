/* Loader state machine: a hide during playback must wait for the animation to
   finish, and must never strand the page if "ended" never arrives.
   Run: node public-agent/loader.test.js */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// Minimal fake DOM — just enough of the shape api.js touches.
function setup() {
  const listeners = {};
  const video = {
    duration: 5, currentTime: 0,
    play: () => Promise.resolve(),
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

// ── a hide mid-playback waits for "ended" ──
{
  const { FLY, box, fire } = setup();
  let revealed = false;
  FLY.loaderHide(() => { revealed = true; });
  assert.equal(revealed, false, "must not reveal while the animation is still playing");
  assert.equal(box.classes.has("hidden"), false, "loader stays visible until the animation ends");
  fire("ended");
  assert.equal(revealed, true, "reveals once the animation ends");
  assert.equal(box.classes.has("hidden"), true, "loader hides once the animation ends");
}

// ── without a pending hide, "ended" just loops ──
{
  const { box, video, fire } = setup();
  video.currentTime = 4;
  fire("ended");
  assert.equal(video.currentTime, 0, "replays from the start");
  assert.equal(box.classes.has("hidden"), false, "keeps looping while still loading");
}

// ── blocked autoplay must not strand the page ──
{
  const { FLY } = setup(); // autoplay blocked: "ended" never fires
  let revealed = false;
  FLY.loaderHide(() => { revealed = true; });
  assert.equal(revealed, false, "gives playback a chance to start first");
  setTimeout(() => {
    assert.equal(revealed, true, "safety timeout reveals the page anyway");
    console.log("loader.test.js: all checks passed");
  }, 5500);
}
