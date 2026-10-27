const express = require("express");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const assetUrl = (url, token) =>
  typeof url === "string" &&
  /^\/api\/outreach\/assets\/[a-zA-Z0-9_-]+\?token=/.test(url) &&
  url.split("?token=")[1] === encodeURIComponent(token)
    ? url
    : null;
const factKeys = [
  "location",
  "property_type",
  "listing_type",
  "rooms",
  "area",
  "price",
  "floor",
];
function safeDemo(demo, token) {
  if (!demo || ["expired", "archived", "deleted"].includes(demo.status))
    return { status: demo ? "expired" : "not_found" };
  if (demo.status === "upgraded")
    return {
      status: "upgraded",
      redirect_url:
        typeof demo.redirect_url === "string" &&
        /^\/(?:p|property)\/[a-zA-Z0-9_-]+$/.test(demo.redirect_url)
          ? demo.redirect_url
          : null,
    };
  return {
    status: demo.status,
    title: demo.title || "Forly property preview",
    description: demo.description || "",
    facts: Object.fromEntries(
      factKeys
        .filter(
          (key) =>
            typeof demo.facts?.[key] === "string" ||
            Number.isFinite(demo.facts?.[key]),
        )
        .map((key) => [
          key,
          typeof demo.facts[key] === "string"
            ? demo.facts[key].slice(0, 150)
            : demo.facts[key],
        ]),
    ),
    expires_at: demo.expires_at,
    photos: (demo.photos || [])
      .map((url) => assetUrl(url, token))
      .filter(Boolean),
    video_url: assetUrl(demo.video_url, token),
    claim_url: "/outreach-claim.html?token=" + encodeURIComponent(token),
  };
}
function html(demo) {
  const labels = {
    location: "Location",
    property_type: "Property type",
    listing_type: "Sale / rent",
    rooms: "Rooms",
    area: "Area (m²)",
    price: "Price",
    floor: "Floor",
  };
  const facts = Object.keys(demo.facts || {})
    .map(
      (key) =>
        "<div><dt>" +
        esc(labels[key]) +
        "</dt><dd>" +
        esc(demo.facts[key]) +
        "</dd></div>",
    )
    .join("");
  const active = demo.status !== "expired" && demo.status !== "not_found";
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Forly preview</title><style>body{margin:0;background:#f8f5ef;color:#211f1a;font:18px system-ui}main{max-width:920px;margin:48px auto;padding:24px}header{font-weight:800;letter-spacing:.15em}h1{font-size:clamp(32px,6vw,64px)}img,video{width:100%;max-height:70vh;object-fit:contain;border-radius:16px}a{display:inline-block;background:#244c3b;color:white;padding:16px;border-radius:8px}p{white-space:pre-wrap;line-height:1.6}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px}dl div{padding:16px;background:#fff;border-radius:8px}dt{font-size:14px;color:#666}dd{margin:8px 0 0;font-weight:600}</style><main><header>FORLY · PRIVATE PREVIEW</header><h1>' +
    esc(active ? demo.title : "This preview is no longer active") +
    "</h1>" +
    (active
      ? "<p>This is a Forly sample. Available until " +
        esc(demo.expires_at) +
        ".</p><p>" +
        esc(demo.description) +
        "</p><dl>" +
        facts +
        "</dl>" +
        (demo.video_url
          ? '<video controls preload="metadata" src="' +
            esc(demo.video_url) +
            '"></video>'
          : "") +
        demo.photos
          .map(
            (url) =>
              '<img alt="Forly watermarked property preview" loading="lazy" src="' +
              esc(url) +
              '">',
          )
          .join("")
      : "<p>Contact Forly to request a review.</p>") +
    '<p><a href="' +
    esc(active ? demo.claim_url : "/") +
    '">' +
    (active ? "Claim this Forly demo" : "Contact Forly") +
    "</a></p></main></html>"
  );
}
function createOutreachRouter({ service, requireAuth, assets, claimAuth }) {
  const router = express.Router();
  router.use(["/d", "/api/outreach"], (req, res, next) => {
    res.set({
      "Cache-Control": "no-store, private",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });
  const preview = (asJson) => async (req, res) => {
    try {
      const demo = safeDemo(
        await service.getPublicDemo(req.params.token),
        req.params.token,
      );
      if (demo.status === "not_found")
        return res
          .status(404)
          .send(asJson ? { status: "not_found" } : html(demo));
      if (demo.status === "upgraded" && demo.redirect_url)
        return res.redirect(302, demo.redirect_url);
      res.status(demo.status === "expired" ? 410 : 200);
      return asJson ? res.json(demo) : res.type("html").send(html(demo));
    } catch (error) {
      res.status(404).json({ error: "preview_unavailable" });
    }
  };
  router.get("/d/:token", preview(false));
  router.get("/api/outreach/demos/:token", preview(true));
  router.get("/api/outreach/assets/:assetId", async (req, res) => {
    try {
      const asset = assets
        ? await assets.resolve(req.params.assetId, req.query.token)
        : null;
      if (!asset || !asset.path) return res.status(404).end();
      res.type(asset.content_type || "application/octet-stream");
      res.sendFile(
        asset.path,
        { cacheControl: false, dotfiles: "deny" },
        (error) => {
          if (error && !res.headersSent) res.status(404).end();
        },
      );
    } catch (error) {
      res.status(404).end();
    }
  });
  if (claimAuth) {
    router.post("/api/outreach/demos/:token/otp", async (req, res) => {
      try {
        res.json(await claimAuth.request(req.params.token, req.body, req.ip));
      } catch (error) {
        res
          .status(error.status || 400)
          .json({ error: error.code || "claim_unavailable" });
      }
    });
    router.post("/api/outreach/demos/:token/verify", async (req, res) => {
      try {
        res.json(await claimAuth.verify(req.params.token, req.body));
      } catch (error) {
        res
          .status(error.status || 400)
          .json({ error: error.code || "claim_unavailable" });
      }
    });
  }
  router.post(
    "/api/outreach/demos/:token/claim",
    requireAuth ||
      ((req, res) => res.status(401).json({ error: "unauthenticated" })),
    async (req, res) => {
      try {
        if (req.body.acknowledged !== true)
          return res.status(400).json({ error: "acknowledgement_required" });
        await service.claimDemo(
          req.params.token,
          { acknowledged: true, phone: req.user.userId },
          req.user,
        );
        res.json({ status: "claim_started", ownership_review_required: true });
      } catch (error) {
        res
          .status(error.status || 400)
          .json({ error: error.code || "claim_unavailable" });
      }
    },
  );
  return router;
}
module.exports = { createOutreachRouter, safeDemo };
