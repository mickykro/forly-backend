# Browser-driven Facebook Group publishing

> **Legacy filename:** this document remains at its original path so existing
> links continue to work. Its previous “no automation” decision was superseded
> by the product owner on **29 September 2026**.

## Decision

Forly **may automatically publish listings into selected Facebook Groups** via
its controlled browser publisher. There is no supported Groups publishing API,
so the execution path is a persisted, connected Facebook browser profile rather
than a Graph API call.

**Status:** active product decision. The implementation must remain a
server-controlled publisher with explicit agent consent, auditable attempts,
and immediate safety stops. It must not become a client-side extension that
exposes session material or executes independently of Forly's controls.

## Scope and boundaries

| Channel | Publishing path | Status |
|---|---|---|
| Facebook Page | Official Graph API or browser publisher, depending on the connected Page configuration | Automatic |
| Instagram | Connected distribution pipeline | Automatic where configured |
| Facebook Group | Controlled browser publisher using the agent's persisted Facebook profile | Automatic for eligible, consented Groups |

The Groups API remains unavailable for publishing. The absence of an API is an
implementation constraint, not a reason to silently fall back to an
uncontrolled manual workflow.

## Required publisher controls

The Group publisher must enforce the following controls before and after every
attempt:

1. **Consent and scope.** The connected agent grants a current posting
   permission and selects the Groups or default Group pool. A stop, permission
   revocation, or account-level disable takes effect before the next action.
2. **Eligibility.** A Group must be a known membership, fit the listing type,
   and not be marked as disallowing agent posts. Forly does not join Groups or
   override Group-level restrictions.
3. **Campaign limits.** Per-account, per-Group, duplicate, and cooldown rules
   limit repeat distribution and prevent the same listing from being scheduled
   into an ineligible or recently used Group. A one-pass campaign may contain
   up to 40 selected Groups and remain open for up to 30 days, but widening
   that pool never raises the daily, weekly, or per-Group posting limits.
4. **Pre-submit proof.** Immediately before submitting, the publisher verifies
   the logged-in identity, destination Group, composer destination, approved
   copy hash, and exactly one enabled Post control. A mismatch or unavailable
   control fails before the click.
5. **One-click semantics.** Once an attempt reaches `submit_started`, the
   publisher never performs a second submit. It verifies the outcome and
   reconciles uncertain attempts by reading only.
6. **Account signals.** Login challenges, checkpoints, restrictions, rate
   limits, feature blocks, membership loss, and Group blocks stop or pause the
   relevant publishing scope. A confirmed post removal temporarily disables
   that Group.
7. **Operator visibility.** Every attempt has a durable state transition,
   stable failure code, safe diagnostic metadata, and a campaign-level reason
   that can be shown to the agent and support team.
8. **Data lifecycle.** Browser profiles are tied to the connected account and
   must be quarantined or revoked when a relevant account signal requires it.
9. **Truthful copy variation.** Group posts may rotate headline framing, fact
   order, first-comment wording, and response CTA. The property facts never
   change. The variation is deterministic per Group and completed round so a
   retry uses the exact same approved copy.
10. **Transparent destination variation.** A Group post may use the canonical
    Forly property page, the agent's canonical WhatsApp link, an existing
    Facebook Page post that already carries the property link, or no external
    link with a direct-response CTA. The chosen destination is persisted with
    the planned post and disclosed to the agent before approval, or in the
    posted notice for standing mode. When the Forly property link is withheld,
    the notice explains why and what replaces it.

## Delivery model

The publisher runs one durable attempt at a time for an account:

```text
scheduled → reserved → session_started → composer_ready
          → submit_started → verification_pending
          → verified_posted | submitted_for_approval | verified_failed | outcome_unknown
```

- `verified_failed` means the publisher stopped before a confirmed click.
- `outcome_unknown` means the click may have happened; only reconciliation may
  settle it, never another submit.
- `submitted_for_approval` means Facebook accepted the submission but the
  Group's moderators still control publication.

## Operational priorities

1. **Selector calibration.** Facebook UI changes should produce a precise,
   pre-submit `selector_failure`/`submit_unavailable` result rather than a
   blind click. Three successive selector failures pause the campaign for
   calibration.
2. **Media reliability.** The publisher fetches the listing video before
   opening a browser and confirms that the upload completed before the Post
   click. Failed media uploads never fall back to a text-only post.
3. **Verification and recheck.** After submission, the publisher verifies the
   canonical post and runs a delayed visibility check. The Group's moderation
   decision remains authoritative.
4. **Controlled rollout.** New selectors, media types, or scheduling changes
   should begin with dry-run coverage and a limited canary cohort before being
   enabled across all accounts.
5. **Natural content, not disguised behavior.** Copy should be concise,
   relevant, and varied for readers. The system must not raise posting rates or
   weaken identity, Group-policy, cooldown, verification, or halt controls to
   imitate human behavior.
6. **No link cloaking or block evasion.** Destination variation uses only real,
   canonical destinations. Forly must not rotate domains, create aliases, use
   shorteners, build redirect chains, or otherwise conceal the property URL to
   bypass Facebook detection. If Facebook rejects or blocks the Forly domain,
   that destination is paused and surfaced to the agent and operator; it is not
   routed around.

## Product metrics

Monitor the following separately by Group, account, listing type, and media
format:

- scheduled-to-posted conversion;
- verification, selector, media, and navigation failure rates;
- Group approval, removal, and access-loss rates;
- time to post and time to moderation approval;
- attributed visits and leads; and
- account-level restrictions, checkpoints, or reconnect requests.

A material increase in account or Group restrictions must activate the existing
account and fleet controls and trigger selector/policy review before expanding
volume.

## Historical note

The earlier version of this document rejected automatic Group publishing and
removed a browser extension. That decision applied to the old extension-based
architecture. The current approved design is the backend browser publisher on
this branch, with durable attempt states, target proof, controlled consent,
and account/fleet controls. The old extension must not be revived as a parallel
execution path.
