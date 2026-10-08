# Driver profiles: one saved login per agent, shared by staging and prod

Status: approved design, 2026-10-07. Implementation plan: `docs/superpowers/plans/2026-10-07-driver-shared-profiles.md` (to be written).

## 1. Why

Facts found in the code and in Driver's dashboard:

- **Names are computed, never stored.** `server/profile-name.js` builds `<platform>-<FORLY_ENV>-<HMAC(phone, PROFILE_KEY)[0:20]>[-rN]` on every open.
- **Staging and prod open different profiles for the same agent.** Staging serves real agents and shares prod's Firestore (`call4li`). An agent who logged in through staging sits in `facebook-staging-<hash>`; prod opens the empty `facebook-prod-<hash>` and lands on the login screen.
- **All servers share one `PROFILE_KEY`.** Driver shows the same hash under prod, staging and local. The deploy notes require the opposite.
- **"Connected" depends on the agent pressing "done".** `<platform>_browser_connected_at` is written only by `/finish`. An agent who logs in and closes the window is logged in at Driver and "not connected" in Forly.
- **The profile lock is in-process** (`server/profile-lock.js`). Nothing stops two servers from opening one profile.
- **The local box acts on everyone.** Prod runs `POSTING_MANUAL=1`, so its sweeper returns at once (`posting-sweeper.js:191`). The local box runs the only live sweeper (`POSTING_SWEEPER=1`, `POSTING_LOCAL_TEST=1`), and every sweep step (ticks, warm-up, sync, reconcile, recheck, profile-delete retries) covers all agents in the shared Firestore.
- **Profile deletes after a disconnect leak today.** Pending delete rows store only a gen (`db.js:401`); the retrying server (local) rebuilds `facebook-local-…`, gets a 404, counts it as success (`driver-browser.js` `deleteProfile`), and clears the row. The real prod or staging profile keeps its cookies.
- **The admin manual browser bypasses the rules.** It runs 60 minutes (`admin-manual.js` `SESSION_S=3600`) on a 20-minute in-process lock, calls `createSession` directly (no login-open check, no budget slot, no ownership check), and `forly-manual:` is missing from `ORPHAN_NOTES` (`index.js:282`).
- **Link-reading jobs have no claim** (`extract-jobs.js`): every server can run the same queued job. Jobs for instagram/tiktok/linkedin/x always fail because `platform: "facebook"` is hard-coded (`extract-jobs.js:112`).

## 2. Goals and non-goals

Goals:
1. One saved login per agent per platform (facebook, yad2, madlan), used by prod and staging alike.
2. A readable profile name that identifies the agent.
3. Never two browsers on one profile at once, across servers.
4. "Connected" decided by the server's own read, never by an agent's click.
5. Agents logged in today keep their login.
6. The local box never touches real agents.

Non-goals:
- Automated posting on prod. Prod stays `POSTING_MANUAL=1`; automated posting is tested on local only.
- Profiles for instagram/tiktok/linkedin/x. Nobody can connect them; their extract jobs run without a profile.
- Automatic deletion of old profiles beyond what section 7 deletes after adoption.

## 3. Environments

| Server | Firestore project | Driver account | Opens agent profiles for |
|---|---|---|---|
| prod (`FORLY_ENV=prod`) | `call4li` | shared prod/staging account | login, admin manual posting, checks |
| staging (`FORLY_ENV=staging`) | `call4li` | same | login, checks |
| local (`FORLY_ENV=local`) | `forly-dev` (copy of `call4li`) | its own account | automated posting tests on its own data |

Local is fully separate: its own database, its own Driver key, its own GreenAPI instance (or none). The shared-profile machinery (lease, registry) is shared by prod and staging only.

## 4. Phase 0: local gets its own data

Done by the owner (2026-10-07): `forly-dev` created, prod exported to `gs://call4li-firestore-exports/2026-10-07/` and imported into `forly-dev`.

To build:
1. **`scripts/dev-db-clean.local.js`** — refuses to run unless the credentials' `project_id` is `forly-dev` (never `call4li`). `--keep <phone>` (repeatable) and `--dry-run`. For every phone not kept: clears `*_browser_connected_at`, `browser_session_*`, `*_profile_*`, pauses running/paused campaigns. For everyone: empties `profile_deletes`, blanks sealed Meta tokens. Prints counts; writes nothing in dry-run.
2. **Boot guard** in `server/index.js`, reading `project_id` from the key file: `FORLY_ENV=local` refuses to start unless `project_id === FORLY_DEV_PROJECT` and it is not `call4li`; `FORLY_ENV=prod|staging` refuses to start on `forly-dev`. Names come from env (`FORLY_PROD_PROJECT=call4li`), not hard-coded beyond a default.
3. **Runbook** `docs/dev-database.md`: export, grant (`objectViewer` + `legacyBucketReader` for `forly-dev`'s Firestore agent), import, revoke, deploy indexes/rules, clean. Notes: zsh needs `setopt interactivecomments`; exports hold personal data, delete old ones.

## 5. Fixes that stand on their own (phases 1–2)

**Phase 1 — delete leak.**
- `profile_deletes` rows store `name` (the exact Driver profile name). Retries use the stored name; a row without a name is not retried against a rebuilt name.
- Repair script for existing rows: for each row, record every candidate legacy name (`<platform>-{prod,staging}-<hash>[-rN]`) and delete each; clear the row only when all report deleted or not found.
- Retries run only on prod (the sweeper step moves out of the local-only sweep, into a prod-side daily job).

**Phase 2 — admin manual browser and job claims.**
- The manual browser goes through the same path as every other browser: ownership check, login-open check, budget slot, lock held for the whole session (see section 6 for the lease).
- Add `forly-manual:` to `ORPHAN_NOTES`.
- Extract jobs are claimed in a Firestore transaction (`queued` → `running` with `claimed_by`). Profiles only for facebook/yad2/madlan with the job's real platform; other social hosts run without a profile.

## 6. Shared lease (phase 4)

- Document `driver_profile_locks/{profileName}`: `{ holder: "<env>:<bootId>:<token>", kind, expires_at, created_at }`.
- Taken inside `createSession` whenever a profile is present (that is where every browser starts, including the ~11 `lockHeld: true` call sites), and in `attemptDelete`. The in-process lock stays as a cheap pre-check.
- Transaction: take if missing or `expires_at` ≤ the transaction's read time (Firestore clock, not `Date.now()`). Otherwise `profile_busy`.
- `expires_at = now + session duration + 2 minutes`. Driver ends the browser at its duration, so a lease never ends before its browser. No renewal needed.
- Release: delete only if `holder` matches. On boot, after `cleanupOrphans` succeeds, delete leases held by this environment with an older boot id.
- Firestore unavailable → no browser (fail closed).
- `attachPage` to an existing login session does not take a new lease; the login's own lease covers it.

## 7. Stored names and the registry (phase 5)

- Connection fields per platform: `<platform>_profile_name` (current), `<platform>_profile_names` (history: every name this connection ever used, with gen and `proxy_id`).
- Registry `driver_profile_names/{name}`: `{ phone, platform, gen, proxy_id, created_at, created_by }`. Written in a transaction together with the connection field, only if the field is absent. Never released or reused.
- New name: `<platform>-<slug>`, reset `-r<gen>` appended to the stored base. Slug, first that works:
  1. the agent's current portfolio slug, snapshotted once;
  2. transliterated full name, then business name;
  3. `agent-<last 4 digits of phone>`.

  Sanitised: `[a-z0-9-]`, at most 40 characters before suffixes, never all digits, never containing 7+ consecutive phone digits. Collision → `-2`, `-3`.
- One resolver `profileFor(phone, platform)` used by every path (manual posting, automated posting on local, sync, extract, listing sweep, login, checks): stored name → registry points back to this phone → state not revoked/quarantined → else refuse.
- `proxy_id` per registry entry replaces `proxyFor(phone)`'s per-call HMAC; every open of that name uses it.
- Revoke/quarantine deletes every name in the history (through the pending-delete rows of section 5).
- Log redaction covers registered names (`driver-browser.js` `redact`).
- Behind `DRIVER_SHARED_PROFILES=1`; off → current behaviour.

## 8. Server-decided "connected" (phase 3)

- `browser_session_<platform>` gains `{ server, boot_id }`. Only the owning server checks it.
- Owner polls every ~5 s through its own CDP attach (the viewer hub may not exist): read-only — page URL off Facebook's login/checkpoint/two-step paths and a `c_user` cookie in `context.cookies()`. No click, type or navigation.
- On a hit: stop the login session, close the viewer (as `/finish` does), then run the full `readLogin` in a short `withPage` of its own and write `connected_at` only if it read the agent's name. Single-flight with `/finish` (a per-phone in-process flag).
- One minute before the login session's duration ends: final read-only check, then the same flow or a stop.
- After a restart: logins recorded open by this environment, not connected, whose session is confirmed stopped → one saved-login check (`login-verify.js`).
- Facebook only. Yad2/Madlan keep "done" and ✕ (both already run the check).
- Back off 30 s after a negative full check.

## 9. Adoption of today's logins (phase 6)

- Admin-triggered, rate-limited backfill (one agent at a time, at most N per hour), never lazy from a tick or job.
- Candidates per connected agent: `<platform>-prod-<hash>[-rN]` and `<platform>-staging-<hash>[-rN]`.
- Each candidate checked in a short browser under the lease. Prefer the candidate whose read identity equals the stored `<platform>_identity_label`; else the first logged-in.
- Winner: registered and stored as `profile_name`, gen unchanged. Losers: registered under the phone and queued for deletion.
- Neither logged in on two positive login-wall reads: new name and `connected_at` cleared with "needs reconnect". Any infra error (503, proxy, timeout): nothing written, retried later.

## 10. Admin profile picker (phase 7)

- Manual tab: a dropdown of profiles — the registry, plus Driver's profile list if Driver exposes one (unverified; only `DELETE /v1/browser/profiles/{name}` is known) — showing name, owner (agent name and phone ending, or "not assigned"), Forly status, last used.
- Open: same path as the manual browser (section 5), refusing revoked, quarantined, pending-delete and unregistered names.
- Assign: only for names not owned by any phone (legacy leftovers). Writes registry + connection in one transaction, clears identity label, Pages and groups so the next check reads them fresh.
- Both require step-up (`requireStepUp`, as admin-posting) and write an `audit_events` row without the phone.

## 11. Rollout (phase 8)

- `DRIVER_SHARED_PROFILES` turned on only after both prod and staging run the new code. Boot writes `driver_schema_version` per environment to a settings doc; with the flag on, a server refuses Driver work if the other shared environment reports an older version.
- Update `.github/workflows/deploy-staging.yml` and `deploy-server.yml` notes: prod and staging share Driver account, `PROFILE_KEY` and proxy template; local has its own of each.
- Phases 0–3 ship without the flag.

## 12. Error handling

| Situation | Behaviour |
|---|---|
| Lease held by another server | `profile_busy` (existing paths) |
| Firestore unavailable on lease/registry | no browser |
| Registry says another phone | refuse, log without name/phone |
| Name collision | next suffix in the same transaction |
| Adoption infra error | nothing written, retried |
| Detection check throws | ignored; next poll; done/✕ still work |
| Revoked/quarantined/pending-delete | refused |

## 13. Tests

- Clean script: refuses `call4li`; dry-run writes nothing; kept phone untouched.
- Boot guard: each wrong project/env pair refuses.
- Delete leak: stored name used; repair deletes every candidate; 404 on one name does not clear others.
- Manual browser: login open → refused; lease held whole session; orphan cleanup includes it.
- Extract claim: two servers, one job → one run; non-profile platforms run without a profile.
- Lease: race; expiry by Firestore time; holder-only release; boot reclaim; Firestore down.
- Names: slug order and sanitising; rename does not move the name; collision; never reused; history and `proxy_id`.
- Detection: logs in without done; closes mid-login; timeout check; restart check; never "connected" without a name read; single-flight with `/finish`.
- Adoption: identity match wins; first logged-in; neither; infra error writes nothing; losers queued for deletion.
- Picker: step-up required; assign only unowned; audit row.
- Existing suite stays green (39 assertions hard-code env names and are updated with the flag on/off split).

## 14. Risks

1. The 5-second read uses the agent's live page. Read-only, untested on a real login.
2. `c_user` is undocumented by Facebook; it only triggers the full check.
3. Adoption costs up to 2 short Driver sessions per existing agent, once.
4. The shared `PROFILE_KEY` reverses the deploy notes' isolation rule for prod and staging; local leaves the shared set.
5. Driver's concurrency limit is per account: prod and staging split it with fixed `DRIVER_MAX_CONCURRENT` values that sum to the plan limit.

## 15. Branch status

- `47408b9` (agent name in the profile name): reverted by phase 5.
- `5f56073` (✕ runs the check, saved-login check, admin unconnected list, stale "needs reconnect" fix): kept; phase 3 builds on it.
