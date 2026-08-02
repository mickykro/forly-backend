/*
 * business-cache.js — short-lived cache over db.getBusiness.
 *
 * Every landing-page render now needs the owning business document to decide
 * whether the chat bot is on (see chatbot-config.js). That is one extra
 * Firestore read per page view, on a read that changes maybe twice a year, so
 * it is cached for a minute.
 *
 * The entitlement is resolved live rather than denormalised onto the page doc
 * precisely so that flipping an agent's flag reaches their whole back
 * catalogue at once — caching it for a minute would reintroduce exactly the
 * staleness that was being avoided, so the admin write calls invalidate() and
 * the change takes effect on the next request.
 *
 * Deliberately in-process: the server is a single container, and a shared cache
 * would be far more machinery than one Firestore read per minute is worth.
 */
const db = require("./db");

const TTL_MS = 60 * 1000;
const cache = new Map();   // phone → { at, value }

async function get(phone) {
  if (!phone) return null;
  const hit = cache.get(phone);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    value = await db.getBusiness(phone);
  } catch (err) {
    // A page must still render if the business lookup fails; the bot just
    // resolves to off, which is the safe direction.
    console.warn(`business-cache: getBusiness(${phone}) failed:`, err.message);
    return hit ? hit.value : null;
  }
  cache.set(phone, { at: Date.now(), value });
  return value;
}

/** Call after any write to a business doc so the next render sees it. */
function invalidate(phone) {
  if (phone) cache.delete(phone);
}

function clear() {
  cache.clear();
}

module.exports = { get, invalidate, clear, TTL_MS };
