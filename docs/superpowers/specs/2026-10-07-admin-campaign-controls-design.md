# Admin campaign controls: create, edit, stop, start

Status: approved design, 2026-10-07. Independent of `2026-10-07-driver-shared-profiles-design.md`; either can ship first.

## 1. Why

Agents can create, edit, pause, stop and resume their own campaigns (`server/routes/posting.js`, `server/routes/posting-listing-groups.js`). Admins can only resume a campaign paused by an internal error (`server/routes/admin-posting.js:382`) and see running campaigns in the manual posting tab. The team needs to run campaigns for agents directly.

## 2. Decisions

| Question | Decision |
|---|---|
| Consent when an admin creates | The admin records it: who agreed, how (phone, in person, WhatsApp), a required note. Stored on the campaign and the posting permission, with an audit row. The campaign starts at once. |
| What can be edited | Everything except the property: groups (add and remove), per-group texts, end date, repeat, targets, mode. |
| Where | A new "קמפיינים" tab in the admin panel. |
| Agent notifications | WhatsApp on create and on stop by admin. Edits and starts are silent. |

## 3. Components

- `server/routes/admin-campaigns.js` mounted at `/api/admin/campaigns` (next to admin-posting in `server/index.js`).
- `public-agent/admin-campaigns.js` and a tab in `public-agent/admin.html`.
- `server/posting-campaign-admin.js`: `update(id, edit, deps, { version, by })` (adds and removes groups, texts, end date, repeat, targets, mode in one transaction); `server/routes/posting-create.js`: the create checks shared with the agent API. Existing `create`, `addGroups`, `stop`, `resume` reused.
- `server/posting-messages.js`: two new texts (created by the team, stopped by the team).

## 4. API

All mutations: `requireAdmin` + `requireStepUp` (the same guard as account re-enable), and an `audit_events` row: action, admin, campaign id ending, changed field names. Never texts, never the full phone.
- Audit rows store digits-only phone tails (the audit store requires 0–4 digits); the consent's `admin_tail` is digits-only too.
- `say()` sends `admin_created` and `admin_stopped` also when `POSTING_MANUAL=1` (it drops other kinds there); an admin stop sends `admin_stopped` instead of the agent's `stopped`.

| Method | Path | Notes |
|---|---|---|
| GET | `/campaigns?status=&agent=` | `requireAdmin` only. Rows: agent name and phone ending, property, status and pause reason, groups owed/posted/skipped, `expires_at`, repeat, targets, mode, `created_by`, `version`. |
| GET | `/agents` and `/agents/:ref/properties` | Agent picker and that agent's pages (opaque ref, as admin-manual). |
| GET | `/agents/:ref/groups` | The agent's member groups, vetted as in the agent flow. |
| POST | `/campaigns` | Create. Body: agent ref, page id, group ids, copies, days, repeat_days, targets, mode, `consent: { method, note }`. |
| PATCH | `/campaigns/:id` | Edit. Body: `version` plus any of: add/remove group ids, copies, days, repeat_days, targets, mode. |
| POST | `/campaigns/:id/stop` | `campaigns.stop(id, deps, "admin")`. |
| POST | `/campaigns/:id/start` | Paused → `resume`. Stopped/completed → restart through `create` with a fresh admin-recorded consent (body carries `consent`). |

## 5. Rules

**Create**
- Same checks as the agent flow: Facebook connected (`facebook_browser_connected_at`), the page belongs to the agent, Page confirmed and Page id read when the Page is a target, groups vetted (`vetGroups`).
- `consent = { by: "admin", admin: <operator id>, method, note, at, version: CONSENT_VERSION }`. Note required (1–300 chars). Posting permission recorded the same way when none is in force.
- An existing running/paused campaign for the same agent+property is returned unchanged with `existing: true` (200), as the agent API does; the tab then offers it for editing.
- `consent.admin_tail` is digits-only.
- `created_by: "admin"`.

**Edit**
- Every edit runs in `store.mutatePostingCampaign` and carries the `version` the admin loaded. A different stored version → `409 stale_version`.
- Remove groups: owed posts for those groups are dropped; posted and skipped history stays. If an attempt for a removed group is in progress (reserved, session started, composer ready) → `409 busy`, nothing changed.
- Texts: same validation as the agent texts screen (string, at most `MAX_COPY`, at most 60).
- End date 1–30 days from now; repeat 3–30 days or off (existing limits).
- Targets and mode re-checked against the connection, as on create.
- PATCH requires a non-empty `version` (400 otherwise).
- Editing sends end date, repeat, mode and targets only when the admin changed them; `days` on PATCH means "end N days from now".
- `last_changed_by: { by: "admin"|"agent", at }` written on every change by either side.

**Stop / start**
- Stop cancels open posts as today.
- Restarting a stopped or completed campaign reuses its stored groups as they are (not re-vetted) — a decision by the owner — and asks the admin for the consent method and note.
- Start refuses with `409 account_halted` when the account is disabled or under owner review; the tab links to the existing re-enable control. Starting a campaign never lifts an account halt.

## 6. Interactions

- Prod (`POSTING_MANUAL=1`): admin campaigns appear in the manual posting list like any other.
- Local: automated posting picks them up on local's own data.
- Profiles spec: campaigns refer to agents by phone; profile names come from the resolver. No dependency.
- The agent keeps full control of their campaign in their own screens.

## 7. Errors

`invalid_input`, `not_found`, `facebook_not_connected`, `page_not_confirmed`, `page_target_unavailable`, `consent_note_required`, `stale_version`, `busy`, `account_halted`, `step_up_required`. Each has a Hebrew message in the tab.

## 8. Tests

- Create: consent missing or empty note refused; other agent's page refused; not connected refused; existing campaign edited, not duplicated; consent and permission stored with `by: "admin"`; WhatsApp sent.
- Edit: add and remove groups; remove keeps history; remove during an in-progress attempt → busy; stale version refused; text too long refused; end date and repeat bounds; targets re-checked.
- Stop/start: stop cancels open posts and sends WhatsApp; start a paused campaign; restart a stopped one keeps history; halted account refused; no WhatsApp on edit or start.
- Security: every mutation needs step-up; audit row has no phone or text.
- UI: DOM test for the tab (list, create form, edit, stop/start, error messages).
