/*
 * utils.js — shared helpers
 * ponytail: no deps on db or express, pure functions
 */

const path = require("path");
const fs = require("fs");
const dns = require("dns").promises;
const net = require("net");
const crypto = require("crypto");
const { relayUpload } = require("./upload-relay");

const pad = (n) => String(n).padStart(2, "0");
const daysFromNow = (d) => new Date(Date.now() + d * 86400000);
const escapeHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Firestore hands back Timestamps, the in-memory store plain Dates.
const asMillis = (v) => (v && v.toMillis ? v.toMillis() : v ? new Date(v).getTime() : 0);

// ── theme sanitization ──
const HEX = /^#[0-9a-fA-F]{6}$/;
const TEMPLATES = { original: 1, nocturne: 1, reel: 1, movie: 1, atelier: 1, revue: 1, loupe: 1, orbite: 1 };

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

// The canonical phone form used for businesses/{phone} doc ids, session
// userIds and page ownership checks. normalizePhone() above is Israel-only and
// returns null otherwise; auth must also work for non-IL test numbers, so this
// one accepts international digits. Lives here rather than in auth.js so
// callers (and tests) can reach it without pulling in Express.
function normalizeAuthPhone(raw) {
  let p = String(raw || "").replace(/\D/g, "");
  if (!p) return null;
  if (p.startsWith("00")) p = p.slice(2);
  if (/^05\d{8}$/.test(p)) return "972" + p.slice(1);   // 0501234567 → 972501234567
  if (/^5\d{8}$/.test(p)) return "972" + p;             // 501234567  → 972501234567
  if (p.length >= 9 && p.length <= 15) return p;        // already international
  return null;
}

// ── infra hosts ──
// Hosts that must never appear in a link an end buyer can see, even if a
// deployment's env points at one. Lives here rather than in index.js so the
// operator scripts can require it — index.js calls app.listen on require.
const INFRA_HOST = /(hstgr\.cloud|trycloudflare\.com|ngrok(-free)?\.(io|app|dev)|loca\.lt|^https?:\/\/\d+\.\d+\.\d+\.\d+)/i;

/*
 * resolvePageBaseUrl({ pageBaseUrl, baseUrl, publicBaseUrl, allowInfra }) → string
 *
 * Which host goes into a link an end buyer can see. PAGE_BASE_URL wins when
 * set; otherwise a local BASE_URL is kept and anything else falls back to the
 * canonical domain.
 *
 * Note the long-standing quirk this preserves: INFRA_HOST also matches a bare
 * IP, so a BASE_URL of http://127.0.0.1:8787 is rewritten to publicBaseUrl
 * while http://localhost:8787 is not. Surprising, but it predates this helper
 * and pages built against either still resolve, so it is pinned by test rather
 * than changed here.
 *
 * An infra host (see INFRA_HOST) is rewritten to publicBaseUrl, because a
 * buyer-visible link must never carry a tunnel or bare-IP hostname that will
 * stop resolving. allowInfra opts out of that, and ONLY dev and staging set it
 * — they genuinely do serve pages from an infra host and their links must come
 * back to them rather than to production. Unset means the guard is on, so a
 * deployment that forgets is protected rather than exposed.
 */
function resolvePageBaseUrl({ pageBaseUrl, baseUrl, publicBaseUrl, allowInfra }) {
  const isLocalBase = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|$)/
    .test(baseUrl || "");
  const candidate = pageBaseUrl || (isLocalBase ? baseUrl : publicBaseUrl);
  const allow = /^(1|true|yes)$/i.test(String(allowInfra == null ? "" : allowInfra));
  return String(!allow && INFRA_HOST.test(candidate) ? publicBaseUrl : candidate)
    .replace(/\/+$/, "");
}

// ── asset helpers ──
function guessImageExt(url) {
  const m = url.split("?")[0].match(/\.(png|webp|jpe?g)$/i);
  if (!m) return "jpg";
  const e = m[1].toLowerCase();
  return e === "png" ? "png" : e === "webp" ? "webp" : "jpg";
}

// ── SSRF guard ──
// Reject any URL that resolves to a private, loopback, link-local, or otherwise
// non-public address so an attacker-supplied "image" URL can't reach the cloud
// metadata endpoint (169.254.169.254) or internal services. Validates the
// *resolved* IPs (not just the hostname) to blunt DNS-rebinding, and caps the
// fetch size. Used by every path that fetches a client-controlled URL.
const MAX_REHOST_BYTES = 130 * 1024 * 1024; // a touch above the 120MB video cap

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;               // loopback
    if (a === 0) return true;                 // "this host"
    if (a === 169 && b === 254) return true;  // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                // multicast / reserved
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true;                          // link-local
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check the embedded v4
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

// Returns the validated URL string, or throws. Only http/https, no embedded
// credentials, and every resolved address must be public.
async function assertPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw new Error("invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("blocked_url_scheme");
  if (u.username || u.password) throw new Error("blocked_url_credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // A literal IP host: check it directly (no DNS).
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked_private_address");
    return u.toString();
  }
  const records = await dns.lookup(host, { all: true });
  if (!records.length) throw new Error("dns_no_records");
  for (const { address } of records) {
    if (isPrivateIp(address)) throw new Error("blocked_private_address");
  }
  return u.toString();
}

// Read a fetch Response body but abort past a hard byte cap (defends against a
// URL that streams unbounded data into memory/disk).
async function readCapped(resp, maxBytes = MAX_REHOST_BYTES) {
  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) throw new Error("response_too_large");
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("response_too_large");
  return buf;
}

// Content types for the extensions the upload store accepts. The remote
// re-sniffs the bytes anyway (routes/intake.js), so this only has to be honest
// enough for the PUT; it is not a trust boundary.
const EXT_CONTENT_TYPE = {
  jpg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4",
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
};

/*
 * rehost(url, destRel, uploadDir, baseUrl, opts) → { url, fname, localPath }
 *
 * Downloads a client-supplied URL and republishes it from our own file store.
 *
 * The stored name is a FLAT `<uuid>.<ext>`, not the caller's `destRel` path.
 * destRel now only supplies the extension and keeps call sites readable. Flat
 * names are what the upload route accepts (`^[0-9a-f-]{36}\.(…)$` in
 * routes/intake.js), which is what lets the bytes be relayed to another
 * instance at all.
 *
 * opts.remoteUploadBase relays the bytes to an always-on instance and stamps
 * the returned URL with opts.uploadPublicBase. That is what stops a page built
 * on a laptop from carrying media URLs that die when the laptop sleeps. The
 * local copy is written EITHER way: routes/pages.js reads photos back off disk
 * to caption them, and that path is best-effort, so dropping the local write
 * would silently degrade captions rather than fail.
 *
 * opts.signUpload(fname) supplies the relay credential. It is injected rather
 * than imported so this module keeps its "no deps on db or express" promise.
 */
async function rehost(url, destRel, uploadDir, baseUrl, opts = {}) {
  const { uploadPublicBase, remoteUploadBase, signUpload, fetchFn = fetch } = opts;
  const safeUrl = await assertPublicHttpUrl(url);
  const resp = await fetch(safeUrl, { signal: AbortSignal.timeout(60000), redirect: "error" });
  if (!resp.ok) throw new Error(`fetch → ${resp.status}`);
  const buf = await readCapped(resp);

  const ext = String(destRel).split(".").pop().toLowerCase();
  const fname = `${crypto.randomUUID()}.${ext}`;
  const localPath = path.join(uploadDir, fname);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buf);

  if (remoteUploadBase) {
    const out = await relayUpload({
      fetch: fetchFn,
      base: remoteUploadBase,
      fname,
      req: { headers: signUpload ? { "x-upload-token": signUpload(fname) } : {} },
      body: buf,
      contentType: EXT_CONTENT_TYPE[ext],
    });
    // relayUpload never throws; a non-200 means the bytes are NOT on the remote,
    // so returning a remote URL would be a lie. Fail loudly instead.
    if (out.status !== 200) throw new Error(`rehost relay: ${out.body.error}`);
  }

  const publicBase = (remoteUploadBase && uploadPublicBase) || baseUrl;
  return { url: `${publicBase}/files/${fname}`, fname, localPath };
}

// ── upload content sniffing ──
// Verify the leading bytes of an upload match the extension the client claimed,
// so a ".png" that is really HTML/JS/an executable is rejected before it lands
// in the public /files store (defends #39 content-type confusion).
function sniffMatchesExt(buf, ext) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  const b = buf;
  const startsWith = (bytes) => bytes.every((v, i) => b[i] === v);
  switch (ext) {
    case "jpg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "png": return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "webp": return startsWith([0x52, 0x49, 0x46, 0x46]) && // "RIFF"
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // "WEBP"
    case "mp4": {
      // ISO-BMFF: bytes 4..8 are the 'ftyp' box type.
      return b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
    }
    case "woff2": return startsWith([0x77, 0x4f, 0x46, 0x32]); // "wOF2"
    case "woff": return startsWith([0x77, 0x4f, 0x46, 0x46]);  // "wOFF"
    case "ttf": return startsWith([0x00, 0x01, 0x00, 0x00]) || startsWith([0x74, 0x72, 0x75, 0x65]);
    case "otf": return startsWith([0x4f, 0x54, 0x54, 0x4f]); // "OTTO"
    default: return false;
  }
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

/*
 * Interactive buttons (Green API sendInteractiveButtons).
 * Limits enforced here rather than trusted from call sites: at most 3
 * buttons, button text ≤ 25 chars — Green API rejects the whole message
 * otherwise, and a rejected message is a lost notification.
 * Throws on a non-2xx so callers can fall back to a plain text send.
 */
async function sendWhatsAppButtons(phone, { header, body, footer, buttons }, instance, token) {
  if (!instance || !token) return;
  const clean = (buttons || []).slice(0, 3).map((b, i) => ({
    ...b,
    buttonId: String(b.buttonId || i + 1),
    buttonText: String(b.buttonText || "").slice(0, 25),
  }));
  const resp = await fetch(
    `https://api.green-api.com/waInstance${instance}/sendInteractiveButtons/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: `${phone}@c.us`,
        header: header || undefined,
        body: String(body || ""),
        footer: footer || undefined,
        buttons: clean,
      }),
      signal: AbortSignal.timeout(20000),
    });
  if (!resp.ok) {
    throw new Error(`sendInteractiveButtons ${resp.status}`);
  }
  return resp.json().catch(() => ({}));
}

module.exports = {
  pad, daysFromNow, asMillis, escapeHtml,
  sanitizeTheme, sanitizeLang, normalizePhone, normalizeAuthPhone,
  guessImageExt, rehost, sendWhatsApp, sendWhatsAppButtons,
  assertPublicHttpUrl, isPrivateIp, sniffMatchesExt, INFRA_HOST, resolvePageBaseUrl,
};
