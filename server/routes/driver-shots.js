/*
 * routes/driver-shots.js — the failed-post screenshots (posting-shots.js),
 * for an admin: GET / → the list, GET /:id.jpg → one image. Mounted by
 * index.js only where posting-shots is enabled (FORLY_ENV local or staging).
 * Off a local box a fresh OTP step-up is required too: a screenshot shows
 * someone's Facebook. Never cached; nothing here writes.
 */
const express = require("express");
const shotsLive = require("../posting-shots");

module.exports = function createDriverShotsRouter({ requireAdmin, requireStepUp, shots = shotsLive, env = process.env }) {
  const router = express.Router();
  const guards = env.FORLY_ENV === "local" || !requireStepUp ? [requireAdmin] : [requireAdmin, requireStepUp];
  router.use(...guards, (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", async (req, res) => res.json({ shots: await shots.list(env) }));
  router.get("/:id.jpg", async (req, res) => {
    const img = await shots.read(req.params.id, env);
    if (!img) return res.status(404).json({ error: "not_found" });
    res.type("jpeg").send(img);
  });
  return router;
};
