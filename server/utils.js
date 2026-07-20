/*
 * utils.js — shared helpers
 * ponytail: no deps on db or express, pure functions
 */

const path = require("path");
const fs = require("fs");

const pad = (n) => String(n).padStart(2, "0");
const daysFromNow = (d) => new Date(Date.now() + d * 86400000);
// Firestore hands back Timestamps, the in-memory store plain Dates.
const asMillis = (v) => (v && v.toMillis ? v.toMillis() : v ? new Date(v).getTime() : 0);

// ── theme sanitization ──
const HEX = /^#[0-9a-fA-F]{6}$/;
const TEMPLATES = { original: 1, nocturne: 1, galerie: 1, reel: 1 };

function sanitizeTheme(t) {
  if (!t || typeof t !== "object") return null;
  const hex = (v) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim() : null);
  const str = (v) => (typeof v === "string" ? v.slice(0, 60) : null);
  const clean = {
    template: TEMPLATES[t.template] ? t.template : null,
    font_title: str(t.font_title),
    font_body: str(t.font_body),
    font_url: typeof t.font_url === "string" && /^https?:\/\//.test(t.font_url) ? t.font_url : null,
    primary: hex(t.primary),
    accent: hex(t.accent),
  };
  return (clean.template || clean.font_title || clean.font_body || clean.font_url || clean.primary || clean.accent) ? clean : null;
}

// ── language ──
const LANGUAGES = { he: 1, en: 1, ar: 1, ru: 1, es: 1, fr: 1 };
function sanitizeLang(v) {
  return (typeof v === "string" && LANGUAGES[v]) ? v : "he";
}

// ── phone normalization (Israel format) ──
function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (/^05\d{8}$/.test(digits)) return "972" + digits.slice(1);
  if (/^9725\d{8}$/.test(digits)) return digits;
  if (/^5\d{8}$/.test(digits)) return "972" + digits;
  return null;
}

// ── asset helpers ──
function guessImageExt(url) {
  const m = url.split("?")[0].match(/\.(png|webp|jpe?g)$/i);
  if (!m) return "jpg";
  const e = m[1].toLowerCase();
  return e === "png" ? "png" : e === "webp" ? "webp" : "jpg";
}

async function rehost(url, destRel, uploadDir, baseUrl) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const full = path.join(uploadDir, destRel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  return `${baseUrl}/files/${destRel}`;
}

// ── whatsapp ──
async function sendWhatsApp(phone, message, instance, token) {
  if (!instance || !token) return;
  await fetch(`https://api.green-api.com/waInstance${instance}/sendMessage/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: `${phone}@c.us`, message }),
    signal: AbortSignal.timeout(20000),
  });
}

// Send a file (image/video) by its public URL. Green-API fetches the URL itself,
// so it must be publicly reachable. Mirrors the Functions-side sendWhatsAppFile.
async function sendWhatsAppFile(phone, fileUrl, fileName, caption, instance, token) {
  if (!instance || !token) return;
  await fetch(`https://api.green-api.com/waInstance${instance}/sendFileByUrl/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chatId: `${phone}@c.us`,
      urlFile: fileUrl,
      fileName: fileName || "file",
      caption: caption || "",
    }),
    signal: AbortSignal.timeout(20000),
  });
}

module.exports = {
  pad, daysFromNow, asMillis,
  sanitizeTheme, sanitizeLang, normalizePhone,
  guessImageExt, rehost, sendWhatsApp, sendWhatsAppFile,
};
