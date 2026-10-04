# Driver spike findings — plan `2026-09-22-driver-listing-import`

The plan's human gates (Tasks 1, 12, 24) are not dispatched to an agent; this
file is where their owner fills in what only a live run against a real
account can prove. Every measurement cell below is **pending — owner** until
someone runs the gate and edits this file. Nothing here is measured by an
agent, and no agent should fill in a cell as if it had.

## G1 — Driver spike (Task 1)

The findings behind the Yad2/Madlan selectors and URLs used from Phase 4
onward, and the login/session behaviour Driver actually shows (session
creation latency, `waitForActive` timing in practice, `409`/`429` frequency
under normal use).

- Yad2 listing page selectors: pending — owner
- Madlan listing page selectors: pending — owner
- Facebook groups-list selectors (`facebook-groups-sync.js` `SELECTORS.groupLink`, `GROUPS_URL`): pending — owner
- Typical session creation → active latency: pending — owner
- Anything Driver does that the plan's [Unverified] assumptions got wrong: pending — owner

## G4 — Cookie persistence (Task 12's connect flow)

Whether a Driver persisted profile (`profileName`, one per phone+platform)
really keeps a Facebook login across days, and what makes it drop.

- Logged in at connect; still logged in after 24 h: pending — owner
- Still logged in after 7 days of no use: pending — owner
- Still logged in after a `posting_profile_gen` bump (revoke/quarantine → reconnect): pending — owner
- Anything that forced a re-login (IP/proxy change, Facebook security check, long idle): pending — owner

## G5 — Posting calibration (Task 24)

Run with `scripts/posting-calibrate.local.js` (never by an agent — a human,
on a throwaway test account and groups/pages they own). See that file's
header for the exact commands (dry run, one live post, a Page post).

**What 48 hours on a throwaway account proves, and what it does not:** the
selectors work, and nothing else. It exercises no group admin, no member
reports, no admin-approval queue, no domain reputation, no account age. The
evidence that matters takes an aged account, real groups, and a month — the
30-day table below.

### Selector table

Every key the calibration script probes at each attempt state (posting-driver
== posting-driver-proof's own SELECTORS, social-dwell's, and
facebook-groups-sync's). "Changed" means the dry run's `not found` forced an
edit to the selector in its source file — the only file to touch is the one
that owns it (`server/posting-driver.js` for the R3/composer set,
`server/social-dwell.js` for dwell, `server/facebook-groups-sync.js` for the
groups list).

| Module | Key | Found on dry run? | Changed? | Notes |
|---|---|---|---|---|
| posting-driver | identity | pending — owner | | |
| posting-driver | targetName | pending — owner | | |
| posting-driver | targetIdMeta | pending — owner | | |
| posting-driver | targetUrlMeta | pending — owner | | |
| posting-driver | joinGroup | pending — owner | | |
| posting-driver | composer | pending — owner | | |
| posting-driver | composerRoot | pending — owner | | |
| posting-driver | editor | pending — owner | | |
| posting-driver | composerTarget | pending — owner | | |
| posting-driver | composerAuthor | pending — owner | | |
| posting-driver | submit | pending — owner | | |
| posting-driver | discard | pending — owner | | |
| posting-driver | dialog | pending — owner | | shared with social-dwell |
| posting-driver | alert | pending — owner | | shared with social-dwell |
| posting-driver | captchaFrame | pending — owner | | shared with social-dwell |
| posting-driver | feedPost | pending — owner | | |
| posting-driver | chronoMarker | pending — owner | | the group feed's newest-first sort marker |
| posting-driver | feedPostText | pending — owner | | |
| posting-driver | feedPostLink | pending — owner | | |
| posting-driver | feedPostAuthor | pending — owner | | |
| posting-driver | postMessage | pending — owner | | on the permalink page |
| posting-driver | postAuthor | pending — owner | | on the permalink page |
| posting-driver | commentBox | pending — owner | | the link-as-first-comment box |
| posting-driver | commentSubmit | pending — owner | | |
| social-dwell | feedPost | pending — owner | | |
| social-dwell | postLink | pending — owner | | |
| social-dwell | author | pending — owner | | |
| social-dwell | video | pending — owner | | |
| social-dwell | sponsoredLabel | pending — owner | | |
| social-dwell | like | pending — owner | | |
| social-dwell | commentBox | pending — owner | | |
| social-dwell | follow | pending — owner | | |
| social-dwell | storyTray | pending — owner | | |
| social-dwell | storyCard | pending — owner | | |
| social-dwell | storyClose | pending — owner | | |
| social-dwell | reactionCount | pending — owner | | |
| social-dwell | commentCount | pending — owner | | |
| social-dwell | dialog | pending — owner | | |
| social-dwell | alert | pending — owner | | |
| social-dwell | captchaFrame | pending — owner | | |
| facebook-groups-sync | groupLink | pending — owner | | |

- Dry runs to a clean pass (three in a row, Step 2 of the task): pending — owner
- CHRONO_PARAM (`sorting_setting=CHRONOLOGICAL`) confirmed to sort the group feed newest-first: pending — owner
- Emoji-in-editor readback (M6: `innerText` may drop an `<img alt>` emoji, failing the R3 copy proof closed): pending — owner

### One live post

- Live post verified in the feed with the link as the first comment: pending — owner (yes/no)
- `post_url` was the post's own permalink, not the group/page URL: pending — owner
- Time to post (session open → `verified_posted`): pending — owner (s)
- `EGRESS_ASN` used: pending — owner
- `POSTING_BROWSER_TYPE` used: pending — owner
- A Page post (`--page`) run the same way: pending — owner

### Thirty-day table

One `standing` campaign per test property, two properties, the same 2–3 real
groups (admins' written permission on file), `repeat: true`, 30 days. Daily,
per Task 24 Step 4's `posting-safety` check and a look at
`facebook.com/accountquality` in a normal browser logged into the test
account:

| day | posts | max/day | gaps ok | halts | accountquality | admin removed | notes |
|---|---|---|---|---|---|---|---|
| 1 | pending — owner | | | | | | |
| 2 | pending — owner | | | | | | |
| … | pending — owner | | | | | | |
| 30 | pending — owner | | | | | | |

### Decision (Task 24 Step 5 — only ever downward)

- DEFAULTS kept as-is / lowered to: pending — owner
- Go / no-go for real agents, signed by: pending — owner

## Deploy commands (from the SDD ledger's `Deploy note:` lines)

Collected from `.superpowers/sdd/2026-09-22-driver-listing-import/progress.md`,
in the order they were added. None of these has been run by an agent; they
are the owner's to run before or during merge.

1. **F1/F2 — env vars.** Add to `/root/forly-backend/deploy.env` before merge
   (F2 gates every Driver feature on both being present):
   ```
   FORLY_ENV=prod
   PROFILE_KEY=<openssl rand -hex 32>
   ```

2. **Task 16a — indexes and a TTL.**
   ```bash
   firebase deploy --only firestore:indexes
   gcloud firestore fields ttls update expire_at --collection-group=dwell_sessions --enable-ttl
   ```
   (`campaigns`/`jobs` `expire_at` TTLs are covered again, more completely, by
   Task 21 below.)

3. **Task 21 — more indexes, four TTL policies, an owner allowlist.**
   ```bash
   firebase deploy --only firestore:indexes
   gcloud firestore fields ttls update expire_at --collection-group=posting_campaigns --enable-ttl
   gcloud firestore fields ttls update expire_at --collection-group=extract_jobs --enable-ttl
   gcloud firestore fields ttls update expire_at --collection-group=dwell_sessions --enable-ttl
   gcloud firestore fields ttls update expire_at --collection-group=audit_events --enable-ttl
   ```
   Two collection-group indexes for the admin overview's disabled-account
   queries (`connections` on `posting_disabled_until_admin` and on
   `posting_owner_review_required`) are included in the `firebase deploy`
   above via `firestore.indexes.json`; if that file's overrides are ever
   applied by hand instead:
   ```bash
   gcloud firestore indexes fields update posting_disabled_until_admin --collection-group=connections --index=order=ascending,query-scope=collection-group
   gcloud firestore indexes fields update posting_owner_review_required --collection-group=connections --index=order=ascending,query-scope=collection-group
   ```
   Also set in `deploy.env`: `POSTING_OWNER_PHONES=<comma-separated phones>`
   (owner re-enable and the admin overview's `is_owner` both fail closed
   without it — `403 owner_not_configured`).

4. **Task 22 — three more TTLs, a proxy-hop var.**
   ```bash
   gcloud firestore fields ttls update expire_at --collection-group=click_ids --enable-ttl
   gcloud firestore fields ttls update expire_at --collection-group=attribution_refs --enable-ttl
   gcloud firestore fields ttls update expire_at --collection-group=click_visits --enable-ttl
   ```
   `POSTING_PROXY_HOPS` (default `1`) in `deploy.env` — the owner confirms the
   real proxy topology (how many hops sit between the visitor and the app)
   before trusting anything past `visitorIp`'s default.

Every `gcloud firestore fields ttls update` command needs `--project=<project>`
if it is not already the active gcloud project. TTL only deletes documents
whose `expire_at` is a Timestamp — a `null` `expire_at` (e.g. a `repeat: true`
campaign still running) is never touched by it.
