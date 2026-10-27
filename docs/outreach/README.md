# Reviewed outreach demos (v1)

This feature builds private outreach demos from listings automatically discovered in the authorized operator’s joined real-estate groups, or from an optional supplied post URL. It is disabled by default. Group scanning is read-only; it does not join groups, post, or automate Messenger. The optional opt-in Messenger phase remains a separate, unimplemented pilot requiring its own approval and credentials.

## Runtime and deployment decision

The Node/Express service is the only outreach runtime. Separate `outreach_*` Firestore collections keep candidates, previews, source media, delivery records and jobs out of ordinary agent listings. Firebase's Nadlan host redirects to the Node-backed branded domain; obsolete rewrites to unexported legacy Functions have been removed. Carousel Functions remain unchanged.

Code inspection confirms the Node Docker service owns the existing page builder, overlay and admin integration. This change does not inspect or modify deployed revisions, credentials, n8n workflows, DNS, IAM or production data. Before activation, the operator must confirm routing reaches that Node revision and use a distinct staging project, bucket, credentials and webhook. The source plan's legal/design/policy reviews are release prerequisites, not approvals asserted by this PR. The implemented acquisition scope includes user-requested automatic group discovery, gated separately from the original supplied-URL intake.

## Configuration

Set independent random secrets (at least 32 characters):

- `CALLBACK_HMAC_SECRET`: purpose-specific n8n/render/worker callback signing key. Required at production boot (`NODE_ENV=production` or `FORLY_ENV=prod`), even while outreach is off. Update existing n8n page/overlay callers before deploying this callback hardening.
- `OUTREACH_HMAC_SECRET`: outreach identities, token lookup and OTP hashing; must differ from session and callback keys. Retain it while previews/records exist.
- `OUTREACH_ENABLED=true` enables candidate mutations; `OUTREACH_POLICY_APPROVED=true` additionally attests the operator has approved acquisition, rights-to-use, factual accuracy, manual delivery copy, retention and removal handling.
- `BASE_URL=https://...`: canonical reachable Node origin. `OUTREACH_PRIVATE_DIR`: persistent private volume outside public uploads. Every replica must use the same mounted private filesystem; this adapter intentionally does not issue public bucket download tokens. Do not use multiple replicas with separate local disks. A future object adapter must preserve the same gated-media contract.
- `OUTREACH_OPERATOR_PHONE`: dedicated, authorized operator account connected through the existing controlled browser flow. Never use a prospect's phone or an unrelated agent session. Supplied-post extraction has a daily admission cap of 10, concurrency 1.
- `OUTREACH_GROUP_SCAN_ENABLED=true`: opt in to automatic discovery from that operator’s joined real-estate groups. Each round reads at most three groups and 20 posts, and parses at most five top-ranked qualifying candidates. A protected campaign cursor rotates subsequent rounds through the other eligible groups. Default scan admission is three rounds/day, concurrency one. Canonical-source deduplication prevents a post from repeatedly consuming parse budget across campaigns. Replays reuse their durable scan; uncertain outcomes are not blindly retried.
- `OUTREACH_N8N_WEBHOOK_URL=https://...`: optional dedicated workflow accepting the contract in `render-contract.md`. Without it, photo-first previews still work and no generated video is claimed.
- `CALLBACK_MAX_DAILY` (default 100), `CALLBACK_MAX_CONCURRENT` (default 2): global durable render admission caps. Scheduler ticks have a separate 2,880/day budget, and private source-image reads a separate 500/day budget. Replay records remain after lease release; ambiguous requests are not automatically repeated.
- Staging requires declared `OUTREACH_FIREBASE_PROJECT` and `OUTREACH_PRODUCTION_PROJECT`, and the actual service-account project must match staging and differ from production.
- Existing Green API credentials deliver claim OTPs. No general business account or session is created by OTP verification.

Public source images and clean renders are copied into the private manifest directory. Public previews can fetch only their attached website images and watermarked video through a token-gated, non-cacheable route. Never configure this directory under `/files` or any other static mount. Shared filesystem backup and restore must preserve the manifest/file relationship.

## Operator flow

Open **Outreach** in `/admin.html`. All mutations require an allowlisted admin and a fresh OTP step-up.

1. Click **Scan groups**. The system discovers joined real-estate groups in Driver, reads bounded feed posts and ranks property offers using their actual description and photos. Suitable posts become candidates automatically; no post URL selection is required. Live scan results report actual groups/posts, selected candidates, duplicates and rejection reasons. Optional single-post intake remains available.
2. Inspect the automatically selected candidates, or inspect a failed/unknown scan without retrying an ambiguous paid action. Extracted facts/photos are private; review their accuracy and permission evidence explicitly.
3. Approve and build a photo-first preview. Activation lasts exactly 604,800,000 ms; the displayed expiry is an absolute timestamp. A separate asynchronous video job can attach only the versioned central-watermark rendition while the preview remains active.
4. Approve the delivery copy, sender, channel and permitted recipient. Only then retrieve the delivery kit. Send manually in an authorized external workflow; record actual sent time and confirmation evidence. This creates `manual_sent_confirmed`, never a fabricated delivery/read receipt. Suppression takes effect before kit access and confirmation.
5. A prospect requests an OTP from the preview claim screen. Successful verification only requests ownership review. An admin must verify the relationship to the listing, then reconcile an external payment reference and note, then perform the idempotent upgrade.
6. The stable preview link redirects to a normal paid page. Clean media is served only after the final audited `upgraded` state and while that paid page is active. Public/portfolio visibility and distribution remain opt-in; payment grants no Facebook authority.

## Browser session cost control

The login viewer has an explicit **Stop browser** control. It calls the authenticated close endpoint, stops the owner’s recorded Driver session, and keeps the saved Facebook profile/login. The UI reports success only after Driver confirms shutdown; an unconfirmed stop keeps the record, budget and retry control. Stopping does not disconnect the account or delete its saved profile.

## Durable lifecycle and retention

Configure an external scheduler to POST `{}` to `/api/internal/outreach/tick`, signed using purpose `worker` (see render contract), at least once a minute. Alternatively, an always-on Node container can set `OUTREACH_WORKER=1` to poll durable, leased Firestore jobs every 30 seconds. State survives process restarts. A failed/unknown webhook is reconciled by a human; it must not be blindly retried.

Every request independently enforces exact preview expiry, so scheduler delays never extend public media access. Expiry queues purge after 30 days. Purge removes owned source/derivative bytes, manifest records, token mapping and delivery copy, preserving minimal lead/demo tombstones and hashed audit rows. Suppression hashes persist to honor future do-not-contact requests. Paid assets remain owned by the converted listing rather than being purged as unpaid demos.

Deploy `firestore.indexes.json` before enabling workers. Configure Firestore TTL on `outreach_callback_limits.expire_at` and short-lived challenge records where supported; TTL is cleanup, not the access gate. Monitor oldest queued/due job, stale leases, build/OTP failure, callback rejection, purge errors and conversion/suppression volume. Audit and payment records need the team's approved access/retention policy. Operators must exercise expiry, removal, failed render, suppression and payment upgrade on staging before any external pilot.

## Validation and release limits

`npm --prefix server run test:outreach` also covers automatic feed discovery, bounded ranking, campaign rotation, source deduplication and no-retry scan outcomes, plus the new domain, transactional adapter, exact expiry, due jobs/purge, manual-send races, suppression, OTP claims, paid upgrade gates, route isolation, source downloads and a real ffmpeg central watermark check. The existing Server tests workflow now installs ffmpeg/Hebrew fonts and runs both outreach and the full existing backend suite; a separate workflow runs the real Firestore emulator.

The local broad suite has pre-existing failures at `facebook-groups-sync.test.js:104` (`3 == 6`) and `posting-attribution.test.js:103` (`200 == 302`), both reproduced without these changes from original starting commit `40e9f28` and updated PR base `eba4e96`. The updated base run passed 103 of 105 existing test files; all 44 standard outreach checks and both real emulator checks passed. They must be resolved separately before treating the entire repository CI as green. Both real Firestore emulator tests passed locally against an isolated demo project, and are registered in a separate CI job. They skip in the ordinary suite when no emulator is running. Deployed n8n end-to-end, Docker image execution and an external pilot have not been certified by local unit tests.

No production rollout or PR merge is part of this implementation.
