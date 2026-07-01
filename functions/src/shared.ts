import {setGlobalOptions} from "firebase-functions";
import {defineSecret, defineString} from "firebase-functions/params";
import * as admin from "firebase-admin";
import axios from "axios";
import {v4 as uuidv4} from "uuid";

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
  default: "https://call4li-nadlan.web.app",
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

export async function downloadAndUpload(
  sourceUrl: string,
  destPath: string,
  contentType: string
): Promise<{publicUrl: string}> {
  const response = await axios.get(sourceUrl, {
    responseType: "arraybuffer",
    timeout: 60000,
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
