# Agency Support — Design

**Date:** 2026-09-04
**Status:** Approved in session (approach 1 + mirror pages). Implementation gated on plan approval.
**Repo:** forly-backend (Express server + Firestore + `public-agent` static UI).

## 1. Goal

Sell Forly plans to real-estate agencies instead of single agents. An agency
owner pays once for N seats, gets read-only visibility over every member's
listings, leads and usage, sets brand assets once, and members can market each
other's listings under their own name.

## 2. Decisions (confirmed by product owner)

| Topic | Decision |
|---|---|
| Owner scope | Billing + read-only visibility (option B). No editing of members' pages, no listing reassignment, no shared quota pool. |
| Sharing model | Mirror page: member B gets their own property page for A's listing, with B's identity and contact. Leads from it go to B. Content follows A's edits. |
| Shareability | Agency pool by default. Every member listing is visible to all members; the owning agent can mark a listing `agency_private`. |
| Membership | Three paths: owner adds by phone, owner-generated invite link accepted by a logged-in agent, admin panel assignment. Owner and admin can remove. |
| Owner identity | The owner is a normal agent business with role `owner` in the agency. Counts as a seat. |
| Quota | Stays per agent (`businesses/{phone}/quota`). Agency plan defines per-seat caps; no pooling. |
| Brand | Agency `brand` fields are defaults. An agent's own logo / colors win when set. |
| Billing | No payment integration exists. Agency plan and seat count are set from the admin panel, same as feature flags today. |

## 3. Data model

New collection `agencies/{agencyId}` (agencyId = short random id):

```
name, owner_phone, plan ("agency_trial" | "agency"), seats (number),
brand: { logo_url, brand_colors[], slogan },
features: { chatbot, portfolio, distribution },   // seat defaults, applied on join
status: "active" | "suspended",
created_at, updated_at
```

Subcollections:

- `agencies/{id}/members/{phone}`: `role: "owner"|"agent"`, `status: "active"|"pending"`, `added_by`, `joined_at`. `pending` = phone added by owner before the agent signed up.
- `agencies/{id}/invites/{token}`: `created_by`, `expires_at`, `used_by` (nullable), `used_at`.

Denormalized `agency_id` (string | null) on:

- `businesses/{phone}` — set on join, cleared on removal.
- `listings/{id}` and `property_pages/{id}` — stamped at creation from the creating business, backfilled on join, cleared on removal.

New listing field `agency_private: boolean` (default false).

Mirror pages are ordinary `property_pages` docs with:

```
source_page_id, listing_id (same as source), business_phone (B), agency_id,
agent (B's snapshot), theme (B's), status, created_at, updated_at, edit_token
```

They carry no `property`, `hero`, `gallery`, `texts`. `listings.page_id` keeps
pointing at A's original page; mirrors are found by `source_page_id`.

## 4. Behaviour

**Rendering a mirror.** `getPageHandler` loads the page; when `source_page_id`
is set it loads the source, refuses if the source is archived/expired/building
or `agency_private` was turned on, and returns the source payload with
`agent`, `agent2`, `theme`, `chatbot` and `page_id` taken from the mirror.
`/p/:id`, portfolio nested paths, OG tags and the chatbot resolve through the
same helper so every consumer sees one shape.

**Leads and events.** Unchanged. They key on the mirror's `page_id` and
`business_phone`, so they route to B. The lead record additionally stores
`source_page_id` for reporting.

**Portfolios.** `listPagesByPhone(B)` already returns mirrors, so they appear
in B's portfolio. `visiblePortfolioPages` treats a mirror as visible when its
resolved source is visible.

**Agency pool.** `GET /api/agency/listings` returns active listings with
`agency_id == mine`, `agency_private == false`, owner != me, with a flag for
"already mirrored by me". `POST /api/agency/mirror { listing_id }` creates one
mirror per (listing, member); repeat calls return the existing mirror.

**Owner dashboard.** `GET /api/agency` returns the agency, members with
per-member counts (active listings, pages, leads this month, chat messages
this month from the quota doc) and the agency-wide totals. Read-only.

**Membership.**
- `POST /api/agency/members { phone }` (owner): creates member `active` if the
  business exists, else `pending`. Seat cap enforced on active + pending.
- Signup/profile completion checks for a `pending` member doc by phone and
  activates it (`profile.js` completion path and `intake.js` demo-create).
- `POST /api/agency/invites` (owner) → `{ url }` with a 7-day token.
  `POST /api/agency/invites/accept { token }` (logged-in agent) joins.
- `DELETE /api/agency/members/:phone` (owner or admin): clears `agency_id` on
  the business, its listings and pages; archives the member's mirrors of
  agency listings and other members' mirrors of the leaver's listings.
- Admin: `POST /api/admin/agencies` create, `POST /api/admin/agencies/:id`
  update plan/seats/status/features, `POST /api/admin/agencies/:id/members`
  add or remove, `GET /api/admin/agencies` list.

**Brand inheritance.** A `resolveBrand(business, agency)` helper returns
agent values when present, agency values otherwise. Used where page creation
and portfolio rendering read `logo_url`, `brand_colors`, `slogan` today.

**Feature defaults.** On join, any agency `features` key that the business
lacks is copied onto the business. Admin per-business toggles keep working.

## 5. Authorization

- `requireAgencyOwner` middleware: session phone == `agencies/{id}.owner_phone`
  where `id` = the caller's `businesses.agency_id`. Admin allowlist bypasses.
- Member endpoints require `businesses.agency_id` set and member `active`.
- Mirror creation requires the listing's `agency_id` == caller's, not private,
  and the source page active.
- Page mutation stays owner-only via `page-auth.js`; a mirror's owner is B, so
  B may edit only mirror-owned fields (agent snapshot, theme, chatbot). Content
  edits on a mirror are rejected with `mirror_readonly`.

## 6. UI (public-agent)

- `agency.html` + `agency.js`: owner view (members table, counts, add by
  phone, invite link, remove) and member view (agency pool grid with
  "Market as mine" button, list of my mirrors).
- Dashboard `index.html`: an "Agency" nav link when `agency_id` is set; mirrors
  listed under my properties with a "shared from {name}" badge.
- `admin.html`: new Agencies tab: create, edit plan/seats, assign members.
- Create flow: a "private to me" checkbox on listing creation and on the
  property card.

## 7. Error handling

- Seat cap exceeded → `409 seat_cap`.
- Invite expired/used → `410 invite_invalid`.
- Mirror of private / archived / own listing → `403 not_shareable`.
- Business already in another agency → `409 already_member`.
- Source page missing at render → mirror returns `404`, logged once.

## 8. Testing

Pure-helper tests in the repo's `node file.test.js` style, added to
`npm test`:

- `agency.test.js`: seat-cap check, invite token validity, brand resolution,
  member add/remove state transitions, `canMirror` decision table.
- `mirror.test.js`: payload merge (source content + mirror identity), refusal
  cases, portfolio visibility of mirrors.
- Extend `pages-auth.test.js`: mirror owner may edit identity fields only.
- Extend `leads.test.js`: lead from mirror routes to mirror owner.

Firestore-backed paths are exercised manually with `npm run local` and the
in-memory `mem` fallback in `db.js`.

## 9. Out of scope

Payment processing, shared quota pools, owner editing of members' pages,
listing reassignment, agency-level public portfolio, cross-agency sharing,
multi-agency membership.
