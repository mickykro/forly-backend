/*
 * chat-recover.js — a page asked for in the chat, with no draft behind it.
 *
 * The agent sent the ad and had photos edited, but those messages were never
 * claimed (sent before this code, or the n8n bot talked it through). Now an
 * unclaimed message like "כן תיצרי דף נכס" / "תעשי איך שנראה לך" comes in.
 * Look at the last 3 h of the chat: only when it holds an ad or photos is the
 * message classified, with the conversation as context. If it asks for a page,
 * open a draft from the latest ad and offer the latest edited photos
 * (draft.offered_photos, asked at the photos step).
 */
const D = require("./property-draft");
const R = require("./whatsapp-replies");

const WINDOW_S = 3 * 60 * 60;
const textOf = (m) => m.textMessage || (m.extendedTextMessage || {}).text || m.caption || "";

// Newest first, 3 h: [{ who: "agent" | "bot", text, image }]
function readChat(history, nowS) {
  return history.filter((m) => nowS - m.timestamp < WINDOW_S).map((m) => ({
    who: m.type === "incoming" ? "agent" : "bot",
    text: textOf(m),
    image: m.typeMessage === "imageMessage" && /^https:\/\//.test(m.downloadUrl || "") ? m.downloadUrl : null,
  }));
}

// The latest batch of photos: the bot's edits of it if any, else the agent's own.
function latestPhotos(chat) {
  const edited = [];
  for (const m of chat) { if (m.who === "agent" && m.image) break; if (m.who === "bot" && m.image) edited.push(m.image); }
  if (edited.length) return edited.reverse().slice(0, 12);
  const own = [];
  for (const m of chat) { if (m.who === "agent" && m.image) own.push(m.image); else if (own.length) break; }
  return own.reverse().slice(0, 54); // whatsapp-intake MAX_PHOTOS (bot edits above stay ≤12, photo-choice.js)
}

async function recoverFromChat(phone, text, deps, now, openDraft) {
  const t = String(text || "").trim();
  if (!deps.recentChat || !deps.classifyIntent || t.split(/\s+/).length < 2) return null;
  let chat;
  try { chat = readChat(await deps.recentChat(phone), Math.floor(now.getTime() / 1000)); } catch (err) { return null; }
  const ad = chat.find((m) => m.who === "agent" && D.openerKind(m.text) === "text");
  const photos = latestPhotos(chat);
  if (!ad && !photos.length) return null; // nothing to build from: no LLM call
  const context = chat.slice(0, 14).reverse().map((m) => `${m.who === "agent" ? "Agent" : "Forly"}: ${m.image ? "[photo]" : m.text.slice(0, 300)}`).join("\n");
  let intent = null;
  try { intent = await deps.classifyIntent(t, context); } catch (err) { return null; }
  if (intent !== "new") return null;
  const opened = await openDraft(phone, ad ? "text" : "keyword", ad ? ad.text : t, deps, now);
  if (!opened.draft) return opened;
  if (photos.length) {
    const settled = await Promise.allSettled(photos.map((u) => deps.importPhoto(u)));
    const hosted = settled.filter((s) => s.status === "fulfilled" && s.value).map((s) => s.value);
    if (hosted.length && !opened.draft.photos.length) opened.draft.offered_photos = hosted;
  }
  // Ask the offered photos now if the fields are already complete (else at the photos step).
  const replies = [R.recovered(!!ad, (opened.draft.offered_photos || []).length), ...opened.replies];
  return { ...opened, status: `recovered:${opened.status}`, replies: [R.oneBubble(replies)] };
}

module.exports = { recoverFromChat, readChat, latestPhotos };
