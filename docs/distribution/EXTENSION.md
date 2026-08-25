# Forly group-posting extension — what it is, and the risk

## Why an extension exists at all

Meta removed the Groups publishing API in 2022. No server, no cloud tool, and
no official integration can put a post into a Facebook group. The only thing
that can is the agent's own logged-in browser. Every commercial "group poster"
on the market is therefore a browser extension; there is no other architecture.

## The honest risk statement (say this to every pilot agent)

- Using an extension to assist posting **is against Meta's Platform Terms**
  (automated behavior). Meta may restrict the account that does it.
- The exposure is the agent's **personal Facebook account** — the same account
  they use for family photos. Not Forly's, not the Page's.
- Realistic worst case, in order of likelihood: a post removed → a temporary
  block on posting to groups (hours to 30 days) → a feature block → account
  restriction. Account deletion is rare but not impossible.
- A group admin reporting broker spam is at least as likely to cause trouble
  as Meta's automated systems. Group rules matter.

Agents must opt in knowing this. Default the pilot to **assist mode**.

## What actually triggers enforcement, and what we do about it

| Signal Meta looks for | Our countermeasure |
|---|---|
| Bursts of posts, and *fixed* intervals (a constant cadence is more damning than volume) | Server-enforced daily cap + a **randomized** 4–20 minute gap; plus a cross-agent throttle so one group never receives two Forly posts within 10–20 minutes |
| A brand-new account behaving like a power user | Warm-up ramp: 2 posts/day on day one → `DAILY_CAP` (12) after two weeks |
| Posting at 04:00 | Israel-local 09:00–21:00 window only |
| The same text+link in many groups | A different copy variant per group (facts identical); the same property never goes to the same group twice, ever; 24h per-group cooldown between different properties |
| **An external domain repeated across groups → the domain gets blocked platform-wide** | We share the **Facebook post URL**, not a `forly.*` link. This is the one that would hurt every agent at once, so it gets the strongest fix |
| Machine-speed interaction (instant fill, no scroll, no dwell) | Scroll + 2–4s dwell, text typed in randomized 18–24 char chunks at 35–110ms, field re-focused each chunk, then a read-back pause scaled to length |
| Continuing after a warning | One block/checkpoint report → **24h lockout** for that agent, enforced server-side |
| Posting where you aren't a member (fastest route to a report) | The extension syncs the agent's **actual joined groups**; anything else is refused (`not_a_member`), and nothing is scheduled at all until that sync exists |

Also, by construction: no credentials are ever collected (the extension uses
the session already in the browser), nothing is scraped, one tab at a time,
and the agent can stop the queue instantly from the popup.

## Assist mode vs auto mode

**Assist (default).** The extension opens the group, types the post, and
stops. The agent reads it and presses Facebook's own Post button. This is a
typing shortcut with a human publishing — it removes nearly all of the
automation fingerprint while removing most of the work. `post_actions` records
these as `source: "agent_confirmed"`.

**Auto (opt-in).** The extension presses Post itself after a human-like delay.
Faster, materially riskier, recorded as `source: "extension_auto"`. Keep it off
for the pilot; consider it only for an agent who understands the trade.

The extension never invents a task or a schedule: it asks
`GET /api/distribution/extension/next` and does exactly what the server allows,
so tightening the rules takes effect everywhere without shipping a new build.

## Installing (pilot)

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Copy the extension ID Chrome shows, and add it to the server's
   `EXTENSION_IDS` env so the dashboard is allowed to hand it a pairing token.
4. In Forly → הפצה → **חיבור התוסף**. The page passes the token to the
   extension; no copy/paste.
5. Open a property's sharing queue, press **התחלה** in the popup.

For a wider rollout the extension should be published to the Chrome Web Store
(unlisted is fine) so agents get updates without re-loading a folder.

## How long a backlog takes (and why that number is misleading)

The scarce resource is group slots, not properties: each group accepts one
post per day (its own rule), so 12 joined groups yield 12 slots/day, and the
agent's own ceiling is `DAILY_CAP`.

For an agent onboarding with **40 existing listings** and 10–15 joined groups,
at 4 groups per property:

| | 10 groups | 12–15 groups |
|---|---|---|
| Every listing live *somewhere* | **4 days** | **4 days** |
| Top 10 listings fully distributed | **4 days** | **4 days** |
| All 160 placements finished | 16 days | 14 days |

The headline is the first row, not the last. Fairness-first rotation means
every property reaches its first group before any property reaches its
second, so the whole portfolio is visible within days; "14 days" is only when
the last of 160 placements lands.

And this is a **one-time onboarding backlog**. In steady state an agent adding
~3 listings a week needs ~12 posts a week — under 2 a day, far below any
limit here.

Levers, in order of how much they help and how defensible they are:

1. **Join more groups.** The only lever with no downside at all.
2. **Fewer groups per property** (4 → 3) — 25% faster, and the fourth-best
   group is usually a poor fit anyway.
3. **`DISTRIBUTION_DAILY_CAP`** — 12 by default, reachable only after the
   two-week warm-up. Run the pilot at 8 and raise it after a clean fortnight.
   Do not exceed 12 without a very good reason.

## Operating rules for the pilot

- Start with **one** agent, assist mode, and watch `group_posting/{phone}` for
  a week: `posts` length per day, and any `locked_until`.
- If any agent reports a block, stop the pilot and re-read this table before
  resuming — a block means a rule here is too loose.
- Never raise `DAILY_CAP` to "get more reach". Reach comes from the Page post
  and from good groups, not from volume that gets the account restricted.
