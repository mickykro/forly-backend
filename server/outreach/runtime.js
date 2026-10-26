const path = require("node:path");
const express = require("express");
const { createService } = require("./service");
const { createAssets } = require("./assets");
const { createPrepareAssets } = require("./import-assets");
const { createPipeline } = require("./pipeline");
const { createWorker } = require("./jobs");
const { createClaimAuth } = require("./claim-auth");
const { createPaidProvisioner } = require("./paid-page");
const { createOutreachRouter } = require("../routes/outreach");
const { createAdminOutreachRouter } = require("../routes/admin-outreach");
function createRuntime({
  config,
  store = require("./store"),
  database = require("../db"),
  callbackGuard,
  reserve,
  requireAdmin,
  requireStepUp,
  requireAuth,
  sendCode,
  download,
  now = Date.now,
}) {
  // Scheduling and private image reads do not consume paid rendering budgets.
  const { createCallbackGuard } = require("../callback-auth");
  const sourceGuard = createCallbackGuard({
    secret: config.callbackSecret,
    reserve,
    now,
    maxDaily: 500,
    maxConcurrent: 4,
  });
  const workerGuard = createCallbackGuard({
    secret: config.callbackSecret,
    reserve,
    now,
    maxDaily: 2880,
    maxConcurrent: 1,
  });
  let assets;
  const service = createService({
    store,
    secret: config.secret,
    config,
    now,
    prepareAssets: (demoId, lead) =>
      createPrepareAssets({ assets, download })(demoId, lead),
    provisionPaidPage: createPaidProvisioner({ database, store, now }),
  });
  assets = createAssets({
    storage: store,
    service,
    privateDir: config.privateDir,
    now,
  });
  const pipeline = createPipeline({
    store,
    service,
    config,
    database,
    reserve,
    now,
  });
  const worker = createWorker({
    store,
    service,
    assets,
    handlers: pipeline.handlers,
    now,
    leaseMs: 10 * 60 * 1000,
  });
  const admin = createAdminOutreachRouter({
    service: { ...service, buildDemo: pipeline.buildDemo },
    requireAdmin,
    requireStepUp,
    startExtraction: pipeline.startExtraction,
  });
  const claimAuth = createClaimAuth({
    store,
    service,
    secret: config.secret,
    sendCode,
    now,
  });
  const publicRouter = createOutreachRouter({
    service,
    assets,
    requireAuth,
    claimAuth,
  });
  const internal = express.Router();
  const stream = (asset, res, complete = () => {}) => {
    if (!asset || !asset.path || asset.revoked) return res.status(404).end();
    const file = path.resolve(asset.path);
    if (!file.startsWith(path.resolve(config.privateDir) + path.sep))
      return res.status(404).end();
    res.set({
      "Cache-Control": "no-store, private",
      "X-Robots-Tag": "noindex, noarchive",
      "Referrer-Policy": "no-referrer",
    });
    res.type(asset.content_type || "application/octet-stream");
    res.sendFile(file, { cacheControl: false, dotfiles: "deny" }, (error) => {
      complete();
      if (error && !res.headersSent) res.status(404).end();
    });
  };
  internal.post(
    "/api/outreach/render-asset",
    sourceGuard("source"),
    async (req, res) => {
      let streaming = false;
      try {
        const demo = await store.get("demos", String(req.body.demo_id || ""));
        const asset = await store.get(
          "assets",
          String(req.body.asset_id || ""),
        );
        if (
          !config.enabled ||
          !config.policyApproved ||
          !service.active(demo) ||
          !asset ||
          asset.demo_id !== demo.id ||
          !["website_asset", "source_private"].includes(asset.rendition)
        )
          return res.status(404).end();
        streaming = true;
        stream(asset, res, req.callbackComplete);
      } catch {
        res.status(404).end();
      } finally {
        if (!streaming) req.callbackComplete?.();
      }
    },
  );
  internal.get(
    "/api/outreach/paid-assets/:leadId/:assetId",
    async (req, res) => {
      try {
        const lead = await store.get("leads", req.params.leadId);
        if (
          !lead ||
          lead.status !== "upgraded" ||
          !lead.claim?.ownership_verified ||
          !lead.payment?.reference
        )
          return res.status(404).end();
        const [page, asset] = await Promise.all([
          database.getPage(lead.paid_page_id),
          store.get("assets", req.params.assetId),
        ]);
        if (
          !page ||
          !["active", "expiring"].includes(page.status) ||
          page.business_phone !== lead.claim.contact ||
          page.listing_id !== lead.paid_page_id ||
          !asset ||
          asset.demo_id !== lead.demo_id ||
          !["clean_paid", "website_asset", "poster"].includes(asset.rendition)
        )
          return res.status(404).end();
        stream(asset, res);
      } catch {
        res.status(404).end();
      }
    },
  );
  internal.post(
    "/api/internal/outreach/tick",
    workerGuard("worker"),
    async (req, res) => {
      if (!config.enabled)
        return res.status(503).json({ error: "outreach_disabled" });
      try {
        res.json(await worker.tick());
      } catch {
        res.status(503).json({ error: "worker_unavailable" });
      } finally {
        req.callbackComplete?.();
      }
    },
  );
  const outreachAssets = {
    registerRenditions: async (input) => {
      if (!config.enabled || !config.policyApproved)
        throw new Error("outreach_disabled");
      const rows = await assets.registerRenditions(input);
      const marked = rows.find((r) => r.rendition === "watermarked_demo");
      if (!marked) throw new Error("watermarked_asset_required");
      await service.attachVideo(
        input.demoId,
        { asset_id: marked.id },
        { id: "render-callback" },
      );
      return rows.map((row) => ({ id: row.id, rendition: row.rendition }));
    },
  };
  return {
    service,
    assets,
    worker,
    admin,
    publicRouter,
    internal,
    outreachAssets,
  };
}
module.exports = { createRuntime };
