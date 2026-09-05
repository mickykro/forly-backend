/*
 * quota.ts — per-client paid bundles, Functions side.
 *
 * Mirrors server/quota.js on the SAME ledger (businesses/{phone}/quota/current,
 * flat `<kind>_cap` / `<kind>_used`). Atomic check-and-increment; an unset cap
 * never blocks (pre-existing behaviour keeps applying until an admin sets a
 * bundle). A blocked attempt is recorded and the operator is WhatsApped at
 * most once per hour per client+kind.
 */
import {FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {defineString} from "firebase-functions/params";
import {db, sendWhatsAppMessage, adminPhone, greenApiInstance, greenApiToken} from "../shared";

export const paymentLinkUrl = defineString("PAYMENT_LINK_URL", {default: ""});

export type QuotaKind = "walkthroughs" | "chat_image_edits" | "chat_msgs" | "carousels";
const KINDS: QuotaKind[] = ["walkthroughs", "chat_image_edits", "chat_msgs", "carousels"];
const LABELS: Record<QuotaKind, string> = {
  walkthroughs: "יצירות נכס (סרטון + דף)",
  chat_image_edits: "עריכות תמונה בצ׳אט",
  chat_msgs: "הודעות צ׳אט בוט",
  carousels: "קרוסלות",
};
const ADMIN_NOTIFY_GAP_MS = 60 * 60 * 1000;
const MAX_SAVED_REQUEST = 8 * 1024;

export const isKind = (k: string): k is QuotaKind => (KINDS as string[]).includes(k);

function toCap(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function trim(req: unknown): string | null {
  if (req === undefined || req === null) return null;
  let s: string;
  try { s = typeof req === "string" ? req : JSON.stringify(req); } catch { s = String(req); }
  return s.length > MAX_SAVED_REQUEST ? s.slice(0, MAX_SAVED_REQUEST) + "…" : s;
}

export function blockedMessage(kind: QuotaKind): string {
  const url = paymentLinkUrl.value();
  return [
    `המכסה שלך ל${LABELS[kind]} נוצלה במלואה.`,
    url ? `לרכישת חבילה נוספת: ${url}` : "לרכישת חבילה נוספת דברו איתנו.",
    "לאחר התשלום נעדכן את החשבון והבקשה האחרונה שלך תישמר.",
  ].join("\n");
}

export interface ConsumeResult {
  ok: boolean;
  cap: number | null;
  used: number;
  remaining: number | null;
  error?: "quota_exceeded";
  kind?: QuotaKind;
  label?: string;
  payment_url?: string | null;
  message?: string;
}

/** Atomic check-and-increment on the shared ledger. */
export async function consumeQuota(
  phone: string,
  kind: QuotaKind,
  amount = 1,
  opts: {request?: unknown; source?: string; businessName?: string} = {}
): Promise<ConsumeResult> {
  const n = Math.max(1, Math.floor(amount || 1));
  const ref = db.collection("businesses").doc(phone).collection("quota").doc("current");
  const now = new Date();
  let out: ConsumeResult = {ok: true, cap: null, used: 0, remaining: null};
  let notify = false;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = (snap.exists ? snap.data() : {}) as Record<string, unknown>;
    const cap = toCap(cur[`${kind}_cap`]);
    const used = Math.max(0, Number(cur[`${kind}_used`]) || 0);
    if (cap === null || used + n <= cap) {
      tx.set(ref, {[`${kind}_used`]: used + n}, {merge: true});
      out = {ok: true, cap, used: used + n, remaining: cap === null ? null : cap - (used + n)};
      return;
    }
    const last = cur[`notify_${kind}_at`] as {toMillis?: () => number} | Date | undefined;
    const lastMs = last && typeof (last as {toMillis?: () => number}).toMillis === "function" ?
      (last as {toMillis: () => number}).toMillis() : last ? new Date(last as Date).getTime() : 0;
    notify = now.getTime() - lastMs >= ADMIN_NOTIFY_GAP_MS;
    const patch: Record<string, unknown> = {
      last_blocked: {kind, at: now, source: opts.source || null, request: trim(opts.request)},
      [`blocked_${kind}_count`]: FieldValue.increment(1),
    };
    if (notify) patch[`notify_${kind}_at`] = now;
    tx.set(ref, patch, {merge: true});
    tx.set(db.collection("businesses").doc(phone).collection("quota_events").doc(), {
      kind, at: now, source: opts.source || null, cap, used, request: trim(opts.request),
    });
    out = {
      ok: false, error: "quota_exceeded", kind, label: LABELS[kind], cap, used, remaining: 0,
      payment_url: paymentLinkUrl.value() || null, message: blockedMessage(kind),
    };
  });

  if (!out.ok && notify) {
    const admin = adminPhone.value().split(",")[0].trim();
    if (admin) {
      try {
        await sendWhatsAppMessage(admin, [
          "🚫 מכסה נגמרה",
          `${opts.businessName ? opts.businessName + " · " : ""}${phone}`,
          `ניסה/תה: ${LABELS[kind]}`,
          `נוצל ${out.used} מתוך ${out.cap}`,
          "הבקשה האחרונה נשמרה בפאנל הניהול.",
        ].join("\n"), greenApiInstance.value(), greenApiToken.value());
      } catch (err) {
        logger.warn("quota admin notify failed:", err);
      }
    }
  }
  return out;
}
