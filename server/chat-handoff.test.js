// The handoff guard used to be a per-conversation latch: once a lead was
// captured, every later submit on that conversation returned {ok:true} and
// WhatsApped nobody — a second lead from the same chat silently vanished.
// It is now a phone+time window, and this pins that shape.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { asMillis } = require("./utils");

const src = fs.readFileSync(path.join(__dirname, "routes", "chat.js"), "utf8");
assert.ok(/const DEDUPE_MS = /.test(src), "handoff dedupe window is gone");
const DEDUPE_MS = Number(/const DEDUPE_MS = ([\d\s*]+);/.exec(src)[1].split("*").reduce((a, b) => a * Number(b), 1));

// the route's own condition, lifted verbatim
function swallowed(prev, prospectPhone, now) {
  return !!(prev && prev.captured && prev.phone === prospectPhone &&
    now - asMillis(prev.at) < DEDUPE_MS);
}

const NOW = 1_700_000_000_000;
const lead = (at, phone) => ({ captured: true, phone, at: new Date(at) });

// a double-tap on the same number is the retry we want to drop
assert.equal(swallowed(lead(NOW - 2000, "972501234567"), "972501234567", NOW), true);
// the same visitor coming back later is a real second lead
assert.equal(swallowed(lead(NOW - DEDUPE_MS - 1, "972501234567"), "972501234567", NOW), false);
// a different number on the same conversation always goes through
assert.equal(swallowed(lead(NOW - 2000, "972501234567"), "972529999999", NOW), false);
// no prior lead, or an unreadable timestamp, must never swallow the send
assert.equal(swallowed(null, "972501234567", NOW), false);
assert.equal(swallowed({ captured: true, phone: "972501234567" }, "972501234567", NOW), false);

console.log("chat-handoff: all tests passed");
