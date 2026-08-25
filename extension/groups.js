/*
 * groups.js — one-shot collection of Groups THIS agent has joined.
 *
 * The scan reads only a Group name and canonical URL from Facebook's own
 * joined-Groups page. It is never scheduled: the agent explicitly starts it.
 * Facebook lazy-loads the list while scrolling, so we keep an accumulated set
 * until the list stays unchanged for several passes or a conservative hard
 * ceiling is reached. The ceiling is reported to Forly; it is not presented as
 * a complete result.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const MAX_SCROLLS = 120;
const STABLE_PASSES = 6;
const SKIP_GROUP_PATHS = new Set(["feed", "joins", "discover", "create", "search"]);

function normalizeGroupUrl(href) {
  try {
    const url = new URL(href, location.origin);
    const match = url.pathname.match(/^\/groups\/([^/?#]+)\/?$/i);
    if (!match) return null;
    const slug = decodeURIComponent(match[1]).trim();
    if (!slug || SKIP_GROUP_PATHS.has(slug.toLowerCase())) return null;
    return `https://www.facebook.com/groups/${encodeURIComponent(slug)}`;
  } catch {
    return null;
  }
}

function groupName(anchor) {
  const candidates = [
    anchor.getAttribute("aria-label"), anchor.innerText, anchor.textContent,
    anchor.querySelector?.("span")?.textContent,
  ];
  for (const candidate of candidates) {
    const name = String(candidate || "").replace(/\s+/g, " ").trim();
    if (name && name.length <= 140) return name;
  }
  return null;
}

function harvest(into) {
  const anchors = [...document.querySelectorAll("a[href]")];
  for (const anchor of anchors) {
    const url = normalizeGroupUrl(anchor.href || anchor.getAttribute("href"));
    const name = url && groupName(anchor);
    if (url && name && !into.has(url)) into.set(url, name);
  }
  return anchors.length;
}

async function scan() {
  const found = new Map();
  let inspectedAnchors = 0;
  let stablePasses = 0;
  let previousCount = 0;
  let scrolls = 0;

  for (; scrolls < MAX_SCROLLS; scrolls++) {
    inspectedAnchors = Math.max(inspectedAnchors, harvest(found));
    window.scrollBy({ top: 850 + rand(0, 500), behavior: "smooth" });
    await sleep(rand(950, 1700));
    harvest(found);

    if (found.size === previousCount) stablePasses++;
    else stablePasses = 0;
    previousCount = found.size;
    if (stablePasses >= STABLE_PASSES) break;
  }
  const passes = Math.min(scrolls + 1, MAX_SCROLLS);

  return {
    groups: [...found.entries()].map(([url, name]) => ({ url, name })),
    inspected_anchors: inspectedAnchors,
    scrolls: passes,
    complete: stablePasses >= STABLE_PASSES,
    capped: passes >= MAX_SCROLLS && stablePasses < STABLE_PASSES,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.forly === "scan-groups") {
    scan()
      .then((result) => reply({ ok: true, ...result }))
      .catch(() => reply({ ok: false, groups: [], inspected_anchors: 0, scrolls: 0, complete: false }));
    return true;
  }
  return false;
});
