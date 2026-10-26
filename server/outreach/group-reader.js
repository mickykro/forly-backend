"use strict";
const {
  syncMembership,
  isRealEstateGroup,
  isNavSlug,
  GROUPS_URL,
} = require("../facebook-groups-sync");
const error = (code) => Object.assign(new Error(code), { code });
function groupAddress(raw) {
  try {
    const u = new URL(raw);
    const m = /^\/groups\/([A-Za-z0-9._-]+)\/?$/.exec(u.pathname);
    if (
      u.protocol !== "https:" ||
      !["www.facebook.com", "facebook.com", "m.facebook.com"].includes(
        u.hostname,
      ) ||
      u.username ||
      u.password ||
      u.port ||
      !m ||
      isNavSlug(m[1])
    )
      return null;
    return { slug: m[1], url: `https://www.facebook.com/groups/${m[1]}/` };
  } catch {
    return null;
  }
}
function canonicalPost(raw, groupSlug) {
  const allowed = new Set(Array.isArray(groupSlug) ? groupSlug : [groupSlug]);
  try {
    const u = new URL(raw);
    const m =
      /^\/groups\/([A-Za-z0-9._-]+)\/(?:posts|permalink)\/(\d+)\/?$/.exec(
        u.pathname,
      );
    if (
      u.protocol !== "https:" ||
      !["www.facebook.com", "facebook.com", "m.facebook.com"].includes(
        u.hostname,
      ) ||
      u.username ||
      u.password ||
      u.port ||
      !m ||
      !allowed.has(m[1]) ||
      u.searchParams.has("comment_id") ||
      u.searchParams.has("reply_comment_id")
    )
      return null;
    return `https://www.facebook.com/groups/${m[1]}/posts/${m[2]}/`;
  } catch {
    return null;
  }
}
// Executed within the Driver page. Read post bodies only, never feed text,
// author names, profiles, comments or browser chrome. No clicks or mutations.
function readArticles({ groupSlug, groupSlugs, limit }) {
  const allowed = new Set(groupSlugs || [groupSlug]);
  const rows = [];
  const articles = Array.from(
    document.querySelectorAll(
      '[role="feed"] [role="article"],main [role="article"],[role="main"] [role="article"]',
    ),
  ).slice(0, 100);
  for (const article of articles) {
    if (rows.length >= limit) break;
    if (article.parentElement?.closest('[role="article"]')) continue;
    const own = (node) =>
      node.closest('[role="article"]') === article &&
      !node.closest(
        '[data-ad-rendering-role="comment"],[aria-label*="Comment"],[aria-label*="תגובה"]',
      );
    let permalink;
    for (const anchor of article.querySelectorAll("a[href]")) {
      if (!own(anchor)) continue;
      try {
        const u = new URL(anchor.href);
        const m =
          /^\/groups\/([A-Za-z0-9._-]+)\/(?:posts|permalink)\/(\d+)\/?$/.exec(
            u.pathname,
          );
        if (
          u.protocol === "https:" &&
          ["www.facebook.com", "facebook.com", "m.facebook.com"].includes(
            u.hostname,
          ) &&
          !u.username &&
          !u.password &&
          !u.port &&
          m &&
          allowed.has(m[1]) &&
          !u.searchParams.has("comment_id") &&
          !u.searchParams.has("reply_comment_id")
        ) {
          permalink = `https://www.facebook.com/groups/${m[1]}/posts/${m[2]}/`;
          break;
        }
      } catch {}
    }
    if (!permalink) continue;
    const message = Array.from(
      article.querySelectorAll(
        '[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"]',
      ),
    ).find(own);
    const description = String(message?.innerText || message?.textContent || "")
      .trim()
      .slice(0, 10000);
    if (!description) continue;
    const images = [];
    for (const img of article.querySelectorAll("img")) {
      if (!own(img)) continue;
      const rendered =
        typeof img.getBoundingClientRect === "function"
          ? img.getBoundingClientRect()
          : null;
      if (rendered && (rendered.width <= 80 || rendered.height <= 80)) continue;
      if (
        Math.max(img.naturalWidth || 0, img.width || 0) < 320 ||
        Math.max(img.naturalHeight || 0, img.height || 0) < 180
      )
        continue;
      try {
        const u = new URL(img.currentSrc || img.src);
        if (
          u.protocol === "https:" &&
          /(^|\.)fbcdn\.net$/i.test(u.hostname) &&
          !u.username &&
          !u.password &&
          !images.includes(u.href)
        )
          images.push(u.href);
      } catch {}
      if (images.length >= 20) break;
    }
    rows.push({ source_post_url: permalink, description, images });
  }
  return rows;
}
// Facebook sometimes renders a login form at /groups/joins/ without redirecting.
// Inspect controls, not translated prose or feed content.
function loginFormDetected(root) {
  return !!(
    (root.querySelector('input[name="email"]') &&
      root.querySelector('input[name="pass"],input[type="password"]')) ||
    root.querySelector('form[action*="/login"] input[type="password"]')
  );
}
async function requireLoggedIn(page) {
  const landed = String(page.url?.() || "");
  if (/\/(?:login|accounts\/login)(?:\/|\?|$)/i.test(landed))
    throw error("group_scan_login_required");
  if (/\/checkpoint(?:\/|\?|$)/i.test(landed))
    throw error("group_scan_checkpoint");
  if (typeof page.$eval === "function") {
    let login = false;
    try {
      login = await page.$eval("body", loginFormDetected);
    } catch {}
    if (login === true) throw error("group_scan_login_required");
  }
}
function bounded(value, fallback, max) {
  return Number.isFinite(Number(value))
    ? Math.max(1, Math.min(max, Math.floor(Number(value))))
    : fallback;
}
async function readGroups(
  {
    phone,
    conn,
    profileName,
    groupUrls,
    groupOffset = 0,
    maxGroups = 3,
    maxPosts = 60,
    jobId,
  } = {},
  deps = {},
) {
  if (!phone || !conn || !profileName)
    throw error("dedicated_operator_required");
  const groupCap = bounded(maxGroups, 3, 10),
    postCap = bounded(maxPosts, 60, 60);
  const clock = deps.now || Date.now;
  const deadline =
    clock() + Math.min(240000, Math.max(1, deps.deadlineMs || 240000));
  const remaining = () => {
    const ms = deadline - clock();
    if (ms <= 0) throw error("group_scan_deadline");
    return ms;
  };
  if (!deps.syncMembership) {
    const membershipUrl = new URL(GROUPS_URL);
    if (
      membershipUrl.protocol !== "https:" ||
      !["www.facebook.com", "facebook.com", "m.facebook.com"].includes(
        membershipUrl.hostname,
      ) ||
      membershipUrl.username ||
      membershipUrl.password ||
      membershipUrl.port ||
      !/^\/groups\/joins\/?$/.test(membershipUrl.pathname)
    )
      throw error("invalid_membership_destination");
  }
  const withPage = deps.withPage || require("../driver-browser").withPage;
  const membership = deps.syncMembership || syncMembership;
  const readSignal =
    deps.readSignal || require("../posting-driver-proof").readSignal;
  return withPage(
    {
      duration: 300,
      note: `forly-outreach-scan:${String(jobId || "adhoc")
        .replace(/[^A-Za-z0-9:_-]/g, "")
        .slice(0, 100)}`,
      type: "hosted",
      country: "IL",
      profile: { name: profileName, persist: true },
    },
    async (page) => {
      let watchdog;
      const expired = new Promise((_, reject) => {
        watchdog = setTimeout(() => {
          try {
            const close = page.close?.({ runBeforeUnload: false });
            if (close?.catch) close.catch(() => {});
          } catch {}
          reject(error("group_scan_deadline"));
        }, remaining());
      });
      try {
        return await Promise.race([
          (async () => {
            const warnings = new Set(),
              groups = [],
              posts = [],
              seenPosts = new Set();
            await requireLoggedIn(page);
            let joined;
            try {
              joined = await membership(page);
              await requireLoggedIn(page);
            } catch (e) {
              if (e.signal)
                throw error(
                  "group_scan_" +
                    (String(e.signal).includes("login")
                      ? "login_required"
                      : String(e.signal).includes("checkpoint")
                        ? "checkpoint"
                        : "unreadable"),
                );
              throw e;
            }
            const eligible = new Map();
            for (const item of joined || []) {
              const address = groupAddress(item.url);
              if (address && isRealEstateGroup(item))
                eligible.set(address.url, {
                  ...address,
                  name: String(item.name || "").slice(0, 120),
                });
            }
            let selected = [...eligible.values()];
            if (groupUrls !== undefined) {
              if (!Array.isArray(groupUrls) || groupUrls.length > 100)
                throw error("invalid_group_selection");
              const requested = new Set(
                groupUrls.map((url) => groupAddress(url)?.url).filter(Boolean),
              );
              if (
                requested.size !== groupUrls.length ||
                [...requested].some((url) => !eligible.has(url))
              )
                warnings.add("selected_group_not_eligible");
              selected = selected.filter((g) => requested.has(g.url));
            }
            const available = selected.length;
            const offset = available
              ? Math.max(0, Math.floor(Number(groupOffset) || 0)) % available
              : 0;
            selected = selected.slice(offset).concat(selected.slice(0, offset));
            if (!selected.length) warnings.add("no_eligible_groups");
            if (selected.length > groupCap) warnings.add("group_limit_reached");
            for (const group of selected.slice(0, groupCap)) {
              const aliases = new Set([group.slug]);
              for (const known of conn.facebook_groups_member || []) {
                const home = groupAddress(known.canonical_url || known.url);
                const ids = [known.group_id, ...(known.aliases || [])].map(
                  (id) => String(id || "").replace(/^slug:/, ""),
                );
                if (home?.slug === group.slug || ids.includes(group.slug))
                  for (const slug of [home?.slug, ...ids])
                    if (
                      slug &&
                      /^[A-Za-z0-9._-]+$/.test(slug) &&
                      !isNavSlug(slug)
                    )
                      aliases.add(slug);
              }
              if (posts.length >= postCap) {
                warnings.add("post_limit_reached");
                break;
              }
              await page.goto(group.url, {
                waitUntil: "domcontentloaded",
                timeout: Math.min(45000, remaining()),
              });
              await page
                .waitForLoadState("networkidle", {
                  timeout: Math.min(5000, remaining()),
                })
                .catch(() => {});
              // The page's own canonical head URL is an authoritative alias, unlike suggested group links in feed content.
              if (typeof page.$eval === "function") {
                for (const selector of [
                  'link[rel="canonical"]',
                  'meta[property="og:url"]',
                ]) {
                  try {
                    const raw = await page.$eval(
                      selector,
                      (e) => e.href || e.content,
                    );
                    const address = groupAddress(raw);
                    if (address) aliases.add(address.slug);
                  } catch {}
                }
              }
              const check = async () => {
                remaining();
                await requireLoggedIn(page);
                const landed = String(page.url());
                if (
                  /\/(?:login|checkpoint|accounts\/login)(?:\/|\?|$)/i.test(
                    landed,
                  )
                )
                  throw error(
                    landed.includes("checkpoint")
                      ? "group_scan_checkpoint"
                      : "group_scan_login_required",
                  );
                if (!aliases.has(groupAddress(landed)?.slug))
                  throw error("group_scan_destination_mismatch");
                const signal = await readSignal(page, "");
                if (signal !== "ok")
                  throw error(
                    "group_scan_" +
                      (String(signal).includes("login")
                        ? "login_required"
                        : String(signal).includes("checkpoint")
                          ? "checkpoint"
                          : "unreadable"),
                  );
              };
              await check();
              groups.push({ url: group.url, name: group.name });
              let perGroup = 0;
              for (let scroll = 0; scroll <= 3; scroll++) {
                await check();
                const rows = await page.evaluate(readArticles, {
                  groupSlug: group.slug,
                  groupSlugs: [...aliases],
                  limit: 20,
                });
                for (const row of Array.isArray(rows) ? rows : []) {
                  if (perGroup >= 20 || posts.length >= postCap) break;
                  const source = canonicalPost(row.source_post_url, [
                    ...aliases,
                  ]);
                  const postId = source?.match(/posts\/(\d+)\//)?.[1];
                  if (
                    !source ||
                    seenPosts.has(postId) ||
                    typeof row.description !== "string" ||
                    !row.description.trim()
                  )
                    continue;
                  const images = (Array.isArray(row.images) ? row.images : [])
                    .filter((url) => {
                      try {
                        const u = new URL(url);
                        return (
                          u.protocol === "https:" &&
                          /(^|\.)fbcdn\.net$/i.test(u.hostname) &&
                          !u.username &&
                          !u.password
                        );
                      } catch {
                        return false;
                      }
                    })
                    .slice(0, 20);
                  posts.push({
                    source_post_url: source,
                    description: row.description.slice(0, 10000),
                    images,
                    group_url: group.url,
                    group_name: group.name,
                  });
                  seenPosts.add(postId);
                  perGroup++;
                }
                if (perGroup >= 20 || posts.length >= postCap) break;
                if (scroll < 3) {
                  await page.mouse.wheel(0, 1200);
                  await page.waitForTimeout(800);
                }
              }
              if (!perGroup) warnings.add("group_no_readable_posts");
            }
            return {
              groups,
              posts,
              warnings: [...warnings].sort(),
              groups_available: available,
              next_group_offset: available
                ? (offset + groups.length) % available
                : 0,
            };
          })(),
          expired,
        ]);
      } finally {
        clearTimeout(watchdog);
      }
    },
    { phone, conn, platform: "facebook" },
  );
}
module.exports = {
  readGroups,
  canonicalPost,
  groupAddress,
  readArticles,
  loginFormDetected,
};
