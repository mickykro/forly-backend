# Watched local Facebook Group posting test

Use this mode when testing a real Group post from the local Forly server.

> **Sticky note — real external action:** after approval, the test publishes to the selected Facebook Group using the connected local Facebook profile. Use a Group you own or have explicit permission to test in.

## Guarantees

When started with `npm run posting:local`:

- multi-day warm-up and separate idle dwell sessions are disabled;
- after approval, the visible posting browser opens Facebook for a short passive readiness preflight, then opens the approved Group and publishes from that **same browser session**;
- the preflight performs no scrolling, post opening, likes, stories, reactions, typing, or synthetic pointer activity;
- campaign pacing is immediate locally, while duplicate, Group eligibility, cooldown, account, and fleet controls remain active;
- every new post is forced into `per_post` mode;
- an old unapproved scheduled local post is moved back to `pending_approval` before a browser can open;
- the exact Group, copy, media, and destination are shown for approval;
- the posting browser appears live at `/dev-driver.html`;
- the Post button is clicked at most once, after identity, Group, composer, copy, media, and enabled-submit checks pass.

The mode refuses to start in staging, production, `NODE_ENV=production`, with the posting sweeper disabled, with the posting environment switch disabled, or with the live viewer explicitly disabled.

## Prerequisites

Keep the normal local secrets in `server/.env`:

- `DRIVER_API_KEY`
- `PROFILE_KEY`
- `ADMIN_PHONES` containing the testing account
- stable `NADLAN_JWT_SECRET` for local login
- the repository's Firestore credentials/configuration

The persistent admin posting switch and Facebook platform switch must also be enabled. The command enables only the local process-level switch; it does not silently change stored admin settings.

## Run

```bash
cd server
npm run posting:local
```

The command opens `http://127.0.0.1:8787/dev-driver.html`. Set `POSTING_LOCAL_OPEN=0` if you prefer to open it manually. A different port can be passed after `--`:

```bash
npm run posting:local -- 8788
```

## Test flow

1. Sign in locally as an allowed admin/agent.
2. Connect Facebook locally if the `facebook-local-*` profile is not connected.
3. Open `/autopublish.html`, select the property and permitted Groups, and create the campaign. Local test mode forces per-post approval even if the UI submitted standing mode.
4. In `/dev-driver.html`, press **Run sweep now**. The planner creates one `pending_approval` post; it does not open Facebook yet.
5. Review the exact copy, media, destination strategy, and Group in the campaign page. Press **Approve and publish**.
6. Return to `/dev-driver.html` and press **Run sweep now** again, or wait for the one-minute sweeper.
7. Watch the live browser tile as Forly opens Facebook for the passive readiness preflight, then opens the Group in the same session, uploads the media, fills the composer, proves the target and copy, and clicks Post once.
8. Check the resulting permalink and campaign status. If Facebook requires moderator approval, the result is recorded separately.

## Notes

- The local profile namespace is separate from production (`facebook-local-*`).
- No multi-day warm-up, separate background browsing, likes, stories, or synthetic engagement occur in this mode.
- The passive preflight holds for 20 seconds by default. For supervised debugging it can be set to an explicit value from 0–90 seconds with `POSTING_LOCAL_PREFLIGHT_SECONDS`; it is never randomized to imitate a person.
- If the embedded browser reaches a Chromium network-error page such as `ERR_SOCKS_CONNECTION_FAILED`, Forly now stops and forgets that broken session, then tries one fresh login browser. New sessions are inspected after launch before they are saved. If the retry also fails, the custom proxy is unreachable or Driver's hosted route is unhealthy; no infinite retry occurs. Driver accepts `socks5://` or `socks5h://` URLs, not HTTP proxy URLs. Correct `DRIVER_PROXY_URL`, or remove it to use Driver's normal Israeli session egress, then restart the local server and reconnect Facebook. Never paste proxy credentials into logs or support messages.
- Approval authorizes only the exact planned post. A changed property, media asset, or generated copy returns it to approval.
- Stop/kill switches continue to apply immediately, including after approval and immediately before clicking Post.
- This mode changes scheduling convenience only; it does not weaken Facebook signals, membership checks, domain handling, or account safety.
