# Why Forly does not automate Facebook group posting

**Decision:** groups are shared manually by the agent. Forly prepares
everything up to the Post button and never presses it.
**Status:** settled. A browser extension was built, piloted on paper, and
removed (`3d7f35e`, −2,914 lines). This document is why, so nobody rebuilds it.

## The constraint

Meta removed the Groups publishing API in 2022. No server, no cloud tool, and
no official integration can put a post into a Facebook group. The only thing
that can is the agent's own logged-in browser — which is why every commercial
"group poster" on the market is a browser extension. There is no other
architecture, and there is no version of this that is merely a matter of
building it properly.

## Why the extension was removed

The risk does not sit where the benefit sits.

- Driving the browser to post **violates Meta's Platform Terms** (automated
  behavior). The account exposed is the agent's **personal** Facebook — the
  one with their family photos — not Forly's and not the Page's.
- Escalation order, by likelihood: post removed → temporary block on posting
  to groups (hours to 30 days) → feature block → account restriction. Account
  deletion is rare but not impossible.
- A group admin reporting broker spam is at least as likely to cause trouble
  as Meta's automated detection.

The extension carried a full countermeasure stack — server-enforced daily cap,
a warm-up ramp, randomized inter-post gaps, a cross-agent per-group throttle,
a posting-hours window, per-group copy variation, simulated typing cadence,
verified-membership sync, block detection with a server-side lockout. It was
good work and it was not enough, for two reasons:

1. **Asymmetric downside.** If it goes wrong the agent loses their Facebook
   account and Forly loses one customer. That trade is not ours to offer.
2. **Shared blast radius.** Repeating a `forly.*` domain across many groups
   gets the *domain* scored and blocked platform-wide — one agent's behavior
   breaking link previews for every agent at once.

And commercially: a product whose onboarding step is "install this, and you
might lose your Facebook account" cannot be sold to a brokerage, cannot pass
Meta App Review, and cannot be defended to an investor or a regulator.

## What replaced it

Everything except the Post button.

| Channel | How it works |
|---|---|
| Facebook Page | Official Graph API. Automatic after one human tap (WhatsApp confirm link, or the publish button). |
| Instagram | Same connection, same job pipeline. |
| Groups | Forly matches groups, writes per-group copy, builds the tracked link, and serves a resumable queue. The agent copies, opens, posts, marks ✓. |

The audit log keeps the distinction honest: `copied` and `opened` are
preparation; only an agent-confirmed `posted` writes to `post_actions`, with
`source: "agent_confirmed"`. **Forly never records itself as having posted
something a human posted.**

The leverage that survives is the leverage that was always defensible — the
research (which groups, and which of them allow brokers at all), the copy, and
the tracking. See `GROUP-CATALOG.md`: the 200 curated groups carry
`agent_policy: "explicitly_allowed"` with the group's own rules quoted as
`policy_evidence`. That dataset is slow to build, impossible to fake, and does
not put anyone's account at risk.

## Guardrails this decision keeps in place

- **Never** ship anything that presses Post, types into Facebook's UI, or
  drives a logged-in session on the agent's behalf.
- Share the **Facebook post URL** where one exists, not a bare `forly.*` link,
  so the domain is never the thing repeated across groups.
- Per-group copy varies in framing only; the facts never change.
- Group rules come first — many Israeli nadlan groups are rental-only or
  "owner only, no brokers". Landing the agent *in* the group before they post
  is a feature, not friction.

`backend-only-share.test.js` enforces the first rule mechanically: it asserts
that no extension, `chrome.runtime`, `EXTENSION_ID`, or `group_posting`
reference exists in the routes, the server entrypoint, `.env.example`, or the
agent frontends. Reintroducing the extension turns the build red.

## The one honest limitation

Group slots, not properties, are the scarce resource: a group accepts roughly
one post per day by its own rules, so an agent with 12 joined groups has ~12
slots a day no matter what the software does. Automation never actually solved
that — it only changed who was liable for it. The only lever with no downside
is **joining more groups**.

An agent onboarding with a large back catalogue is a one-time backlog. In
steady state (~3 new listings a week) the manual flow is well under two posts
a day.
