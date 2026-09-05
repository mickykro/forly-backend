/*
 * quota.js — per-client entitlements ("what did they pay for").
 *
 * Clients pay on another platform that doesn't talk to Forly, so an operator
 * sets each client's allowance by hand in the admin panel and Forly enforces
 * it. One-time bundles: `<kind>_cap` is the total the client bought, and
 * `<kind>_used` only ever counts up until an admin tops the cap up or resets
 * the counter. There are no periods.
 *
 * Ledger: businesses/{phone}/quota/current — the same doc the chat cap and the
 * n8n pipelines already keep counters in (flat `<kind>_used` / `<kind>_cap`
 * fields, so `walkthroughs_*` keeps the exact shape n8n knows).
 *
 * A cap that was never set (field absent / null) means "no bundle limit" — the
 * pre-existing behaviour for that kind keeps applying. That keeps deploying
 * this from cutting off existing customers; the admin panel flags unset caps.
 *
 * Blocked attempts are recorded (quota_events subcollection + a
 * `last_blocked` snapshot on the doc) and the operator is WhatsApped, at most
 * once per hour per client+kind so a retrying client can't spam them.
 *
 * The apply* functions are pure (doc-in, doc-out) so the arithmetic is unit
 * testable; the exported async helpers wrap them in Firestore transactions.
 */

const KINDS = ["walkthroughs", "chat_image_edits", "chat_msgs", "carousels"];

// Hebrew labels for client-facing messages and the admin notification.
const LABELS = {
  walkthroughs: "יצירות נכס (סרטון + דף)",
  chat_image_edits: "עריכות תמונה בצ׳אט",
  chat_msgs: "הודעות צ׳אט בוט",
  carousels: "קרוסלות",
};

// Starter bundle for a NEW signup (trial). Seeded once at profile completion;
// never overwrites an existing ledger. walkthroughs:4 matches the historical
// seed so nothing changes for the flow that already existed.
const TRIAL_CAPS = { walkthroughs: 4, chat_image_edits: 0, chat_msgs: 200, carousels: 0 };

const ADMIN_NOTIFY_GAP_MS = 60 * 60 * 1000;
// Big enough to hold a full replayable payload (image URL(s) + prompt for an
// edit); still far under Firestore's 1 MB per-doc ceiling.
const MAX_SAVED_REQUEST_BYTES = 32 * 1024;

const capKey = (kind) => `${kind}_cap`;
const usedKey = (kind) => `${kind}_used`;
const isKind = (k) => KINDS.includes(k);

// Whole numbers only; null/undefined → "unset".
function toCap(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Seed doc for a fresh signup (flat shape, same as the legacy seed). */
function trialSeed(now = new Date()) {
  const doc = { period_start: now, reset_at: now, plan: "trial" };
  for (const k of KINDS) {
    doc[capKey(k)] = TRIAL_CAPS[k];
    doc[usedKey(k)] = 0;
  }
  return doc;
}

/** Normalised view of a ledger doc for APIs/UI. */
function summarize(doc, paymentUrl) {
  const d = doc || {};
  const kinds = {};
  for (const k of KINDS) {
    const cap = toCap(d[capKey(k)]);
    const used = Math.max(0, Number(d[usedKey(k)]) || 0);
    kinds[k] = {
      label: LABELS[k],
      cap,                                       // null = unset (no bundle limit)
      used,
      remaining: cap === null ? null : Math.max(0, cap - used),
      exhausted: cap !== null && used >= cap,
    };
  }
  return {
    plan: d.plan || "",
    notes: d.notes || "",
    updated_at: d.updated_at || null,
    updated_by: d.updated_by || null,
    last_blocked: d.last_blocked || null,
    payment_url: paymentUrl || null,
    kinds,
  };
}

// ── pure ledger arithmetic ──

/**
 * applyConsume(doc, kind, amount) → { ok, doc, cap, used, remaining }
 * ok:false leaves the doc untouched. An unset cap never blocks.
 */
function applyConsume(doc, kind, amount = 1) {
  if (!isKind(kind)) throw new Error(`unknown quota kind: ${kind}`);
  const n = Math.max(1, Math.floor(Number(amount) || 1));
  const d = { ...(doc || {}) };
  const cap = toCap(d[capKey(kind)]);
  const used = Math.max(0, Number(d[usedKey(kind)]) || 0);
  if (cap !== null && used + n > cap) {
    return { ok: false, doc: d, cap, used, remaining: Math.max(0, cap - used), requested: n };
  }
  d[usedKey(kind)] = used + n;
  return {
    ok: true, doc: d, cap, used: used + n,
    remaining: cap === null ? null : cap - (used + n),
  };
}

/**
 * applyCaps(doc, patch, by, now) → { doc, changes }
 * patch: { caps?: {kind: n|null}, reset_used?: [kind], plan?, notes? }
 * Only whitelisted kinds are touched; anything else in the patch is ignored,
 * so an admin request can never write an arbitrary field.
 */
function applyCaps(doc, patch, by, now = new Date()) {
  const d = { ...(doc || {}) };
  const changes = [];
  const caps = (patch && patch.caps) || {};
  for (const k of Object.keys(caps)) {
    if (!isKind(k)) continue;
    const next = toCap(caps[k]);
    const prev = toCap(d[capKey(k)]);
    if (next === prev) continue;
    d[capKey(k)] = next;
    changes.push({ field: capKey(k), from: prev, to: next });
  }
  for (const k of (patch && Array.isArray(patch.reset_used) ? patch.reset_used : [])) {
    if (!isKind(k)) continue;
    const prev = Number(d[usedKey(k)]) || 0;
    if (prev === 0) continue;
    d[usedKey(k)] = 0;
    changes.push({ field: usedKey(k), from: prev, to: 0 });
  }
  if (patch && typeof patch.plan === "string" && patch.plan.slice(0, 40) !== (d.plan || "")) {
    changes.push({ field: "plan", from: d.plan || "", to: patch.plan.slice(0, 40) });
    d.plan = patch.plan.slice(0, 40);
  }
  if (patch && typeof patch.notes === "string" && patch.notes.slice(0, 500) !== (d.notes || "")) {
    changes.push({ field: "notes", from: d.notes || "", to: patch.notes.slice(0, 500) });
    d.notes = patch.notes.slice(0, 500);
  }
  if (changes.length) {
    d.updated_at = now;
    d.updated_by = by || null;
  }
  return { doc: d, changes };
}

// Persist a blocked request so it can be REPLAYED after the client tops up:
// keep the original structure intact (an object stays an object, a string stays
// a string) rather than stringify-and-truncate, which would corrupt the payload
// and make it un-replayable. If it's larger than the cap we drop the body and
// keep a preview + a flag, so we never store a half-JSON blob that can't be run.
function trimRequest(req) {
  if (req === undefined || req === null) return null;
  let size;
  try { size = Buffer.byteLength(JSON.stringify(req)); } catch { req = String(req); size = req.length; }
  if (size <= MAX_SAVED_REQUEST_BYTES) return req;           // replayable as-is
  let preview;
  try { preview = JSON.stringify(req).slice(0, 1024); } catch { preview = String(req).slice(0, 1024); }
  return { _truncated: true, _bytes: size, _preview: preview + "…" };
}

// A refusal is either "nothing left" or "a batch that doesn't fit": cap 4,
// used 3, requested 3 is refused with 1 slot still free. Report the real
// arithmetic (remaining + requested) so the client, the operator and the n8n
// branch can all tell those two cases apart — a hardcoded remaining:0 read as
// "exhausted" when it wasn't.
function refusalNumbers(info) {
  const cap = info && info.cap != null ? info.cap : null;
  const used = info && info.used != null ? info.used : null;
  const remaining = info && Number.isFinite(info.remaining) ? info.remaining
    : (cap !== null && used !== null ? Math.max(0, cap - used) : 0);
  const requested = info && Number.isFinite(info.requested) ? info.requested : 1;
  return { cap, used, remaining, requested };
}

/** Client-facing refusal: friendly Hebrew text + payment link. */
function blockedMessage(kind, paymentUrl, info) {
  const label = LABELS[kind] || kind;
  const { remaining, requested } = refusalNumbers(info);
  const lines = [
    remaining > 0
      ? `נותרו לך ${remaining} במכסת ${label}, אבל הבקשה הזו דורשת ${requested}.`
      : `המכסה שלך ל${label} נוצלה במלואה.`,
    paymentUrl ? `לרכישת חבילה נוספת: ${paymentUrl}` : "לרכישת חבילה נוספת דברו איתנו.",
    "לאחר התשלום נעדכן את החשבון והבקשה האחרונה שלך תישמר.",
  ];
  return lines.join("\n");
}

function blockedResponse(kind, paymentUrl, info) {
  const { cap, used, remaining, requested } = refusalNumbers(info);
  return {
    error: "quota_exceeded",
    kind,
    label: LABELS[kind] || kind,
    cap,
    used,
    remaining,
    requested,
    payment_url: paymentUrl || null,
    message: blockedMessage(kind, paymentUrl, info),
  };
}

// ── Firestore-backed helpers ──
//   createQuota({ db, sendWhatsApp, adminPhone, paymentUrl }) → api
//   db: the firebase-admin Firestore instance (may be null for in-memory dev)
function createQuota({ db, sendWhatsApp, adminPhone, paymentUrl, FieldValue } = {}) {
  const ref = (phone) => db.collection("businesses").doc(phone).collection("quota").doc("current");

  async function getQuota(phone) {
    if (!db || !phone) return summarize(null, paymentUrl);
    const snap = await ref(phone).get();
    return summarize(snap.exists ? snap.data() : null, paymentUrl);
  }

  async function getRaw(phone) {
    if (!db || !phone) return null;
    const snap = await ref(phone).get();
    return snap.exists ? snap.data() : null;
  }

  // Best-effort operator alert, throttled per client+kind. Never throws.
  async function notifyAdmin(phone, kind, info, business) {
    if (!sendWhatsApp || !adminPhone) return;
    const name = (business && (business.business_name || business.full_name)) || "";
    const msg = [
      "🚫 מכסה נגמרה",
      `${name ? name + " · " : ""}${phone}`,
      `ניסה/תה: ${LABELS[kind] || kind}`,
      `נוצל ${info.used} מתוך ${info.cap}`,
      "הבקשה האחרונה נשמרה בפאנל הניהול.",
    ].join("\n");
    try { await sendWhatsApp(adminPhone, msg); } catch (err) {
      console.warn("quota admin notify failed:", err.message);
    }
  }

  /**
   * consume(phone, kind, amount, { request, source, business })
   * Atomic check-and-increment. Returns { ok, remaining, cap, used } or, when
   * blocked, { ok:false, ...blockedResponse }. Without Firestore (local
   * in-memory dev) everything is allowed.
   */
  async function consume(phone, kind, amount = 1, opts = {}) {
    if (!isKind(kind)) throw new Error(`unknown quota kind: ${kind}`);
    if (!db || !phone) return { ok: true, remaining: null, cap: null, used: 0 };

    const now = new Date();
    let outcome;
    let shouldNotify = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref(phone));
      const cur = snap.exists ? snap.data() : {};
      const n = Math.max(1, Math.floor(Number(amount) || 1));
      const r = applyConsume(cur, kind, amount);
      outcome = r;
      if (r.ok) {
        const patch = { [usedKey(kind)]: r.doc[usedKey(kind)] };
        // The client just successfully ran this kind again — so any request of
        // this kind we saved while they were blocked has now been fulfilled
        // (typically right after the operator topped their bundle up). Clear it
        // so it isn't shown or replayed twice.
        const lb = cur.last_blocked;
        if (lb && lb.kind === kind && !lb.replayed) {
          patch.last_blocked = FieldValue
            ? FieldValue.delete()
            : Object.assign({}, lb, { replayed: true, replayed_at: now });
        }
        tx.set(ref(phone), patch, { merge: true });
        return;
      }
      // Blocked: save EVERYTHING about the request so the client can re-run it
      // once the operator opens more quota, and throttle the operator alert.
      const lastNotify = cur[`notify_${kind}_at`];
      const lastMs = lastNotify && lastNotify.toMillis ? lastNotify.toMillis() :
        lastNotify ? new Date(lastNotify).getTime() : 0;
      shouldNotify = now.getTime() - lastMs >= ADMIN_NOTIFY_GAP_MS;
      const blocked = {
        kind, amount: n, at: now, source: opts.source || null,
        cap: r.cap, used: r.used,
        request: trimRequest(opts.request),
        replayed: false,
      };
      const patch = {
        last_blocked: blocked,
        [`blocked_${kind}_count`]: (FieldValue ? FieldValue.increment(1) : (Number(cur[`blocked_${kind}_count`]) || 0) + 1),
      };
      if (shouldNotify) patch[`notify_${kind}_at`] = now;
      tx.set(ref(phone), patch, { merge: true });
      tx.set(ref(phone).parent.parent.collection("quota_events").doc(), blocked);
    });

    if (outcome.ok) {
      return { ok: true, remaining: outcome.remaining, cap: outcome.cap, used: outcome.used };
    }
    if (shouldNotify) await notifyAdmin(phone, kind, outcome, opts.business);
    return { ok: false, ...blockedResponse(kind, paymentUrl, outcome) };
  }

  /** Admin: set caps / reset counters / plan / notes, with an audit entry. */
  async function setCaps(phone, patch, by) {
    if (!db || !phone) return { changes: [] };
    const now = new Date();
    let result;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref(phone));
      const cur = snap.exists ? snap.data() : {};
      result = applyCaps(cur, patch, by, now);
      if (!result.changes.length) return;
      tx.set(ref(phone), result.doc, { merge: true });
      tx.set(ref(phone).parent.parent.collection("quota_history").doc(), {
        at: now, by: by || null, changes: result.changes,
      });
    });
    return { changes: result ? result.changes : [], quota: summarize(result ? result.doc : null, paymentUrl) };
  }

  async function history(phone, limit = 50) {
    if (!db || !phone) return [];
    const snap = await db.collection("businesses").doc(phone)
      .collection("quota_history").orderBy("at", "desc").limit(limit).get();
    return snap.docs.map((d) => d.data());
  }

  async function events(phone, limit = 20) {
    if (!db || !phone) return [];
    const snap = await db.collection("businesses").doc(phone)
      .collection("quota_events").orderBy("at", "desc").limit(limit).get();
    return snap.docs.map((d) => d.data());
  }

  /**
   * Admin: dismiss the saved refused request (the alert in the panel) without
   * touching caps. The block itself stays in quota_events; this only clears
   * the "pending" marker, and the dismissal is audited like any other change.
   */
  async function clearBlocked(phone, by) {
    if (!db || !phone) return { cleared: false, quota: summarize(null, paymentUrl) };
    const now = new Date();
    let cleared = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref(phone));
      const cur = snap.exists ? snap.data() : {};
      if (!cur.last_blocked) return;
      cleared = true;
      tx.set(ref(phone), { last_blocked: FieldValue ? FieldValue.delete() : null }, { merge: true });
      tx.set(ref(phone).parent.parent.collection("quota_history").doc(), {
        at: now, by: by || null,
        changes: [{ field: "last_blocked", from: cur.last_blocked.kind || "?", to: null }],
      });
    });
    return { cleared, quota: await getQuota(phone) };
  }

  /**
   * After a top-up: ask the CLIENT on WhatsApp whether to redo the request
   * that was refused. Sends only when a pending request exists and the caps
   * now cover it. The redo itself runs in n8n when the client answers "כן":
   * n8n reads the saved request from GET /api/quota/status and re-submits it;
   * the consume() that follows clears last_blocked.
   */
  async function offerReplay(phone, business) {
    const raw = await getRaw(phone);
    const p = pendingReplay(raw);
    if (!p) return { offered: false, reason: "nothing_pending" };
    if (!p.fits) return { offered: false, reason: "does_not_fit", remaining: p.remaining, amount: p.amount };
    if (!sendWhatsApp) return { offered: false, reason: "whatsapp_not_configured" };
    const name = (business && (business.full_name || business.business_name)) || "";
    const label = LABELS[p.kind] || p.kind;
    const msg = [
      `${name ? name + ", " : ""}המכסה שלך עודכנה ✅`,
      p.remaining === null ? `אין כרגע הגבלה על ${label}.` : `נותרו לך עכשיו ${p.remaining} ${label}.`,
      `לבצע שוב את הבקשה שנחסמה (${label}${p.amount > 1 ? " ×" + p.amount : ""})?`,
      "השב/י *כן* ונריץ אותה עכשיו.",
    ].join("\n");
    await sendWhatsApp(phone, msg);
    const now = new Date();
    await ref(phone).set({ last_blocked: { ...raw.last_blocked, offered_at: now } }, { merge: true });
    return { offered: true, kind: p.kind, amount: p.amount };
  }

  return {
    getQuota, getRaw, consume, setCaps, clearBlocked, offerReplay, history, events,
    summarize: (d) => summarize(d, paymentUrl),
  };
}

/**
 * pendingReplay(doc) → null | { kind, amount, remaining, fits, request, at, offered_at, source }
 * The saved refused request, and whether the CURRENT caps would now let it
 * run. Pure, so the "does it fit after this top-up" rule is unit-tested.
 */
function pendingReplay(doc) {
  const lb = doc && doc.last_blocked;
  if (!lb || lb.replayed || !isKind(lb.kind)) return null;
  const amount = Math.max(1, Math.floor(Number(lb.amount) || 1));
  const cap = toCap(doc[capKey(lb.kind)]);
  const used = Math.max(0, Number(doc[usedKey(lb.kind)]) || 0);
  const remaining = cap === null ? null : Math.max(0, cap - used);
  return {
    kind: lb.kind, amount, remaining,
    fits: cap === null || remaining >= amount,
    request: lb.request === undefined ? null : lb.request,
    at: lb.at || null, offered_at: lb.offered_at || null, source: lb.source || null,
  };
}

module.exports = {
  KINDS, LABELS, TRIAL_CAPS,
  capKey, usedKey, isKind, toCap,
  trialSeed, summarize, applyConsume, applyCaps, pendingReplay,
  blockedMessage, blockedResponse, trimRequest,
  createQuota,
};
