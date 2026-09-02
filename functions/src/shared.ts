import {setGlobalOptions} from "firebase-functions";
import {defineSecret, defineString} from "firebase-functions/params";
import * as admin from "firebase-admin";
import axios from "axios";
import {v4 as uuidv4} from "uuid";
import * as net from "net";
import {promises as dns} from "dns";

if (admin.apps.length === 0) {
  admin.initializeApp();
}
setGlobalOptions({region: "europe-west1", maxInstances: 10});

export const bucket = admin.storage().bucket();
export const db = admin.firestore();

// ── secrets & params (shared across carousel + nadlan) ──
export const greenApiInstance = defineSecret("GREENAPI_INSTANCE");
export const greenApiToken = defineSecret("GREENAPI_TOKEN");
export const nadlanJwtSecret = defineSecret("NADLAN_JWT_SECRET");
export const demoSecret = defineSecret("DEMO_SECRET");
export const pageBaseUrl = defineString("PAGE_BASE_URL", {
  // Branded ("pretty") domain — pages resolve here directly instead of the
  // raw *.web.app host, which only redirects to it anyway.
  default: "https://nadlan.call4li.com",
});
export const n8nLeadWebhookUrl = defineString("N8N_LEAD_WEBHOOK_URL", {default: ""});
export const n8nPipelineWebhookUrl = defineString("N8N_PIPELINE_WEBHOOK_URL", {default: ""});
export const n8nWw1WebhookUrl = defineString("N8N_WW1_WEBHOOK_URL", {default: ""});
export const adminPhone = defineString("ADMIN_PHONE", {default: ""});

export const pad = (n: number): string => String(n).padStart(2, "0");

export function setCors(
  res: {set: (k: string, v: string) => void},
  origin: string
): void {
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

export function tokenedUrl(destPath: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(destPath)}?alt=media&token=${token}`;
}

export async function uploadBuffer(
  destPath: string,
  data: Buffer,
  contentType: string
): Promise<{publicUrl: string}> {
  const token = uuidv4();
  const file = bucket.file(destPath);
  await file.save(data, {
    metadata: {
      contentType,
      cacheControl: "public, max-age=86400",
      metadata: {firebaseStorageDownloadTokens: token},
    },
  });
  return {publicUrl: tokenedUrl(destPath, token)};
}

// ── SSRF guard ──
// Every fetch of a client/n8n-supplied URL must resolve to a public address, or
// an attacker could point it at 169.254.169.254 (cloud metadata) or an internal
// service. Validates the resolved IPs (not just the hostname) to blunt DNS
// rebinding. Mirrors server/utils.js assertPublicHttpUrl.
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return true;
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw new Error("invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("blocked_url_scheme");
  if (u.username || u.password) throw new Error("blocked_url_credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked_private_address");
    return u.toString();
  }
  const records = await dns.lookup(host, {all: true});
  if (!records.length) throw new Error("dns_no_records");
  for (const {address} of records) {
    if (isPrivateIp(address)) throw new Error("blocked_private_address");
  }
  return u.toString();
}

const MAX_DOWNLOAD_BYTES = 130 * 1024 * 1024;

export async function downloadAndUpload(
  sourceUrl: string,
  destPath: string,
  contentType: string
): Promise<{publicUrl: string}> {
  const safeUrl = await assertPublicHttpUrl(sourceUrl);
  const response = await axios.get(safeUrl, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
    maxRedirects: 0,
  });
  return uploadBuffer(destPath, Buffer.from(response.data as ArrayBuffer), contentType);
}

// ── Green-API WhatsApp ──
const GREEN_TIMEOUT_MS = 20000;

export async function sendWhatsAppMessage(
  phone: string,
  message: string,
  instance: string,
  token: string
): Promise<void> {
  const baseUrl = `https://api.green-api.com/waInstance${instance}`;
  await axios.post(`${baseUrl}/sendMessage/${token}`, {
    chatId: `${phone}@c.us`,
    message,
  }, {timeout: GREEN_TIMEOUT_MS});
}

export async function sendWhatsAppFile(
  phone: string,
  urlFile: string,
  fileName: string,
  caption: string,
  instance: string,
  token: string
): Promise<void> {
  const baseUrl = `https://api.green-api.com/waInstance${instance}`;
  await axios.post(`${baseUrl}/sendFileByUrl/${token}`, {
    chatId: `${phone}@c.us`,
    urlFile,
    fileName,
    caption,
  }, {timeout: GREEN_TIMEOUT_MS});
}

/** Normalize an Israeli phone to Green-API format: 9725XXXXXXXX. */
export function normalizePhone(raw: string): string | null {
  const digits = String(raw).replace(/\D/g, "");
  if (/^05\d{8}$/.test(digits)) return "972" + digits.slice(1);
  if (/^9725\d{8}$/.test(digits)) return digits;
  if (/^5\d{8}$/.test(digits)) return "972" + digits;
  return null;
}
