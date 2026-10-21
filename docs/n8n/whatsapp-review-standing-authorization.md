# WhatsApp daily review — standing authorization to fix n8n

For nine cycles (2026-10-12 → 2026-10-20) the daily WhatsApp review
(`scripts/whatsapp-daily-review.local.js` plus the Claude session that runs
it, see `docs/reports/whatsapp-review-*.html`) repeated the same recommendation
without acting on it: `onError: continueRegularOutput` (or a dedicated error
branch) on the nodes named below, plus a workflow-level Error Workflow, on
both `Main Router v3` (`fhyTsd1DSN6wtMGz`) and `Business Handler v6`
(`lQwn7eYSuIxAZkJB`). Every cycle's report and WhatsApp update to the operator
(972542045280) ended with the same line: write access exists, but the fix
would not be applied without an explicit go-ahead, because changing a live
workflow that answers every registered agent is exactly the kind of
hard-to-reverse, shared-system action this review won't take on its own
judgment.

**On 2026-10-20 the operator gave that go-ahead**, replying to the day-9
WhatsApp update and telling the session driving this conversation to add a
standing rule: this review is now allowed to fix n8n workflows directly and
publish them, not just recommend fixes and wait.

## What this authorizes

- Applying a fix to an n8n workflow this review's own investigation has
  identified (e.g. the `onError`/Error Workflow gap on `Main Router v3` /
  `Business Handler v6`), using the n8n MCP tools already available to the
  session (`get_workflow_details`, `validate_workflow`, `update_workflow`,
  `test_workflow`, `publish_workflow`).
- Publishing (activating) the updated workflow once it's been validated.

## What this does not change

- The fix still has to be the one already described and evidence-backed in
  the daily report, not a new one invented on the spot — this authorizes
  *shipping the standing recommendation*, not open-ended changes to
  production workflows.
- `update_workflow` replaces a workflow's entire definition from SDK code
  (there is no partial-patch call), so for a large, many-node production
  workflow the session should reconstruct the full existing graph faithfully
  (every node, parameter, credential reference and connection, not just the
  nodes being touched), verify the change is isolated to the intended fields
  before publishing, and say plainly if it can't get a clean verification
  rather than publish something unverified.
- Still worth a plain-language note in the daily report and the operator
  WhatsApp message whenever this is used: what changed, on which workflow,
  and what was verified before publishing — the same transparency this
  review has given every other fix.
- This authorization is specific to this routine and the n8n workflows it
  already reviews. It isn't a blanket license to modify unrelated n8n
  workflows or other production systems.
