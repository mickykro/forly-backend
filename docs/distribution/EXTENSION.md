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
| Bursts of posts, and *fixed* intervals (a constant cadence is more damning than volume) | Server-enforced daily cap + a **randomized** 4–20 minute gap (`pacing.nextGapMs`) |
| A brand-new account behaving like a power user | Warm-up ramp: 2 posts/day on day one → 8 after two weeks |
| Posting at 04:00 | Israel-local 09:00–21:00 window only |
| The same text+link in many groups | Per-group tracked links; the same property never goes to the same group twice; 7-day per-group cooldown |
| **An external domain repeated across groups → the domain gets blocked platform-wide** | We share the **Facebook post URL**, not a `forly.*` link. This is the one that would hurt every agent at once, so it gets the strongest fix |
| Machine-speed interaction (instant fill, no scroll, no dwell) | Scroll + 2–4s dwell before typing, text typed in chunks with 35–110ms pauses |
| Continuing after a warning | One block/checkpoint report → **24h lockout** for that agent, enforced server-side |

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

## Operating rules for the pilot

- Start with **one** agent, assist mode, and watch `group_posting/{phone}` for
  a week: `posts` length per day, and any `locked_until`.
- If any agent reports a block, stop the pilot and re-read this table before
  resuming — a block means a rule here is too loose.
- Never raise `DAILY_CAP` to "get more reach". Reach comes from the Page post
  and from good groups, not from volume that gets the account restricted.
