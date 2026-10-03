/*
 * routes/posting-listing-groups.js — choosing a property's groups while its
 * page is being built, and approving each group's text once it exists
 * (posting-listing-groups.js). Mounted on /api/posting next to the settings.
 *
 * Signed in normally, or through the WhatsApp link (GET /groups-link), whose
 * token has the "groups" scope: it opens these routes and nothing else.
 */
const A = require("../posting-account");
const LG = require("../posting-listing-groups");
const S_ = require("./posting-shared");
const { isRealEstateGroup } = require("../facebook-groups-sync");

const SCOPES = ["session", "groups"];
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

module.exports = function mountListingGroups(router, S, ctx) {
  const { db, deps } = S;
  const { authSecret } = ctx;
  const auth = ctx.requireAuth(authSecret, SCOPES);
  const { verifySession, readToken } = require("../auth");

  // The WhatsApp link: signs this browser in for the group picker only (an
  // agent already signed in keeps their full session), then opens it.
  router.get("/groups-link", (req, res) => {
    const t = typeof req.query.t === "string" ? req.query.t : "";
    const l = typeof req.query.l === "string" && ID_RE.test(req.query.l) ? req.query.l : "";
    const payload = verifySession(authSecret, t, ["groups"]);
    if (!payload || !payload.userId || !l) return res.status(401).type("html").send('<!doctype html><meta charset="utf-8"><p dir="rtl" style="font-family:sans-serif;padding:24px">הקישור פג תוקף. כתבו לנו בוואטסאפ ונשלח קישור חדש.</p>');
    const current = verifySession(authSecret, readToken(req));
    if (!current || current.userId !== payload.userId) {
      res.cookie("forly_session", t, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: Math.max(0, payload.exp * 1000 - Date.now()) });
    }
    res.redirect(`/groups.html?l=${encodeURIComponent(l)}`);
  });

  const mine = async (req, res) => {
    const id = String(req.params.id || "");
    const listing = ID_RE.test(id) ? await db.getListing(id).catch(() => null) : null;
    if (!listing || String(listing.business_phone) !== String(req.user.userId)) { res.status(404).json({ error: "not_found" }); return null; }
    return listing;
  };

  // What the picker shows: the agent's real-estate groups (whether each suits
  // this property), the default groups, the choice so far and, once the page
  // exists, each chosen group's text to approve.
  router.get("/listing-groups/:id", auth, S_.wrap("listing_groups.get", async (req, res) => {
    const listing = await mine(req, res);
    if (!listing) return;
    res.set("Cache-Control", "no-store");
    const conn = (await db.getConnection(req.user.userId)) || {};
    if (!LG.connected(conn)) return res.json({ connected: false });
    const property = { city: listing.city, neighborhood: listing.neighborhood, listing_type: listing.listing_type || "sale" };
    const find = S_.catalogLookup(await S.catalog(property.listing_type));
    const all = (m) => (find.all ? find.all(m) : [find(m)]);
    const defaults = new Set(LG.defaultIds(conn));
    const groups = S_.memberList(conn).filter((m) => m.membership_state === "member" && isRealEstateGroup(m, all(m)))
      .map((m) => Object.assign(S_.publicMember(m, find(m), defaults), { fits: A.fitsProperty(m, all(m), property) }))
      .filter((g) => !g.private);
    res.json({
      connected: true, consent_version: S_.CONSENT_VERSION, consent_given: !!((conn.posting_permission || {}).granted_at),
      title: [listing.rooms ? `${listing.rooms} חד׳` : "", listing.neighborhood || listing.city].filter(Boolean).join(" ב"),
      groups, defaults: [...defaults], choice: listing.posting_groups || null,
      page_ready: !!listing.page_id, review: await LG.review(listing, Object.assign({}, deps, { pageBaseUrl: deps.pageBaseUrl || ctx.pageBaseUrl })),
    });
  }));

  router.put("/listing-groups/:id", auth, S_.wrap("listing_groups.put", async (req, res) => {
    const listing = await mine(req, res);
    if (!listing) return;
    const b = req.body || {};
    if (b.consent !== true) return res.status(400).json({ error: "consent_required" });
    if (b.consent_version !== S_.CONSENT_VERSION) return res.status(409).json({ error: "consent_outdated", consent_version: S_.CONSENT_VERSION });
    const choice = b.default === true ? LG.DEFAULT : b.group_ids;
    const out = await LG.choose({ listing, phone: req.user.userId, choice, consentVersion: b.consent_version }, deps);
    if (out.error) return res.status(out.error === "not_found" ? 404 : out.error === "facebook_not_connected" ? 409 : 400).json({ error: out.error });
    res.json(out);
  }));

  router.put("/listing-groups/:id/texts", auth, S_.wrap("listing_groups.texts", async (req, res) => {
    const listing = await mine(req, res);
    if (!listing) return;
    const copies = req.body && req.body.copies;
    if (!copies || typeof copies !== "object" || Array.isArray(copies) || Object.keys(copies).length > 60
      || Object.values(copies).some((t) => typeof t !== "string" || t.length > require("../posting-campaign").MAX_COPY)) return res.status(400).json({ error: "invalid_input" });
    const c = await LG.approveTexts(listing, copies, deps);
    if (!c) return res.status(409).json({ error: "page_not_ready" });
    res.json({ ok: true });
  }));
};
