const express = require("express");
function handler(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      res
        .status(error.status || 400)
        .json({ error: error.code || "outreach_request_failed" });
    }
  };
}
function createAdminOutreachRouter({
  service,
  requireAdmin,
  requireStepUp,
  startExtraction,
}) {
  const router = express.Router();
  router.use(requireAdmin);
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(
    "/leads",
    handler((req) =>
      service.listLeads({
        limit: Math.min(100, Math.max(1, Number(req.query.limit) || 25)),
        cursor: req.query.cursor,
      }),
    ),
  );
  router.get(
    "/leads/:id",
    handler((req) => service.getLead(req.params.id)),
  );
  router.get(
    "/leads/:id/delivery-kit",
    handler((req) => service.deliveryKit(req.params.id)),
  );
  router.post(
    "/leads",
    requireStepUp,
    handler((req) => service.createLead(req.body, req.user)),
  );
  router.post(
    "/leads/:id/corrections",
    requireStepUp,
    handler(async (req) => {
      const lead = await service.getLead(req.params.id);
      if (!lead || lead.status !== "needs_review")
        throw Object.assign(new Error("invalid_state"), {
          code: "invalid_state",
        });
      if (typeof req.body.reason !== "string" || !req.body.reason.trim())
        throw Object.assign(new Error("reason_required"), {
          code: "reason_required",
        });
      return service.extract(
        req.params.id,
        {
          description: lead.description,
          images: lead.images,
          facts: req.body.facts,
          review_correction_reason: req.body.reason,
        },
        req.user,
      );
    }),
  );
  const actions = {
    review: "reviewLead",
    reject: "rejectLead",
    build: "buildDemo",
    "delivery-approve": "approveDelivery",
    "manual-confirm": "confirmManualDelivery",
    suppress: "suppressLead",
    "verify-claim": "verifyClaim",
    payment: "reconcilePayment",
    upgrade: "upgradeDemo",
    extract: "extract",
  };
  for (const [path, method] of Object.entries(actions))
    router.post(
      "/leads/:id/" + path,
      requireStepUp,
      handler((req) =>
        method === "extract" && startExtraction
          ? startExtraction(req.params.id, req.body, req.user)
          : service[method](req.params.id, req.body, req.user),
      ),
    );
  return router;
}
module.exports = { createAdminOutreachRouter };
