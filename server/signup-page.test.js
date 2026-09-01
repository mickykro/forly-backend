/* The web signup form (public/signup/index.html) is where an agent lands after
   clicking "השלמת פרופיל" in the workspace — including demo agents, who arrive
   straight from the dashboard banner via GET /signup. It sits on the "app"
   hosting target, so it cannot link public-agent/app.css and has to inline the
   design tokens instead; this test is what keeps that copy honest. It also
   guards the restyle itself: every id the inline script drives and every class
   the markup uses must still be there.
   Run: node server/signup-page.test.js */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "public", "signup", "index.html"), "utf8");
const appCss = fs.readFileSync(path.join(root, "public-agent", "app.css"), "utf8");

const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
const scriptStart = page.lastIndexOf("<script>");
const markup = page.slice(page.indexOf("<body>"), scriptStart);
const script = page.slice(scriptStart);

function tokens(css) {
  const block = css.slice(css.indexOf(":root{"), css.indexOf("}", css.indexOf(":root{")));
  const out = {};
  for (const decl of block.split(";")) {
    const m = decl.match(/(--[\w-]+)\s*:\s*(.+)/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// ── the inlined tokens match public-agent/app.css exactly ──
{
  const agent = tokens(appCss);
  const signup = tokens(style);
  const shared = ["--bg", "--paper", "--ink", "--ink-soft", "--gold", "--gold-bright",
    "--gold-faint", "--dark", "--radius", "--serif", "--sans"];
  for (const t of shared) {
    assert.ok(signup[t], `signup page is missing design token ${t}`);
    assert.equal(signup[t], agent[t], `${t} drifted from public-agent/app.css`);
  }
}

// ── same type stack as every other agent-facing page ──
{
  assert.match(page, /Frank\+Ruhl\+Libre/, "signup page must load the Frank Ruhl Libre serif");
  assert.match(page, /family=Heebo|&family=Heebo/, "signup page must load Heebo");
  assert.match(style, /--serif:'Frank Ruhl Libre'/, "headings must use the serif token");
}

// ── no off-system palette: the page used to ship a standalone pink theme ──
{
  const strays = ["#DB6B97", "#F4A3BF", "#B94C79", "#FBF5F8", "#2A1F33", "#7FA89B"];
  for (const hex of strays) {
    assert.ok(!style.toUpperCase().includes(hex), `stale off-brand colour ${hex} is back in the signup page`);
  }
  // Brand-colour swatch defaults belong to the agent, not to the page chrome.
  const chromeHexes = style.match(/#[0-9a-fA-F]{6}/g) || [];
  const allowed = new Set(Object.values(tokens(style)).flatMap((v) => v.match(/#[0-9a-fA-F]{6}/g) || []));
  for (const hex of chromeHexes) {
    assert.ok(allowed.has(hex) || /#(fff|FFF)/.test(hex),
      `${hex} is hard-coded in the signup stylesheet — use a design token`);
  }
}

// ── every element the inline script drives still exists in the markup ──
{
  const ids = new Set();
  for (const m of script.matchAll(/\$\('([\w_]+)'\)/g)) ids.add(m[1]);
  for (const m of script.matchAll(/getElementById\('([\w_]+)'\)/g)) ids.add(m[1]);
  for (const m of script.matchAll(/querySelectorAll\('#([\w_]+)/g)) ids.add(m[1]);
  assert.ok(ids.size > 15, "id scan found suspiciously few ids — the script layout changed");
  for (const id of ids) {
    assert.ok(new RegExp(`id="${id}"`).test(markup), `#${id} is used by the script but missing from the markup`);
  }
}

// ── every class the markup uses is actually styled ──
{
  const used = new Set();
  for (const m of markup.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  for (const c of used) {
    assert.ok(new RegExp(`\\.${c}[\\s,.:{>]`).test(style), `.${c} is used in the markup but has no CSS rule`);
  }
}

// ── the way back to the workspace (demo agents come from the dashboard) ──
{
  assert.match(markup, /href="https:\/\/agent\.call4li\.com\/"/,
    "the done screen must link back to the agent workspace");
  assert.match(markup, /class="btn-gold"/, "the return link must use the shared gold button");
}

console.log("signup-page.test.js ✓");
