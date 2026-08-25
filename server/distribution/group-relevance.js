/*
 * Explainable relevance scoring for an agent's own Facebook Group list.
 *
 * This is deliberately a recommendation, not a claim about Group rules. A
 * positive score means the NAME suggests property marketing may fit; the agent
 * still controls enabled/relevant flags and remains responsible for each
 * Group's rules.
 */

const PROPERTY_TERMS = [
  "נדלן", "נדל\"ן", "דירה", "דירות", "נכס", "נכסים", "השכרה", "להשכרה",
  "תיווך", "מתווך", "דיור", "משכנתא", "משרדים", "מסחרי",
  "real estate", "realestate", "property", "properties", "apartment", "apartments",
  "rental", "rent", "housing", "realtor", "broker", "mortgage",
];

const LOCAL_MARKET_TERMS = [
  "יד2", "יד 2", "לוח מודעות", "קניה ומכירה", "קנייה ומכירה", "buy sell",
  "buy & sell", "classifieds", "marketplace",
];

const ISRAEL_LOCATION_TERMS = [
  "ישראל", "tel aviv", "תל אביב", "jerusalem", "ירושלים", "haifa", "חיפה",
  "netanya", "נתניה", "beer sheva", "באר שבע", "rishon le zion", "ראשון לציון",
  "petah tikva", "פתח תקווה", "herzliya", "הרצליה", "ashdod", "אשדוד",
  "ashkelon", "אשקלון", "holon", "חולון", "bat yam", "בת ים", "israel",
];

function normalized(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function containsAny(text, terms) {
  return terms.filter((term) => text.includes(term));
}

function classifyGroup({ name, catalogEntry = null }) {
  const title = normalized(name);
  const signals = [];
  if (catalogEntry) {
    signals.push("קבוצה מאומתת בקטלוג Forly");
    return { relevance: "relevant", score: 100, signals, source: "catalog" };
  }

  const propertySignals = containsAny(title, PROPERTY_TERMS);
  const marketSignals = containsAny(title, LOCAL_MARKET_TERMS);
  const locationSignals = containsAny(title, ISRAEL_LOCATION_TERMS);
  for (const term of propertySignals) signals.push(`מילת נדל״ן: ${term}`);
  for (const term of marketSignals) signals.push(`לוח מקומי: ${term}`);
  for (const term of locationSignals) signals.push(`מיקום: ${term}`);

  const score = Math.min(90,
    propertySignals.length * 35 +
    marketSignals.length * 15 +
    (propertySignals.length && locationSignals.length ? 20 : 0) +
    (marketSignals.length && locationSignals.length ? 15 : 0) +
    (marketSignals.length && propertySignals.length ? 10 : 0));

  if (score >= 50) return { relevance: "relevant", score, signals, source: "heuristic" };
  if (score >= 20) return { relevance: "review", score, signals, source: "heuristic" };
  return { relevance: "irrelevant", score, signals, source: "heuristic" };
}

function decorateJoinedGroup({ url, name, previous = null, catalogEntry = null }) {
  const automatic = classifyGroup({ name, catalogEntry });
  const override = previous && ["relevant", "review", "irrelevant"].includes(previous.relevance_override)
    ? previous.relevance_override : null;
  const relevance = override || automatic.relevance;
  return {
    url,
    name,
    relevance,
    automatic_relevance: automatic.relevance,
    relevance_override: override,
    relevance_score: automatic.score,
    relevance_signals: automatic.signals,
    relevance_source: override ? "agent" : automatic.source,
    enabled: previous && typeof previous.enabled === "boolean"
      ? previous.enabled
      : relevance === "relevant",
  };
}

module.exports = { classifyGroup, decorateJoinedGroup };
