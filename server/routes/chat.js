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

const API_URL = "https://api.anthropic.com/v1/messages";
const API_TIMEOUT_MS = 20000;
const MAX_TURNS_KEPT = 60;     // stored history cap (phase 3 sends this to the agent)
const MAX_TURNS_SENT = 20;     // how much of it is replayed to the model

const nowDay = () => new Date().toISOString().slice(0, 10);
const nowMonth = () => new Date().toISOString().slice(0, 7);

module.exports = function createChatRouter(ctx) {
  const { anthropicKey, ipSalt } = ctx;
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

  async function agentMonthCount(phone) {
    const store = db.db;
    if (!store || !phone) return 0;
    try {
      const d = await store.collection("businesses").doc(phone)
        .collection("quota").doc("current").get();
      if (!d.exists || d.get("chat_msgs_month_key") !== nowMonth()) return 0;
      return d.get("chat_msgs_month") || 0;
    } catch { return 0; }
  }

  async function countMessage(pageId, phone) {
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

  async function askClaude(system, history, model) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0,
        system,
        messages: history,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.content || []).map((b) => b.text || "").join("");
  }

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
    if (!anthropicKey) {
      console.error("chat: ANTHROPIC_API_KEY is not set");
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
        lead: { captured: false }, ip_hash: ipHash, status: "open",
      };
    }
    if (convo.message_count >= lim.max_msgs_per_convo) {
      return res.json({ conversation_id: cid, state: "closed", reply: capReply(page) });
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

    let parsed = null;
    try {
      parsed = prompt.parseModelReply(await askClaude(system, history, cfg.model));
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
    if (!answered && parsed && !convo.handoff.triggered) {
      convo.handoff = { triggered: true, at, question: parsed.unanswered_question || message };
      convo.status = "handoff_pending";
    }

    await saveConversation(pageId, cid, convo);
    await countMessage(pageId, page.business_phone);

    res.json({
      conversation_id: cid,
      reply,
      // Phase 3 turns "handoff" into name+phone capture and a WhatsApp to the
      // agent. For now the widget points the visitor at the existing form.
      state: answered ? "answering" : "handoff",
    });
  });

  return router;
};

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
