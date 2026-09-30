/*
 * currency.js — the agent's display currency (businesses/{phone}.currency).
 *
 * Prices stay plain numbers everywhere; this only decides the symbol shown on
 * the agent's pages, portfolio and WhatsApp replies. It is an agent-level
 * setting, resolved live (like the chat bot entitlement), so changing it from
 * the chat ("מטבע דולר") reaches every page the agent already has.
 */
const DEFAULT = "ILS";
const CURRENCIES = {
  ILS: { symbol: "₪", name: "שקל", words: ["ils", "nis", "shekel", "shekels", "שקל", "שקלים", "ש״ח", "ש\"ח", "ש'ח", "₪"] },
  USD: { symbol: "$", name: "דולר", words: ["usd", "dollar", "dollars", "דולר", "דולרים", "$"] },
  EUR: { symbol: "€", name: "יורו", words: ["eur", "euro", "euros", "יורו", "€"] },
};

const valid = (code) => Object.prototype.hasOwnProperty.call(CURRENCIES, code);
const codeOf = (business) => (business && valid(business.currency) ? business.currency : DEFAULT);
const symbolOf = (code) => (valid(code) ? CURRENCIES[code] : CURRENCIES[DEFAULT]).symbol;
const nameOf = (code) => (valid(code) ? CURRENCIES[code] : CURRENCIES[DEFAULT]).name;

// "דולר", "USD", "לדולר", "ליורו" → a code; anything else → null.
function parse(text) {
  const s = String(text || "").trim().toLowerCase().replace(/[.!?]+$/, "").trim();
  if (!s) return null;
  const find = (w) => Object.keys(CURRENCIES).find((c) => c.toLowerCase() === w || CURRENCIES[c].words.includes(w)) || null;
  return find(s) || (/^[לה]/.test(s) ? find(s.slice(1)) : null);
}

// "מטבע", "מטבע דולר", "שנה מטבע ליורו", "/מטבע usd", "currency eur".
// Only an explicit "מטבע"/"currency" counts, so a bare "דולר" typed as an
// answer to the draft's price question is never taken for a setting change.
const COMMAND = /^\s*\/?(?:(?:שנה|שני|תשנה|תשני|החלף|תחליף|תחליפי|לשנות|להחליף|change)\s+(?:את\s+)?(?:the\s+)?)?(?:ה?מטבע|currency)(?:\s+(?:to\s+)?(.*?))?\s*$/i;
function commandOf(text) {
  const m = COMMAND.exec(String(text || ""));
  if (!m) return null;
  const arg = (m[1] || "").trim();
  return { arg, code: arg ? parse(arg) : null };
}

// Text written with ₪ (the chat's replies) shown in the agent's currency.
function localize(text, code) {
  if (typeof text !== "string" || !valid(code) || code === DEFAULT) return text;
  return text.replace(/₪/g, CURRENCIES[code].symbol);
}

module.exports = { DEFAULT, CURRENCIES, codeOf, symbolOf, nameOf, parse, commandOf, localize };
