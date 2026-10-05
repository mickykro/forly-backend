#!/usr/bin/env node
/*
 * whatsapp-daily-review.local.js — pull one day's WhatsApp conversations
 * straight from Green API and report where the bot is worth improving:
 * unnecessary model calls, misunderstood messages, and requests it left
 * unfulfilled.
 *
 * Read-only against Green API (getChats, getChatHistory) and Firestore
 * (businesses, to label a chat "agent" vs "lead"). Writes nothing, ever.
 *
 *   cd server && GOOGLE_APPLICATION_CREDENTIALS=... GREENAPI_INSTANCE=... GREENAPI_TOKEN=... \
 *     node ../scripts/whatsapp-daily-review.local.js [--date YYYY-MM-DD] [--count 200] [--analyze] [--model claude-sonnet-5]
 *
 *   --date     Calendar day to review, Asia/Jerusalem, YYYY-MM-DD. Default: yesterday.
 *   --count    Messages pulled per chat from getChatHistory before filtering down to
 *              the day (default 200, Green API's own max per call). A chat busier than
 *              this on the target day is reported TRUNCATED — its true count is a floor.
 *   --analyze  Also send the day's transcripts through an LLM review pass (costs money,
 *              needs the matching provider key — see server/chat-provider.js) to surface
 *              misunderstandings, repeated/redundant bot replies, and unmet requests.
 *              Without this flag the report is message counts only: free and fast, and
 *              often enough on its own to see whether a fuller review is worth running.
 *   --model    Model for --analyze (default claude-sonnet-5).
 *
 * Registered agents are answered by n8n's "Business Handler"; everyone else who
 * messages the Green API number is answered by "Lead Chat" — two different prompts,
 * two different failure modes. This script doesn't see which n8n flow answered a
 * chat, so it infers the same split from server/db.js: a chat whose phone has a
 * businesses/{phone} record is "agent", everything else is "lead".
 *
 * Phone numbers, names and message text below are real customer data pulled live
 * from Green API — this print-out is for whoever is authorized to see production
 * WhatsApp traffic, same as the Firebase console already shows them. --analyze
 * sends that same data to the model vendor, exactly as the live bot already does
 * for every message; nothing here is a new exposure. Obvious phone numbers and
 * emails are still redacted before that call, on principle.
 */
process.chdir(require("path").join(__dirname, "..", "server"));

const db = require("../server/db");
const chatProvider = require("../server/chat-provider");

const line = (s = "") => console.log(s);
const rule = (s) => line(`\n══ ${s} ${"═".repeat(Math.max(0, 62 - s.length))}`);

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const hasFlag = (flag) => process.argv.includes(flag);

// ── target day, Asia/Jerusalem (every agent and every lead is there) ──
function dayKey(unixSeconds, timeZone = "Asia/Jerusalem") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(unixSeconds * 1000));
}
function defaultYesterday() {
  const [y, m, d] = dayKey(Math.floor(Date.now() / 1000)).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
const TARGET_DAY = arg("--date", defaultYesterday());
const COUNT = Number(arg("--count", 200));
const ANALYZE = hasFlag("--analyze");
const MODEL = arg("--model", "claude-sonnet-5");

// ── Green API (read-only) ──
async function greenApi(instance, token, path, body) {
  const url = `https://api.green-api.com/waInstance${instance}/${path}/${token}`;
  const res = await fetch(url, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }
    : { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// The message shape has drifted across Green API versions — read every spot a
// text has actually shown up in rather than trusting one field name. (The
// button-reply fields are [Unverified] the same way the WhatsApp chat design
// doc flags them: never confirmed against a live payload.)
function textOf(m) {
  return m.textMessage ||
    (m.extendedTextMessageData && m.extendedTextMessageData.text) ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.fileMessageData && m.fileMessageData.caption) ||
    (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedButtonText) ||
    (m.interactiveButtonsReply && m.interactiveButtonsReply.selectedDisplayText) ||
    (m.listResponseMessage && m.listResponseMessage.title) || null;
}

function messagesForDay(history, day) {
  return (history || [])
    .filter((m) => m && Number.isFinite(m.timestamp) && dayKey(m.timestamp) === day)
    .sort((a, b) => a.timestamp - b.timestamp);
}

// Redact anything that could dial or email before any of it reaches a model.
function redact(s) {
  return String(s || "")
    .replace(/\+?\d[\d\s()-]{7,}\d/g, "[phone]")
    .replace(/\S+@\S+\.\S+/g, "[email]");
}

async function limitedMap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function transcriptLines(dayMsgs) {
  return dayMsgs.map((m) => {
    const t = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" }).format(new Date(m.timestamp * 1000));
    const who = m.type === "outgoing" ? "בוט" : "פנייה";
    const body = textOf(m);
    return `[${t}] ${who}: ${redact(body || `(${m.typeMessage || "media"})`)}`;
  });
}

// ── the LLM review pass (--analyze only) ──
const ANALYZE_SYSTEM = `You audit WhatsApp support-bot transcripts for Forly, a real-estate SaaS.
Two agents answer these chats: one helps registered real-estate agents build property
pages (photos, listing text, links → a page), the other pitches the product to people
who are not yet customers. You are shown one day's transcripts, each labeled "agent" or
"lead". Find concrete, evidence-backed problems only — do not speculate beyond what the
transcript shows.
Return ONLY a JSON object with these keys:
{
  "misunderstandings": [{"chat": "<label>", "quote": "<the message>", "issue": "<what the bot got wrong>"}],
  "redundant_generation": [{"chat": "<label>", "issue": "<a message that cost a model call and clearly didn't need to, or the same generation paid for twice>"}],
  "unmet_requests": [{"request": "<what people keep asking for>", "count": <how many chats it appeared in>, "example": "<one quote>"}],
  "summary": "<3-5 sentences: the single highest-value fix for today's data>"
}
Omit an array entry only if you have nothing real to put in it — an empty array is a
fine and honest answer. Never invent an example that isn't in the transcripts.`;

const MAX_ANALYZE_CHARS = 100000;
const CHUNK_CHARS = 15000;

function chunk(blocks) {
  const chunks = [];
  let cur = [], len = 0;
  for (const b of blocks) {
    if (len + b.length > CHUNK_CHARS && cur.length) { chunks.push(cur); cur = []; len = 0; }
    cur.push(b); len += b.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function parseJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function analyze(chatBlocks, keys) {
  let total = 0;
  const kept = [];
  for (const b of chatBlocks) {
    if (total + b.length > MAX_ANALYZE_CHARS) break;
    kept.push(b); total += b.length;
  }
  const truncated = kept.length < chatBlocks.length;
  const chunks = chunk(kept);
  const merged = { misunderstandings: [], redundant_generation: [], unmet_requests: [], summary: [] };
  for (const [i, c] of chunks.entries()) {
    line(`  analyzing batch ${i + 1}/${chunks.length}…`);
    let r;
    try {
      r = await chatProvider.ask(MODEL, ANALYZE_SYSTEM, [{ role: "user", content: c.join("\n\n") }], keys, { schema: null, maxOut: 1500 });
    } catch (err) { line(`  ⚠ batch ${i + 1} failed: ${err.message}`); continue; }
    const parsed = parseJson(r.text);
    if (!parsed) { line(`  ⚠ batch ${i + 1} returned unparsable output`); continue; }
    for (const k of ["misunderstandings", "redundant_generation", "unmet_requests"]) {
      if (Array.isArray(parsed[k])) merged[k].push(...parsed[k]);
    }
    if (parsed.summary) merged.summary.push(String(parsed.summary));
  }
  return { ...merged, truncated };
}

(async () => {
  db.init();
  line("whatsapp daily review — read-only");
  line(`day: ${TARGET_DAY} (Asia/Jerusalem)  ·  history depth: ${COUNT}/chat  ·  analyze: ${ANALYZE ? MODEL : "off"}`);
  if (!db.db) {
    line("");
    line("✗ Refusing to run against the in-memory fallback: every business would read as");
    line("  unregistered and every chat would be labeled \"lead\". Set GOOGLE_APPLICATION_CREDENTIALS.");
    process.exit(2);
  }
  const instance = process.env.GREENAPI_INSTANCE;
  const token = process.env.GREENAPI_TOKEN;
  if (!instance || !token) {
    line("");
    line("✗ GREENAPI_INSTANCE / GREENAPI_TOKEN not set — nothing to pull.");
    process.exit(2);
  }
  const keys = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  if (ANALYZE && !keys[chatProvider.envKeyFor(MODEL)]) {
    line("");
    line(`✗ --analyze needs ${chatProvider.envKeyFor(MODEL)} set for model ${MODEL}.`);
    process.exit(2);
  }

  const businesses = await db.listAllBusinesses(1000).catch(() => []);
  const agentPhones = new Set(businesses.map((b) => b.phone).filter(Boolean));

  rule("chats");
  const chats = (await greenApi(instance, token, "getChats").catch((err) => { line(`✗ getChats failed: ${err.message}`); return null; })) || [];
  const individual = chats.filter((c) => typeof c.id === "string" && c.id.endsWith("@c.us"));
  line(`  ${chats.length} chats on the instance, ${individual.length} one-to-one (groups excluded)`);

  const results = await limitedMap(individual, 5, async (c) => {
    const phone = c.id.split("@")[0];
    let history;
    try { history = await greenApi(instance, token, "getChatHistory", { chatId: c.id, count: COUNT }); }
    catch (err) { return { chatId: c.id, phone, error: err.message }; }
    const dayMsgs = messagesForDay(history, TARGET_DAY);
    if (!dayMsgs.length) return null;
    const inbound = dayMsgs.filter((m) => m.type !== "outgoing").length;
    const outbound = dayMsgs.length - inbound;
    return {
      chatId: c.id, phone, name: c.name || phone,
      kind: agentPhones.has(phone) ? "agent" : "lead",
      count: dayMsgs.length, inbound, outbound,
      truncated: history.length >= COUNT && dayMsgs.length >= COUNT,
      lines: transcriptLines(dayMsgs),
    };
  });

  const active = results.filter(Boolean);
  const errors = active.filter((r) => r.error);
  const withMsgs = active.filter((r) => !r.error).sort((a, b) => b.count - a.count);

  rule(`activity on ${TARGET_DAY}`);
  if (errors.length) line(`  ⚠ ${errors.length} chat(s) failed to fetch: ${errors.slice(0, 5).map((e) => e.phone).join(", ")}${errors.length > 5 ? "…" : ""}`);
  if (!withMsgs.length) { line("  no messages on this day"); process.exit(0); }

  const totalMsgs = withMsgs.reduce((n, r) => n + r.count, 0);
  const totalIn = withMsgs.reduce((n, r) => n + r.inbound, 0);
  const totalOut = withMsgs.reduce((n, r) => n + r.outbound, 0);
  const agentChats = withMsgs.filter((r) => r.kind === "agent");
  const leadChats = withMsgs.filter((r) => r.kind === "lead");
  const truncatedChats = withMsgs.filter((r) => r.truncated);

  line(`  ${withMsgs.length} chats active  ·  ${totalMsgs} messages (${totalIn} in / ${totalOut} out)`);
  line(`  ${agentChats.length} registered-agent chats  ·  ${leadChats.length} lead chats`);
  if (truncatedChats.length) {
    line(`  ⚠ ${truncatedChats.length} chat(s) hit the --count=${COUNT} cap — their true volume is a FLOOR, re-run with a higher --count for them:`);
    for (const r of truncatedChats.slice(0, 10)) line(`     ${r.name} (${r.phone})`);
  }

  rule("busiest chats");
  for (const r of withMsgs.slice(0, 15)) {
    line(`  ${String(r.count).padStart(4)} msgs (${r.inbound} in / ${r.outbound} out)  [${r.kind}]  ${r.name}${r.truncated ? "  ⚠ truncated" : ""}`);
  }

  if (!ANALYZE) {
    rule("next step");
    line("  Re-run with --analyze to review what was actually said (misunderstandings,");
    line("  redundant generations, requests the bot couldn't fulfil) — this pass alone is");
    line("  counts only, so it can't tell you why a chat has a spike, just that it does.");
    process.exit(0);
  }

  rule("analysis");
  const blocks = withMsgs.map((r) => `=== [${r.kind}] ${r.name} (${r.count} msgs) ===\n${r.lines.join("\n")}`);
  const report = await analyze(blocks, keys);

  rule("misunderstandings");
  if (!report.misunderstandings.length) line("  none found");
  for (const m of report.misunderstandings) line(`  • [${m.chat}] "${m.quote}"\n      → ${m.issue}`);

  rule("unnecessary generations");
  if (!report.redundant_generation.length) line("  none found");
  for (const r of report.redundant_generation) line(`  • [${r.chat}] ${r.issue}`);

  rule("requests the bot could not fulfil");
  if (!report.unmet_requests.length) line("  none found");
  for (const u of report.unmet_requests.sort((a, b) => (b.count || 0) - (a.count || 0))) {
    line(`  • (${u.count || "?"}×) ${u.request}\n      e.g. "${u.example}"`);
  }

  rule("summary");
  line(report.summary.length ? report.summary.join("\n") : "  (no batch returned a usable summary)");
  if (report.truncated) line("\n  ⚠ MAX_ANALYZE_CHARS cap reached — not every chat's transcript was reviewed.");

  line("\nNothing was modified.");
})().catch((e) => { console.error("review failed:", e); process.exit(1); });
