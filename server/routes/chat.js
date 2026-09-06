/*
 * routes/chat.js — the landing-page chat bot.
 *
 *   POST /api/chat  { page_id, conversation_id?, message } → { conversation_id, reply, state }
 *
 * Public and unauthenticated by nature — it answers anonymous visitors — which
 * makes it the only LLM-backed endpoint in the product that anyone on the
 * internet can call. Every limit below is load-bearing, not defensive polish.
 *
 * Entitlement is re-resolved here on every call. The flag on the page payload
 * is presentation only; a visitor can trivially forge it.
 */
const express = require("express");
const crypto = require("crypto");

const db = require("../db");
const chatbotConfig = require("../chatbot-config");
const businessCache = require("../business-cache");
const prompt = require("../chat-prompt");
const chatProvider = require("../chat-provider");
const { submitLead } = require("../leads");
const { normalizePhone, sendWhatsApp, asMillis } = require("../utils");

const MAX_TURNS_KEPT = 60;     // stored history cap (phase 3 sends this to the agent)
const MAX_TURNS_SENT = 20;     // how much of it is replayed to the model

const nowDay = () => new Date().toISOString().slice(0, 10);
const nowMonth = () => new Date().toISOString().slice(0, 7);

module.exports = function createChatRouter(ctx) {
  const { apiKeys, ipSalt, greenInstance, greenToken, quota } = ctx;
  const router = express.Router();

  const hashIp = (ip) =>
    crypto.createHmac("sha256", ipSalt || "forly-chat").update(String(ip || "")).digest("hex").slice(0, 32);

  // ── per-IP throttle, same transaction shape as the lead throttle ──
  // Over-limit is answered politely rather than with a 429: a visitor who has
  // hit a cap is still a prospect, and an error bubble reads as a broken site.
  async function ipAllowed(ipHash, perHour) {
    const store = db.db;
    if (!store) return true;                 // no Firestore locally ⇒ don't block dev
    const ref = store.collection("chat_throttle").doc(ipHash);
    try {
      return await store.runTransaction(async (tx) => {
        const t = await tx.get(ref);
        const now = Date.now();
        const windowStart = t.exists ? (t.get("window_start") || 0) : 0;
        const count = t.exists && now - windowStart < 3600000 ? (t.get("count") || 0) : 0;
        if (count >= perHour) return false;
        tx.set(ref, { window_start: count === 0 ? now : windowStart, count: count + 1 });
        return true;
      });
    } catch (err) {
      console.warn("chat throttle failed (allowing):", err.message);
      return true;
    }
  }

  async function pageDayCount(pageId) {
    const store = db.db;
    if (!store) return 0;
    try {
      const d = await store.collection("property_pages").doc(pageId)
        .collection("metrics").doc(nowDay()).get();
      return d.exists ? (d.get("chat_msg") || 0) : 0;
    } catch { return 0; }
  }

  // Fails CLOSED, unlike pageDayCount: a Firestore outage must not silently
  // remove the one cap that bounds total spend across a whole agent's traffic.
  async function agentMonthCount(phone) {
    const store = db.db;
    if (!store || !phone) return 0;
    try {
      const d = await store.collection("businesses").doc(phone)
        .collection("quota").doc("current").get();
      if (!d.exists || d.get("chat_msgs_month_key") !== nowMonth()) return 0;
      return d.get("chat_msgs_month") || 0;
    } catch (err) {
      console.warn("agentMonthCount failed (denying):", err.message);
      return Infinity;
    }
  }

  // tokens: {in,out} from the provider envelope. Monthly caps count messages,
  // not tokens, so a long conversation on a data-rich page can cost many times
  // a short one without tripping any limit — this at least makes it visible.
  async function countMessage(pageId, phone, tokens) {
    const store = db.db;
    if (!store) return;
    const FieldValue = require("firebase-admin").firestore.FieldValue;
    const jobs = [
      store.collection("property_pages").doc(pageId).collection("metrics").doc(nowDay())
        .set({ chat_msg: FieldValue.increment(1) }, { merge: true }),
    ];
    if (phone) {
      const q = store.collection("businesses").doc(phone).collection("quota").doc("current");
      jobs.push(store.runTransaction(async (tx) => {
        const d = await tx.get(q);
        const fresh = !d.exists || d.get("chat_msgs_month_key") !== nowMonth();
        tx.set(q, {
          chat_msgs_month_key: nowMonth(),
          chat_msgs_month: fresh ? 1 : (d.get("chat_msgs_month") || 0) + 1,
          chat_tokens_in: fresh ? (tokens && tokens.in) || 0 : (d.get("chat_tokens_in") || 0) + ((tokens && tokens.in) || 0),
          chat_tokens_out: fresh ? (tokens && tokens.out) || 0 : (d.get("chat_tokens_out") || 0) + ((tokens && tokens.out) || 0),
        }, { merge: true });
      }));
    }
    await Promise.all(jobs).catch((err) => console.warn("chat counters failed:", err.message));
  }

  // ── conversation storage: property_pages/{id}/chats/{cid} ──
  async function loadConversation(pageId, cid) {
    const store = db.db;
    if (!store || !cid) return null;
    try {
      const d = await store.collection("property_pages").doc(pageId)
        .collection("chats").doc(cid).get();
      return d.exists ? d.data() : null;
    } catch { return null; }
  }

  async function saveConversation(pageId, cid, convo) {
    const store = db.db;
    if (!store) return;
    try {
      await store.collection("property_pages").doc(pageId)
        .collection("chats").doc(cid).set(convo, { merge: true });
    } catch (err) {
      console.warn("chat save failed:", err.message);
    }
  }

  // The vendor follows the model id (see chat-provider.js), so a page set to
  // "gemini-2.5-flash" goes to Google and one set to "claude-sonnet-5" goes to
  // Anthropic — without this route knowing which is which.
  // Returns the full provider envelope {text,in,out} — callers must pull
  // .text before handing it to parseModelReply, which takes a string; handing
  // it the object stringifies to "[object Object]" and silently disables the
  // handoff on every message.
  const askModel = async (system, history, model) =>
    chatProvider.ask(model, system, history, apiKeys);

  router.post("/api/chat", async (req, res) => {
    const body = req.body || {};
    const pageId = String(body.page_id || "");
    const message = String(body.message || "").trim();
    if (!pageId || !message) return res.status(400).json({ error: "invalid_input" });

    const page = await db.getPage(pageId).catch(() => null);
    if (!page) return res.status(404).json({ error: "not_found" });
    if (page.status !== "active" && page.status !== "expiring") {
      return res.status(410).json({ error: "page_inactive" });
    }

    // The client-side flag is presentation only — this is the real gate.
    const biz = await businessCache.get(page.business_phone);
    const cfg = chatbotConfig.resolve(page, biz, process.env);
    if (!cfg.enabled) return res.status(403).json({ error: "chatbot_disabled" });
    const needKey = chatProvider.envKeyFor(cfg.model);
    if (!apiKeys[needKey]) {
      console.error(`chat: ${needKey} is not set (model ${cfg.model})`);
      return res.status(503).json({ error: "unavailable" });
    }

    const lim = cfg.limits;
    if (message.length > lim.max_chars_per_msg) {
      return res.status(400).json({ error: "message_too_long" });
    }

    const ipHash = hashIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
    if (!(await ipAllowed(ipHash, lim.max_msgs_per_ip_hour))) {
      return res.json({ state: "closed", reply: capReply(page) });
    }
    if (await pageDayCount(pageId) >= lim.max_msgs_per_page_day) {
      return res.json({ state: "closed", reply: capReply(page) });
    }
    if (await agentMonthCount(page.business_phone) >= lim.max_msgs_per_agent_month) {
      return res.json({ state: "closed", reply: capReply(page) });
    }

    // ── conversation ──
    let cid = String(body.conversation_id || "").slice(0, 64);
    let convo = cid ? await loadConversation(pageId, cid) : null;
    if (!convo) {
      cid = crypto.randomUUID();
      convo = {
        conversation_id: cid, page_id: pageId, listing_id: page.listing_id || null,
        business_phone: page.business_phone || null,
        mode: "immediate", variant: "immediate",
        started_at: new Date(), history: [], message_count: 0,
        handoff: { triggered: false, at: null, question: null },
        unanswered: [], lead: { captured: false }, post_handoff_count: 0,
        ip_hash: ipHash, status: "open",
      };
    }
    // Defend every read on a possibly-truncated doc — one missing field must not
    // 500 the whole handler.
    convo.handoff = convo.handoff || { triggered: false, at: null, question: null };
    convo.lead = convo.lead || { captured: false };
    if (convo.message_count >= lim.max_msgs_per_convo) {
      return res.json({ conversation_id: cid, state: "closed", reply: capReply(page) });
    }

    // ── the tail after a lead is captured: answer a few more, then close ──
    // Fixed line, no model call — it costs nothing and can't hallucinate a
    // promise. Anchored to lead capture: if no lead, no agent is coming.
    const postCount = convo.post_handoff_count || 0;
    if (convo.lead.captured && postCount >= lim.max_msgs_after_handoff) {
      return res.json({ conversation_id: cid, state: "closed", reply: closingReply(page) });
    }

    const history = (convo.history || []).map((t) => ({
      role: t.role === "bot" ? "assistant" : "user",
      content: t.text,
    })).slice(-MAX_TURNS_SENT);
    history.push({ role: "user", content: message });

    const listing = page.listing_id ?
      await db.getListing(page.listing_id).catch(() => null) : null;
    const agentName = (page.agent && (page.agent.name || page.agent.brand_name)) || "המתווך";
    const system = prompt.buildSystemPrompt(prompt.buildFacts(page, listing), {
      language: page.language || "he",
      agentName,
      modeBlock: prompt.MODE_BLOCKS.immediate(agentName),
    });

    // Paid bundle (admin-set chat_msgs_cap on the agent's quota ledger). Atomic
    // check-and-reserve; an unset cap never blocks. The visitor just sees the
    // bot close politely — the agent (who pays) is what the operator alert and
    // the saved request are for.
    if (quota) {
      const q = await quota.consume(page.business_phone, "chat_msgs", 1, {
        source: "web_chat", business: biz,
        request: { page_id: pageId, message: message.slice(0, 300) },
      }).catch((err) => { console.warn("chat quota consume failed (allowing):", err.message); return { ok: true }; });
      if (!q.ok) return res.json({ conversation_id: cid, state: "closed", reply: capReply(page) });
    }

    let parsed = null;
    let tokens = { in: 0, out: 0 };
    try {
      const envelope = await askModel(system, history, cfg.model);
      tokens = { in: envelope.in || 0, out: envelope.out || 0 };
      parsed = prompt.parseModelReply(envelope.text);
    } catch (err) {
      console.error("chat: model call failed:", err.message);
      return res.status(502).json({ error: "model_unavailable" });
    }

    // Unparsable output is NOT a handoff. A false "hot lead" costs the agent
    // more trust than a missed one, so this path stays deliberately inert.
    const answered = parsed ? parsed.answered : true;
    const reply = parsed ? parsed.reply : softFallback(page);
    if (!parsed) console.warn(`chat: unparsable model reply page=${pageId}`);

    const at = new Date();
    convo.history = (convo.history || [])
      .concat([{ role: "user", text: message, at }, { role: "bot", text: reply, at }])
      .slice(-MAX_TURNS_KEPT);
    convo.message_count = (convo.message_count || 0) + 1;
    convo.last_at = at;
    if (convo.lead.captured) convo.post_handoff_count = postCount + 1;
    if (!answered && parsed) {
      // Every unanswered question, not just the first — the handoff message lists
      // them all. Capped so a hostile visitor can't grow the doc unbounded.
      convo.unanswered = (convo.unanswered || [])
        .concat([parsed.unanswered_question || message]).slice(-10);
      if (!convo.handoff.triggered) {
        // "triggered" now means the form has been offered; lead.captured means
        // the agent has actually been told.
        convo.handoff = { triggered: true, at, question: parsed.unanswered_question || message };
        convo.status = "handoff_pending";
      }
    }

    await saveConversation(pageId, cid, convo);
    await countMessage(pageId, page.business_phone, tokens);

    res.json({
      conversation_id: cid,
      reply,
      // Phase 3 turns "handoff" into name+phone capture and a WhatsApp to the
      // agent. For now the widget points the visitor at the existing form.
      state: answered ? "answering" : "handoff",
    });
  });

  // ── POST /api/chat/handoff — the warm lead: name + phone → agent WhatsApp ──
  //   { page_id, conversation_id, name, phone } → { ok: true }
  router.post("/api/chat/handoff", async (req, res) => {
    const body = req.body || {};
    const pageId = String(body.page_id || "");
    const cid = String(body.conversation_id || "").slice(0, 64);
    const name = String(body.name || "").trim().slice(0, 60);
    const prospectPhone = normalizePhone(body.phone || "");
    if (!pageId || !cid) return res.status(400).json({ error: "invalid_input" });
    if (name.length < 2) return res.status(400).json({ error: "invalid_name" });
    if (!prospectPhone) return res.status(400).json({ error: "invalid_phone" });

    const page = await db.getPage(pageId).catch(() => null);
    if (!page) return res.status(404).json({ error: "not_found" });
    if (page.status !== "active" && page.status !== "expiring") {
      return res.status(410).json({ error: "page_inactive" });
    }

    // Never trust the client's gate — re-resolve server-side.
    const biz = await businessCache.get(page.business_phone);
    const cfg = chatbotConfig.resolve(page, biz, process.env);
    if (!cfg.enabled) return res.status(403).json({ error: "chatbot_disabled" });

    const convo = await loadConversation(pageId, cid);
    if (!convo || convo.page_id !== pageId) return res.status(404).json({ error: "not_found" });
    // Idempotent for a double-tap, not for the rest of the conversation: the
    // same number resubmitting within the window is the retry we want to
    // swallow, while a later handoff — a second question, a different person on
    // the same device — is a real lead the agent must still hear about.
    // ponytail: a time+phone window, not a per-conversation latch.
    const DEDUPE_MS = 10 * 60 * 1000;
    const prev = convo.lead;
    if (prev && prev.captured && prev.phone === prospectPhone &&
        Date.now() - asMillis(prev.at) < DEDUPE_MS) {
      return res.json({ ok: true });
    }

    // Per-IP throttle (same store as /api/chat). The per-convo lead.captured
    // guard already stops repeat submits on one conversation.
    const ipHash = hashIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
    if (!(await ipAllowed(ipHash, cfg.limits.max_msgs_per_ip_hour))) {
      return res.status(429).json({ error: "rate_limited" });
    }

    const questions = (convo.unanswered || []).filter(Boolean);

    // Lead saved BEFORE the send — a Green API outage must never lose it.
    try {
      await submitLead({ page, name, phone: prospectPhone, source: "chat", questions });
    } catch (err) {
      console.error("chat submitLead failed:", err.message);
      return res.status(500).json({ error: "internal" });
    }

    const title = (page.property && page.property.address) || "";
    const city = (page.property && page.property.city) || "";
    const msg =
      `🔔 ליד חדש מדף הנכס "${title}, ${city}"\n👤 ${name}\n📞 0${prospectPhone.slice(3)}\n` +
      (questions.length ? "❓ שאלות שלא נענו:\n" + questions.map((q) => `• ${q}`).join("\n") + "\n" : "") +
      `דברו איתו עכשיו: https://wa.me/${prospectPhone}`;
    sendWhatsApp(page.business_phone, msg, greenInstance, greenToken)
      .catch((e) => console.error("chat lead notify failed:", e.message));

    const at = new Date();
    convo.lead = { captured: true, at, name, phone: prospectPhone };
    convo.status = "lead_captured";
    convo.post_handoff_count = 0;
    await saveConversation(pageId, cid, convo);

    res.json({ ok: true });
  });

  return router;
};

// The closing line after the post-lead tail runs out. Never promises anything
// the facts don't support — just that the details were passed on.
function closingReply(page) {
  const agent = (page.agent && (page.agent.name || page.agent.brand_name)) || "המתווך";
  return (page.language || "he") === "he" ?
    `שמחתי לעזור! העברתי את הפרטים ל${agent} והוא יחזור אליכם עם התשובות.` :
    `Glad I could help! I've passed your details to ${agent}, who'll get back to you.`;
}

// Hebrew-first, but a page in another language should not get a Hebrew wall.
function capReply(page) {
  return (page.language || "he") === "he" ?
    "מצטער, אני לא זמין כרגע. השאירו פרטים בטופס בתחתית הדף ונחזור אליכם 🙏" :
    "Sorry, I'm not available right now. Leave your details in the form below and we'll get back to you.";
}
function softFallback(page) {
  return (page.language || "he") === "he" ?
    "רגע, לא הצלחתי לנסח תשובה. אפשר לנסות לשאול שוב?" :
    "Sorry, I couldn't put that together. Could you ask again?";
}
