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
export const whapiToken = defineSecret("WHAPI_TOKEN");
// Every function that sends WhatsApp declares all of these, so switching
// provider (WHATSAPP_PROVIDER) needs no code change. Each must exist in
// Secret Manager for a deploy to succeed — a placeholder value is fine for
// the provider not in use.
export const whatsappSecrets = [greenApiInstance, greenApiToken, whapiToken];
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

// ── WhatsApp ──
// WHATSAPP_PROVIDER (greenapi | whapi; default greenapi) picks the provider —
// the same switch as server/whatsapp/. Senders take only phone + content;
// URLs, auth and chat-id formats stay in here.
const WA_TIMEOUT_MS = 20000;

type Provider = {
  text(phone: string, message: string): Promise<unknown>;
  file(phone: string, urlFile: string, fileName: string, caption: string): Promise<unknown>;
};

// The instance's own API host (first 4 digits of its id name its server), not
// the shared api.green-api.com, which can be down while the instance is up.
// GREENAPI_API_URL overrides it.
export function greenApiBase(instance: string): string {
  const override = (process.env.GREENAPI_API_URL || "").trim().replace(/\/+$/, "");
  return `${override || `https://${String(instance).slice(0, 4)}.api.greenapi.com`}/waInstance${instance}`;
}

const greenApi = (): Provider => {
  const base = greenApiBase(greenApiInstance.value());
  const token = greenApiToken.value();
  const post = (method: string, body: object) =>
    axios.post(`${base}/${method}/${token}`, body, {timeout: WA_TIMEOUT_MS});
  return {
    text: (phone, message) => post("sendMessage", {chatId: `${phone}@c.us`, message}),
    file: (phone, urlFile, fileName, caption) =>
      post("sendFileByUrl", {chatId: `${phone}@c.us`, urlFile, fileName, caption}),
  };
};

const whapi = (): Provider => {
  const base = (process.env.WHAPI_API_URL || "https://gate.whapi.cloud").trim().replace(/\/+$/, "");
  const post = (path: string, body: object) => axios.post(`${base}${path}`, body, {
    timeout: WA_TIMEOUT_MS,
    headers: {Authorization: `Bearer ${whapiToken.value()}`},
  });
  const to = (phone: string) => `${phone}@s.whatsapp.net`;
  return {
    text: (phone, message) => post("/messages/text", {to: to(phone), body: message}),
    file: (phone, urlFile, fileName, caption) => /\.(png|jpe?g|webp)$/i.test(fileName) ?
      post("/messages/image", {to: to(phone), media: urlFile, caption}) :
      post("/messages/document", {to: to(phone), media: urlFile, filename: fileName, caption}),
  };
};

function whatsapp(): Provider {
  const name = (process.env.WHATSAPP_PROVIDER || "greenapi").trim().toLowerCase();
  if (name === "whapi") return whapi();
  if (name === "greenapi") return greenApi();
  throw new Error(`WHATSAPP_PROVIDER "${name}" is not one of: greenapi, whapi`);
}

export async function sendWhatsAppMessage(phone: string, message: string): Promise<void> {
  await whatsapp().text(phone, message);
}

export async function sendWhatsAppFile(
  phone: string,
  urlFile: string,
  fileName: string,
  caption: string
): Promise<void> {
  await whatsapp().file(phone, urlFile, fileName, caption);
}

/** Normalize an Israeli phone to Green-API format: 9725XXXXXXXX. */
export function normalizePhone(raw: string): string | null {
  const digits = String(raw).replace(/\D/g, "");
  if (/^05\d{8}$/.test(digits)) return "972" + digits.slice(1);
  if (/^9725\d{8}$/.test(digits)) return digits;
  if (/^5\d{8}$/.test(digits)) return "972" + digits;
  return null;
}
