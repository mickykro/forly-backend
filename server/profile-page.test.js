/*
 * The profile completion form (public-agent/profile.html) is what an agent gets
 * from the workspace's "השלמת פרופיל" banner — demo agents most of all, since
 * that banner is how they reach it. It used to be a separate page on Firebase
 * Hosting with its own copy of the design system and its own unauthenticated
 * Cloud Functions; this test holds the move in place.
 * Run: node server/profile-page.test.js
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const page = read("public-agent", "profile.html");
const appCss = read("public-agent", "app.css");
const scriptStart = page.lastIndexOf("<script>");
const markup = page.slice(page.indexOf("<body"), scriptStart);
const script = page.slice(scriptStart);
const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));

// ── it wears the shared design system rather than a copy of it ──
{
  assert.match(page, /<link rel="stylesheet" href="\/app\.css">/,
    "the profile page must link app.css, not restate the tokens");
  assert.ok(!/:root\s*\{/.test(style),
    "no private token block — every colour comes from app.css");
  for (const hex of (style.match(/#[0-9a-fA-F]{3,6}/g) || [])) {
    assert.equal(hex, "#8A6A1E",
      `${hex} is hard-coded in profile.html — use an app.css var() instead`);
  }
  assert.match(markup, /class="topbar agent-topbar"/, "same topbar as the rest of the workspace");
  assert.match(markup, /class="app-footer"/, "same legal footer as the rest of the workspace");
}

// ── page-local classes must not collide with app.css ones that mean something else ──
{
  assert.match(appCss, /\.chip\{/, "app.css still owns .chip as the status pill");
  assert.ok(!/class="[^"]*\bchip\b/.test(markup),
    "the selectable option chips use .pick — .chip is app.css's read-only status pill");
}

// ── every element the script drives exists, and vice versa ──
{
  const ids = new Set();
  for (const m of script.matchAll(/\$\("([\w]+)"\)/g)) ids.add(m[1]);
  assert.ok(ids.size > 15, "id scan found suspiciously few ids — the script layout changed");
  for (const id of ids) {
    assert.ok(new RegExp(`id="${id}"`).test(markup), `#${id} is used by the script but not in the markup`);
  }
}

// ── every class the markup uses is defined here or in app.css ──
{
  const styles = style + appCss;
  for (const m of markup.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) {
      if (!c) continue;
      assert.ok(new RegExp(`\\.${c}[\\s,.:{>]`).test(styles), `.${c} is used in the markup but never styled`);
    }
  }
}

// ── it talks to the server's own session-authenticated endpoints ──
{
  for (const route of ["/api/onboarding", "/api/onboarding/save", "/api/onboarding/complete"]) {
    assert.ok(script.includes(`"${route}"`), `the form must call ${route}`);
  }
  assert.ok(!/signup-(get|save|complete|upload)/.test(page),
    "the retired Cloud Function endpoints must not be called any more");
  assert.ok(!/call4li\.web\.app/.test(page), "no hop back to the Firebase-hosted form");
  assert.ok(!/[?&]phone=/.test(script),
    "the phone comes from the session cookie — a phone in the URL is what made the old form insecure");
  assert.match(script, /FLY\.uploadFiles/, "portrait and logo use the shared signed-URL upload");
}

// ── the client's live percentage must match server/profile-onboarding.js ──
{
  const server = read("server", "profile-onboarding.js");
  assert.match(server, /OPTIONAL_COUNT = 11/);
  assert.match(script, /OPTIONAL_COUNT = 11/, "the form's optional-field count drifted from the server's");
  assert.match(script, /\* 60\)/, "the form still weights the essentials at 60%");
  assert.match(script, /\* 40\)/, "the form still weights the optionals at 40%");
}

// ── the server serves it, and nothing redirects off-domain any more ──
{
  const index = read("server", "index.js");
  assert.match(index, /app\.get\("\/signup"/, "GET /signup is still handled");
  assert.match(index, /app\.get\("\/profile"/, "GET /profile serves the form directly");
  assert.match(index, /agentPage\("profile\.html"\)/);
  assert.ok(!/WEB_SIGNUP|call4li\.web\.app/.test(index),
    "the cross-domain signup redirect is gone from the server");

  const functions = read("functions", "src", "index.ts");
  for (const fn of ["signupGet", "signupSave", "signupComplete", "signupUpload"]) {
    assert.ok(!new RegExp(`export const ${fn}\\b`).test(functions),
      `${fn} still exists — the profile form moved off Cloud Functions`);
  }
  const hosting = JSON.parse(read("firebase.json")).hosting[0];
  for (const r of hosting.rewrites) {
    assert.ok(!/signup-/.test(r.source), `firebase.json still rewrites ${r.source} to a deleted function`);
  }
}

console.log("profile-page: all tests passed");
