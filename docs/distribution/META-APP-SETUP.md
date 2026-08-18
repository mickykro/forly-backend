# Meta App Setup — Forly Content Distribution

The auto-post feature publishes through a Meta app owned by Forly. One app
serves every agent; each agent grants it access to their own Page via
"Log in with Facebook". This checklist takes the app from nothing to live.

## 0. Prerequisites (start these first — longest lead time)

- A personal Facebook account for whoever creates the app.
- A **Meta Business Portfolio** for Forly (business.facebook.com). App Review
  for publishing permissions requires the app to belong to a **verified
  business** — verification (company registration docs, domain/phone check)
  takes days to ~2 weeks in Israel. Start immediately.

## 1. Create the app

1. developers.facebook.com → register as developer (one-time).
2. My Apps → **Create App** → choose the Business / "Manage everything on
   your Page" use case (the one that mentions Pages publishing — not
   Consumer/Gaming).
3. Name: **Forly Publisher** (agents see this on the consent screen).
4. Attach to the Forly business portfolio.

## 2. Configure

1. Add the **Facebook Login for Business** product. Valid OAuth Redirect URI:
   `https://<host>/api/distribution/oauth/callback` (must equal
   `META_REDIRECT_URL` exactly).
2. App settings → Basic: app icon, **Privacy Policy URL**, **Data Deletion
   instructions URL** (a page on the site explaining how an agent disconnects).
   Review is refused without both.
3. Copy **App ID / App Secret** → server `.env` (`META_APP_ID`,
   `META_APP_SECRET`). The secret never enters the repo.

## 3. Permissions used by the server

`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
`instagram_basic`, `instagram_content_publish` — exactly the list in
`server/distribution/meta.js SCOPES`. Nothing else.

## 4. Dev Mode — the pilot path (no review needed)

While the app is in **Development Mode** it can post to Pages of anyone
holding a role on the app:

1. App Roles → add yourself + pilot agents as **Testers** (they accept at
   developers.facebook.com).
2. Sanity-check in **Graph API Explorer**: select the app, grant the five
   scopes, `GET /me/accounts` → pick the page token →
   `POST /{page-id}/feed?message=test`. If that works, the whole server flow
   works.
3. Instagram in Dev Mode additionally needs the IG account to be a
   **Business account linked to the Facebook Page** (Page settings → Linked
   accounts).

## 5. App Review — before non-tester agents can connect

1. Business Verification must be complete (step 0).
2. App Review → Permissions and Features → request **Advanced Access** for
   the five permissions above.
3. Per permission: a use-case text ("Real-estate agents on Forly connect
   their business Page and approve publishing their property listings to
   it") + a **screencast** of the real flow — dashboard → connect → consent →
   one-tap confirm → the post appearing. Record it against the pilot build.
4. Typical turnaround: days to ~2 weeks. Rejections usually cite an unclear
   screencast — show the full flow end to end.
5. On approval, switch the app to **Live Mode**.

## 6. Token model (what the server stores, for the curious)

OAuth code → short-lived user token → long-lived user token (~60 days) →
per-Page token (does not expire while the user token was long-lived). All
stored per agent in `businesses/{phone}/connections/facebook` — data, not
config. A Graph error 190/OAuthException flips `needs_reconnect`; the agent
reconnects from the dashboard and everything resumes.

## 7. Manual end-to-end verification (Dev Mode) — run after each phase ships

### 7.0 Testing locally BEFORE any merge/deploy (the tunnel path)

Nothing needs to reach main to test: a Meta app accepts multiple Valid
OAuth Redirect URIs, so a temporary tunnel URL can sit next to the future
production one.

1. Check out the feature branch locally; `cd server`.
2. `server/.env` needs: `META_APP_ID`, `META_APP_SECRET`,
   `NADLAN_JWT_SECRET` (any non-default string — auth is disabled without
   it), real `GREENAPI_INSTANCE`/`GREENAPI_TOKEN` (so the confirm link and
   share kit actually reach your phone), and
   `GOOGLE_APPLICATION_CREDENTIALS` pointing at the service-account JSON —
   entitlement lives on `businesses/{phone}`, so the flow needs real
   Firestore; use YOUR OWN phone's business as the only entitled test agent.
3. Terminal 1: `npm run tunnel` → prints `https://<name>.trycloudflare.com`.
4. Meta app → Facebook Login for Business → Settings → ADD
   `https://<name>.trycloudflare.com/api/distribution/oauth/callback` to the
   Valid OAuth Redirect URIs (keep the production URI listed too).
5. Terminal 2 — the three URLs must all be the tunnel, or links point at
   localhost:

   ```
   BASE_URL=https://<name>.trycloudflare.com \
   PAGE_BASE_URL=https://<name>.trycloudflare.com \
   META_REDIRECT_URL=https://<name>.trycloudflare.com/api/distribution/oauth/callback \
   node index.js
   ```
6. Open `https://<name>.trycloudflare.com/distribution.html`, log in with
   the WhatsApp OTP, and run checklist §7 below. Posts go to your own test
   Page (Dev Mode + Tester role — no real agent is affected).
7. Each quick-tunnel run prints a NEW hostname (and trycloudflare URLs are
   not guaranteed past ~a day), so for anything beyond a single session use
   a STABLE tunnel instead: ngrok's free static domain (dashboard → Domains
   → claim one, `ngrok config add-authtoken <token>` once, then
   `ngrok http --domain=<yours>.ngrok-free.app 8787`). Register that URL's
   callback in the Meta app once and it stays valid across restarts. Remove
   tunnel URIs from the Meta app when testing ends.

Once the tunnel run is clean, merge/deploy and the production URI —
already registered — works with zero further Meta changes.

### 7.1 The checklist

Setup: `.env` with real `META_APP_ID/SECRET`, `META_REDIRECT_URL` through a
`npm run tunnel` URL, GreenAPI creds, and a test business with
`features.distribution: true` (flip via the admin panel).

1. Dashboard → הפצה → connect Facebook → consent → "החיבור הושלם" card;
   `/api/distribution/status` shows `connected: true` + the page name.
2. Save 5 group links; malformed ones come back stripped.
3. Create a property (intake flow) → WhatsApp confirm arrives → tap →
   "אושר!" card → within ~60s: post on the Page, share-kit WhatsApp,
   summary WhatsApp with the post link.
4. Tap the confirm link again → "הנכס כבר פורסם" card, NO second post.
5. Dashboard publish on the same property → repost dialog → confirm →
   second post, audited as `reposted`.
6. Firestore: the `distributions` doc is `done` with the post id;
   `post_actions` has `published` + `share_kit_sent` (+ `reposted`).
7. De-authorize the app (Facebook → Settings → Business integrations →
   remove) → publish again → job fails, `needs_reconnect` flips, ONE
   reconnect WhatsApp arrives; reconnect from the dashboard and republish.
8. (Day 5+) With a linked IG Business account: publish → reel/carousel
   appears on Instagram, summary includes the permalink.
