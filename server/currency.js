/*
 * currency.js — a property's price currency. Prices are stored as the number
 * the agent gave, in the currency they gave it; nothing is converted.
 * A missing currency means ILS (every page created before this field existed).
 */
const CURRENCIES = ["ILS", "EUR", "USD"];
const SYMBOLS = { ILS: "₪", EUR: "€", USD: "$" };

// Which currency a piece of text names, if any. When shekels and another currency both
// appear, the other one wins: "לא בשקלים, ביורו" is how agents correct it, while an
// Israeli listing rarely mentions euros or dollars in passing.
const MARKERS = [
  ["EUR", /€|יורו|אירו|\beur\b|\beuros?\b/i],
  ["USD", /\$|דולר|\busd\b|\bdollars?\b/i],
  ["ILS", /₪|ש["״']ח|שקל|\bnis\b|\bils\b/i],
];
function detectCurrency(text) {
  const s = String(text || "");
  const hit = MARKERS.find(([, re]) => re.test(s));
  return hit ? hit[0] : null;
}

function normalizeCurrency(v) { return CURRENCIES.includes(v) ? v : null; }
function symbol(cur) { return SYMBOLS[cur] || SYMBOLS.ILS; }

module.exports = { CURRENCIES, SYMBOLS, detectCurrency, normalizeCurrency, symbol };
