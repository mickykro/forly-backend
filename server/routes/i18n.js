/*
 * routes/i18n.js — the agent dashboard in the agent's language (public-agent/ui-i18n.js).
 *
 *   GET /api/i18n/:lang   { entries: { hebrew: translation }, pending: n }
 *
 * The pages are authored in Hebrew. The dictionary's keys are every Hebrew
 * string literal in public-agent's own HTML and JS (nothing an agent typed or
 * a lead sent ever enters it, so it is public), and the values come from
 * Claude once per string per language (page-translate.translateStrings),
 * kept in settings/ui_i18n_<lang> as one JSON string. Keys the dictionary
 * lacks are filled in the background, one language at a time; the answer
 * carries what is cached now and how many are still on their way, and the
 * client asks again while pending > 0. No key on the server: the UI stays
 * Hebrew (pending 0, fail-open), exactly like a page's own translation.
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const { LANGUAGES } = require("../utils");

const DEFAULT_DIR = path.join(__dirname, "..", "..", "public-agent");
const CHUNK = 80;
const PARALLEL = 4; // calls in flight: the first fill of a language (~1,100 strings) takes a minute or two, not ten
const MAX_KEYS = 5000;
const HEBREW_TWICE = /[א-ת].*[א-ת]/s;
// The operator console stays Hebrew; tests and the dev driver are not pages;
// form-i18n.js is the create form's own dictionary (already in every language).
const SKIP_FILE = /^(admin|dev-driver)|\.test\.js$|^form-i18n\.js$/;

// Every Hebrew string an agent can meet on a page: HTML text between tags,
// attribute values, and the strings in its scripts — markup inside a string
// opened for its text, multi-line strings split per line. A match on the
// client is by exact text or by fragment (ui-i18n.js), so fragments count.
// Walks code from i collecting string literals through push — template
// literals as the text pieces between their ${…}, whose expressions are
// walked in turn (so nested templates and quotes inside strings are read
// right); inExpr: stop after the } that closes the ${. Comments and regex
// literals (a / where an operand starts) are skipped.
const REGEX_BEFORE = /[(,=:[!&|?{};\n]$|^$/;
function scan(code, i, push, inExpr) {
  let depth = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      let s = ""; i++;
      while (i < code.length && code[i] !== ch && code[i] !== "\n") { if (code[i] === "\\") { s += code[i] + code[i + 1]; i += 2; } else s += code[i++]; }
      push(s); i++;
    } else if (ch === "`") {
      let s = ""; i++;
      while (i < code.length && code[i] !== "`") {
        if (code[i] === "\\") { s += code[i] + code[i + 1]; i += 2; } else if (code[i] === "$" && code[i + 1] === "{") { push(s); s = ""; i = scan(code, i + 2, push, true); } else s += code[i++];
      }
      push(s); i++;
    } else if (ch === "/" && code[i + 1] === "/") { while (i < code.length && code[i] !== "\n") i++; }
    else if (ch === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? code.length : e + 2; }
    else if (ch === "/" && REGEX_BEFORE.test(code.slice(0, i).trimEnd().slice(-1))) {
      let cls = false; i++;
      while (i < code.length && (cls || code[i] !== "/") && code[i] !== "\n") { if (code[i] === "\\") i++; else if (code[i] === "[") cls = true; else if (code[i] === "]") cls = false; i++; }
      i++;
    }
    else if (inExpr && ch === "}" && depth === 0) return i + 1;
    else { if (ch === "{") depth++; else if (ch === "}") depth--; i++; }
  }
  return i;
}

function literals(src, isHtml) {
  const out = new Set();
  const add = (raw) => {
    const s = raw.replace(/&nbsp;/g, " ").replace(/\\n/g, "\n").replace(/\\(["'`])/g, "$1");
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (t.length <= 400 && HEBREW_TWICE.test(t)) out.add(t);
    }
  };
  const texts = (s) => { for (const m of s.matchAll(/>([^<>]+)</g)) add(m[1]); };
  const strings = (code) => scan(code, 0, (s) => (/[<>]/.test(s) ? texts(s) : add(s)), false);
  if (!isHtml) { strings(src); return out; }
  // Markup text and attribute values; the page's scripts as code (a > in a
  // string is not a tag).
  const scripts = [];
  const markup = src.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => { scripts.push(body); return "<script></script>"; });
  texts(markup);
  for (const m of markup.matchAll(/=\s*"([^"]*)"|=\s*'([^']*)'/g)) add(m[1] != null ? m[1] : m[2]);
  scripts.forEach(strings);
  return out;
}

function sourceKeys(dir) {
  const all = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(html|js)$/.test(f) || SKIP_FILE.test(f)) continue;
    for (const k of literals(fs.readFileSync(path.join(dir, f), "utf8"), f.endsWith(".html"))) all.add(k);
  }
  return [...all].slice(0, MAX_KEYS);
}

const parse = (doc) => { try { return JSON.parse((doc && doc.json) || "{}") || {}; } catch { return {}; } };

module.exports = function createI18nRouter({ db, dir = DEFAULT_DIR, translate = require("../page-translate").translateStrings } = {}) {
  const router = express.Router();
  let keys = null; // the files do not change while the process runs
  const filling = {};

  async function fill(lang, missing) {
    console.log(`[ui-i18n] ${lang}: translating ${missing.length} strings`);
    for (let i = 0; i < missing.length; i += CHUNK * PARALLEL) {
      const chunks = [];
      for (let j = i; j < Math.min(missing.length, i + CHUNK * PARALLEL); j += CHUNK) chunks.push(missing.slice(j, j + CHUNK));
      const got = Object.assign({}, ...(await Promise.all(chunks.map((c) => translate(lang, c)))).filter(Boolean));
      // No key, a refusal or an error: what is cached stays, the rest waits for the next request.
      if (!Object.keys(got).length) { console.log(`[ui-i18n] ${lang}: nothing came back, ${missing.length - i} strings left`); return; }
      const entries = Object.assign(parse(await db.getSetting(`ui_i18n_${lang}`)), got);
      await db.setSetting(`ui_i18n_${lang}`, { json: JSON.stringify(entries) });
    }
    console.log(`[ui-i18n] ${lang}: done`);
  }

  router.get("/:lang", async (req, res) => {
    const lang = req.params.lang;
    if (!LANGUAGES[lang]) return res.status(404).json({ error: "unknown_language" });
    if (lang === "he") return res.json({ entries: {}, pending: 0 });
    try {
      if (!keys) keys = sourceKeys(dir);
      const entries = parse(await db.getSetting(`ui_i18n_${lang}`));
      const missing = keys.filter((k) => entries[k] === undefined);
      if (missing.length && !filling[lang] && process.env.ANTHROPIC_API_KEY) {
        filling[lang] = fill(lang, missing).catch((e) => console.error(`[ui-i18n] ${lang}: ${e && e.message}`)).finally(() => { delete filling[lang]; });
      }
      res.set("Cache-Control", "no-store");
      // reason: why entries are missing — "filling" (ask again) or "no_api_key" (the server cannot translate).
      const reason = !missing.length ? null : filling[lang] ? "filling" : process.env.ANTHROPIC_API_KEY ? null : "no_api_key";
      res.json(Object.assign({ entries, pending: filling[lang] ? missing.length : 0 }, reason ? { reason } : {}));
    } catch (e) {
      console.error(`[ui-i18n] ${lang}: ${e && e.message}`);
      res.status(500).json({ error: "i18n_failed" });
    }
  });

  router._test = { literals, sourceKeys, whenFilled: (lang) => filling[lang] || Promise.resolve() };
  return router;
};
