/*
 * distribution/scheduler.js — who gets the next slot, when an agent has far
 * more properties than the safety rules can publish at once.
 *
 * The scarce resource is GROUP SLOTS, not properties. Each group accepts one
 * post every GROUP_COOLDOWN (48h), so ten joined groups yield roughly 35
 * slots a week — while an agent with 50 listings wants 200+. Something has to
 * decide what goes where.
 *
 * Why rotation and not fixed stacks ("properties 1–10 always go to groups A
 * and B"): stacks partition the scarce resource up front, so a group sits
 * idle whenever its stack has nothing fresh, a sold listing leaves a hole
 * nothing else can fill, and a brand-new listing waits for its stack's turn
 * instead of going out today. Rotation keeps the stacks' good property — the
 * same group never sees the same listing twice, and consecutive posts in one
 * group are always different properties — without freezing the assignment:
 *
 *   1. FAIRNESS FIRST: a property with fewer posts so far always outranks one
 *      with more, so every listing gets its first group before any listing
 *      gets its fifth. This is what stops the top of the list eating the week.
 *   2. FRESHNESS: among equals, the newest listing wins — new inventory is
 *      what sells, and it is what group members have not seen yet.
 *   3. FIT: a group whose city and listing type match the property is
 *      preferred over a generic one.
 *   4. REACH: all else equal, the larger group.
 *
 * Plus a per-property cap (default 4 groups): without it one listing would
 * consume a whole week's slots. Four good groups beat ten mediocre ones.
 *
 * Pure functions — no I/O, no clock except the injected `now`.
 */

const DEFAULT_GROUP_CAP = 4;

const ms = (v) => (v ? new Date(v).getTime() : 0);

// How well this group suits this property. Cheap and explainable on purpose:
// the agent should be able to see why a pairing was chosen.
function fitScore(property, group) {
  let score = 0;
  if (group.city && property.city && group.city === property.city) score += 3;
  const types = Array.isArray(group.listing_types) ? group.listing_types : [];
  if (!types.length) score += 1;                                   // general board
  else if (types.includes(property.listing_type || "sale")) score += 2;
  else score -= 4;                                                 // wrong kind of group
  return score;
}

/*
 * The next (property, group) pair to publish, or null with a reason.
 *
 * properties: [{ page_id, created_at, city, listing_type, priority? }]
 * groups:     [{ url, members, city, listing_types }]   — joined groups only
 * history:    [{ at, page_id, group_url }]              — this agent's posts
 */
function planNext({ properties, groups, history = [], now = Date.now(),
  groupCooldownMs, perPropertyGroupCap = DEFAULT_GROUP_CAP }) {
  const props = Array.isArray(properties) ? properties : [];
  const grps = Array.isArray(groups) ? groups : [];
  if (!props.length) return { none: true, reason: "no_properties" };
  if (!grps.length) return { none: true, reason: "no_groups" };

  const postsFor = new Map();       // page_id → count
  const pairSeen = new Set();       // page_id|group_url
  const groupLast = new Map();      // group_url → last post ms
  for (const h of history) {
    postsFor.set(h.page_id, (postsFor.get(h.page_id) || 0) + 1);
    pairSeen.add(`${h.page_id}|${h.group_url}`);
    groupLast.set(h.group_url, Math.max(groupLast.get(h.group_url) || 0, ms(h.at)));
  }

  const restingGroups = grps.filter((g) => {
    const last = groupLast.get(g.url) || 0;
    return last && now - last < groupCooldownMs;
  });

  let best = null;
  for (const p of props) {
    const used = postsFor.get(p.page_id) || 0;
    if (used >= perPropertyGroupCap) continue;
    for (const g of grps) {
      if (pairSeen.has(`${p.page_id}|${g.url}`)) continue;         // never repeat
      const last = groupLast.get(g.url) || 0;
      if (last && now - last < groupCooldownMs) continue;          // group resting
      const cand = {
        page_id: p.page_id, group_url: g.url,
        // Lower sorts first. Fairness dominates every other term by an order
        // of magnitude, so it can never be outvoted by fit or size.
        rank: [used * 1000, -(ms(p.created_at) / 1e10) - (p.priority || 0) * 5,
          -fitScore(p, g), -Math.log10((g.members || 1000) + 1)],
      };
      if (!best || cmp(cand.rank, best.rank) < 0) best = cand;
    }
  }

  if (!best) {
    // Distinguish "everything is published" from "everything is resting" —
    // the UI says something very different in each case. A property is done
    // when it has hit its cap OR run out of groups it hasn't been posted to.
    const done = props.every((p) => {
      const used = postsFor.get(p.page_id) || 0;
      if (used >= perPropertyGroupCap) return true;
      return grps.every((g) => pairSeen.has(`${p.page_id}|${g.url}`));
    });
    if (done) return { none: true, reason: "all_distributed" };
    if (restingGroups.length === grps.length) {
      const soonest = Math.min(...grps.map((g) => (groupLast.get(g.url) || 0) + groupCooldownMs));
      return { none: true, reason: "groups_resting", retry_at: new Date(soonest).toISOString() };
    }
    return { none: true, reason: "nothing_eligible" };
  }
  return { page_id: best.page_id, group_url: best.group_url };
}

function cmp(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/*
 * An honest forecast for the dashboard: with this many properties, groups and
 * daily posts, how long does a full distribution take? Agents plan around
 * this, and an unrealistic promise is worse than a long number.
 */
function forecast({ propertyCount, groupCount, dailyCap, groupCooldownMs,
  perPropertyGroupCap = DEFAULT_GROUP_CAP }) {
  const perProperty = Math.min(perPropertyGroupCap, groupCount);
  const totalPosts = propertyCount * perProperty;
  const dayMs = 24 * 60 * 60 * 1000;
  // Two ceilings: the agent's daily cap, and how often each group reopens.
  const groupSlotsPerDay = groupCount * (dayMs / (groupCooldownMs || dayMs));
  const perDay = Math.max(1, Math.min(dailyCap, groupSlotsPerDay));
  return {
    total_posts: totalPosts,
    posts_per_day: Math.round(perDay * 10) / 10,
    days: Math.ceil(totalPosts / perDay),
    limited_by: groupSlotsPerDay < dailyCap ? "groups" : "daily_cap",
    per_property_groups: perProperty,
    /*
     * The number an agent actually cares about. Because fairness comes first,
     * every listing reaches its first group before any reaches its second —
     * so the whole portfolio is *visible* in a fraction of the time it takes
     * to finish every placement. "Everything live somewhere in 4 days" is the
     * honest headline; "40 days to finish" is the footnote.
     */
    days_to_first_exposure: Math.ceil(propertyCount / perDay),
    days_top10: Math.ceil(Math.min(propertyCount, 10) * perProperty / perDay),
  };
}

module.exports = { DEFAULT_GROUP_CAP, fitScore, planNext, forecast };
