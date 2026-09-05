/*
 * quota.test.js — the pure ledger arithmetic behind paid bundles.
 * Plain-node test, matching the rest of server/*.test.js.
 */
const assert = require("assert");
const q = require("./quota");

// ── consume: counts up, blocks at cap, never blocks an unset cap ──
let r = q.applyConsume({ walkthroughs_cap: 2, walkthroughs_used: 0 }, "walkthroughs");
assert.deepStrictEqual([r.ok, r.used, r.remaining], [true, 1, 1]);
r = q.applyConsume(r.doc, "walkthroughs");
assert.deepStrictEqual([r.ok, r.used, r.remaining], [true, 2, 0]);
r = q.applyConsume(r.doc, "walkthroughs");
assert.strictEqual(r.ok, false, "third creation on a 2-cap must block");
assert.strictEqual(r.doc.walkthroughs_used, 2, "a blocked attempt must not count");
assert.strictEqual(r.remaining, 0);

// unset cap (legacy doc / admin hasn't configured) → allowed, remaining null
r = q.applyConsume({}, "chat_image_edits");
assert.deepStrictEqual([r.ok, r.used, r.remaining], [true, 1, null]);
r = q.applyConsume({ chat_msgs_cap: null }, "chat_msgs");
assert.strictEqual(r.ok, true);

// amount > 1 must fit entirely
r = q.applyConsume({ carousels_cap: 3, carousels_used: 2 }, "carousels", 2);
assert.strictEqual(r.ok, false);
r = q.applyConsume({ carousels_cap: 3, carousels_used: 1 }, "carousels", 2);
assert.deepStrictEqual([r.ok, r.used], [true, 3]);

// garbage in the doc never yields a negative or NaN counter
r = q.applyConsume({ walkthroughs_cap: "4", walkthroughs_used: "abc" }, "walkthroughs");
assert.deepStrictEqual([r.ok, r.used, r.cap], [true, 1, 4]);

assert.throws(() => q.applyConsume({}, "not_a_kind"), /unknown quota kind/);

// ── setCaps: whitelisted, records changes, reset zeroes used ──
const now = new Date("2026-09-03T00:00:00Z");
let s = q.applyCaps(
  { walkthroughs_cap: 4, walkthroughs_used: 4 },
  { caps: { walkthroughs: 10, evil_field: 99, chat_msgs: "500" }, reset_used: ["walkthroughs"], plan: "pro" },
  "972500000000", now
);
assert.strictEqual(s.doc.walkthroughs_cap, 10);
assert.strictEqual(s.doc.walkthroughs_used, 0, "reset_used zeroes the counter");
assert.strictEqual(s.doc.chat_msgs_cap, 500, "string numbers are accepted");
assert.strictEqual(s.doc.evil_field, undefined, "unknown kinds are ignored");
assert.strictEqual(s.doc.evil_field_cap, undefined);
assert.strictEqual(s.doc.plan, "pro");
assert.strictEqual(s.doc.updated_by, "972500000000");
assert.ok(s.changes.some((c) => c.field === "walkthroughs_cap" && c.from === 4 && c.to === 10));
assert.ok(s.changes.some((c) => c.field === "walkthroughs_used" && c.from === 4 && c.to === 0));

// no-op patch → no changes, no updated_at stamp
s = q.applyCaps({ walkthroughs_cap: 10 }, { caps: { walkthroughs: 10 } }, "x", now);
assert.strictEqual(s.changes.length, 0);
assert.strictEqual(s.doc.updated_at, undefined);

// clearing a cap (null) = back to "no bundle limit"
s = q.applyCaps({ walkthroughs_cap: 10 }, { caps: { walkthroughs: null } }, "x", now);
assert.strictEqual(s.doc.walkthroughs_cap, null);

// ── summarize / seed / messages ──
const sum = q.summarize({ walkthroughs_cap: 4, walkthroughs_used: 4, chat_msgs_used: 7 }, "https://pay.example");
assert.strictEqual(sum.kinds.walkthroughs.exhausted, true);
assert.strictEqual(sum.kinds.walkthroughs.remaining, 0);
assert.strictEqual(sum.kinds.chat_msgs.cap, null);
assert.strictEqual(sum.kinds.chat_msgs.remaining, null);
assert.strictEqual(sum.payment_url, "https://pay.example");

const seed = q.trialSeed(now);
assert.strictEqual(seed.walkthroughs_cap, 4, "trial seed keeps the historical 4 walkthroughs");
assert.strictEqual(seed.walkthroughs_used, 0);
for (const k of q.KINDS) assert.ok(k + "_cap" in seed && k + "_used" in seed);

const blocked = q.blockedResponse("walkthroughs", "https://pay.example", { cap: 4, used: 4 });
assert.strictEqual(blocked.error, "quota_exceeded");
assert.ok(blocked.message.includes("https://pay.example"));
assert.ok(q.blockedMessage("carousels", "").length > 0, "message works without a payment link");

// A batch refused while slots remain must report the real arithmetic, not a
// "blocked" flag: cap 4, used 3, requested 3 → remaining 1, requested 3.
r = q.applyConsume({ chat_image_edits_cap: 4, chat_image_edits_used: 3 }, "chat_image_edits", 3);
assert.deepStrictEqual([r.ok, r.remaining, r.requested], [false, 1, 3]);
const partial = q.blockedResponse("chat_image_edits", "", r);
assert.deepStrictEqual([partial.cap, partial.used, partial.remaining, partial.requested], [4, 3, 1, 3]);
assert.ok(partial.message.includes("1") && partial.message.includes("3"), "message names remaining and requested");
// fully exhausted → remaining 0, and the message says so
const full = q.blockedResponse("walkthroughs", "", { cap: 4, used: 4, remaining: 0, requested: 1 });
assert.strictEqual(full.remaining, 0);
assert.ok(full.message.includes("במלואה"));

// saved request is preserved intact so it can be REPLAYED after a top-up:
// a normal payload comes back structurally unchanged (object stays object).
const savedReq = q.trimRequest({ image_url: "https://x/y.jpg", prompt: "brighten" });
assert.deepStrictEqual(savedReq, { image_url: "https://x/y.jpg", prompt: "brighten" });
assert.strictEqual(q.trimRequest("edit please"), "edit please");
assert.strictEqual(q.trimRequest(undefined), null);
// only an oversized payload is dropped — and then never as a corrupt half-JSON
// blob: it becomes a flagged preview, not a truncated string we could try to run.
const big = q.trimRequest({ blob: "x".repeat(40000) });
assert.strictEqual(big._truncated, true);
assert.ok(big._bytes > 32 * 1024);
assert.ok(typeof big._preview === "string" && big._preview.length <= 1100);

// ── pendingReplay: does the saved refused request fit the CURRENT caps? ──
assert.strictEqual(q.pendingReplay({}), null, "nothing saved → nothing pending");
assert.strictEqual(q.pendingReplay({ last_blocked: { kind: "chat_image_edits", amount: 3, replayed: true } }), null,
  "an already-replayed request is not pending");
assert.strictEqual(q.pendingReplay({ last_blocked: { kind: "bogus", amount: 1 } }), null);
let pr = q.pendingReplay({ chat_image_edits_cap: 4, chat_image_edits_used: 3,
  last_blocked: { kind: "chat_image_edits", amount: 3, request: { message: "x", images: ["a"] } } });
assert.deepStrictEqual([pr.fits, pr.remaining, pr.amount], [false, 1, 3], "3 needed, 1 left → doesn't fit");
assert.deepStrictEqual(pr.request, { message: "x", images: ["a"] }, "request comes back intact for replay");
pr = q.pendingReplay({ chat_image_edits_cap: 7, chat_image_edits_used: 3, last_blocked: { kind: "chat_image_edits", amount: 3 } });
assert.deepStrictEqual([pr.fits, pr.remaining], [true, 4], "after a top-up to 7 it fits");
pr = q.pendingReplay({ chat_image_edits_cap: 4, chat_image_edits_used: 0, last_blocked: { kind: "chat_image_edits", amount: 3 } });
assert.strictEqual(pr.fits, true, "a reset counter also makes it fit");
pr = q.pendingReplay({ last_blocked: { kind: "chat_image_edits", amount: 3 } });
assert.deepStrictEqual([pr.fits, pr.remaining], [true, null], "unset cap = unlimited → fits");

// ── shouldClearBlocked: which successes fulfil the saved refused request ──
const lb3 = { kind: "chat_image_edits", amount: 3 };
assert.strictEqual(q.shouldClearBlocked(lb3, "chat_image_edits", 1, false), false,
  "one ordinary edit leaves a pending 3-image batch standing");
assert.strictEqual(q.shouldClearBlocked(lb3, "chat_image_edits", 3, false), true, "a 3-batch success fulfils it");
assert.strictEqual(q.shouldClearBlocked(lb3, "chat_image_edits", 5, false), true, "a bigger batch too");
assert.strictEqual(q.shouldClearBlocked(lb3, "chat_image_edits", 1, true), true, "an explicit replay always clears");
assert.strictEqual(q.shouldClearBlocked(lb3, "walkthroughs", 5, true), false, "a different kind never clears");
assert.strictEqual(q.shouldClearBlocked(Object.assign({ replayed: true }, lb3), "chat_image_edits", 3, true), false,
  "already replayed → nothing to clear");
assert.strictEqual(q.shouldClearBlocked(null, "chat_image_edits", 1, true), false);
assert.strictEqual(q.shouldClearBlocked({ kind: "walkthroughs", amount: 1 }, "walkthroughs", 1, false), true,
  "re-creating the one refused property fulfils a single block");

console.log("quota.test.js OK");
