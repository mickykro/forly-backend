const crypto = require("crypto");
const { DAY, fail, canonicalize, hash, quality } = require("./policy");
function createService({
  store = require("./store"),
  secret = process.env.OUTREACH_HMAC_SECRET,
  now = () => Date.now(),
  config = {},
  prepareAssets,
  provisionPaidPage,
} = {}) {
  const enabled = () => {
    if (
      !(config.enabled ?? process.env.OUTREACH_ENABLED === "true") ||
      !(
        config.policyApproved ?? process.env.OUTREACH_POLICY_APPROVED === "true"
      ) ||
      !secret
    )
      throw fail("outreach_disabled");
  };
  const key = (v) => hash(secret, v),
    stamp = () => new Date(now()).toISOString();
  const actorId = (a) =>
    key(["actor", typeof a === "string" ? a : a?.id || a?.userId || "system"]);
  const audit = (tx, action, id, actor) => {
    const event = crypto.randomUUID();
    tx.set("audit", event, {
      id: event,
      action,
      entity_id: id,
      actor_hash: actorId(actor),
      created_at: stamp(),
    });
  };
  async function mutate(id, action, actor, fn) {
    enabled();
    return store.transaction(async (tx) => {
      const lead = await tx.get("leads", id);
      if (!lead) throw fail("not_found");
      const out = await fn(tx, lead);
      audit(tx, action, id, actor);
      return out;
    });
  }
  async function createLead(input, actor) {
    enabled();
    const url = canonicalize(input.source_post_url);
    const campaign = String(input.campaign_id || "default").slice(0, 100);
    const id = key([url, campaign, input.content_version || "1"]);
    return store.transaction(async (tx) => {
      const existing = await tx.get("leads", id);
      if (existing) return existing;
      const row = {
        id,
        campaign_id: campaign,
        source_post_url: url,
        content_version: String(input.content_version || "1"),
        status: "captured",
        created_at: stamp(),
        origin: "cold_outreach",
      };
      audit(tx, "capture", id, actor);
      tx.set("leads", id, row);
      return row;
    });
  }
  async function extract(id, data, actor) {
    return mutate(
      id,
      data.review_correction_reason ? "fact_correction" : "extraction",
      actor,
      async (tx, l) => {
        if (data.review_correction_reason && l.status !== "needs_review")
          throw fail("invalid_state");
        if (!["captured", "extracting", "needs_review"].includes(l.status))
          throw fail("invalid_state");
        const images = (data.images || []).slice(0, 20);
        const facts = Object.fromEntries(
          [
            "location",
            "property_type",
            "listing_type",
            "rooms",
            "area",
            "price",
            "currency",
            "floor",
          ]
            .filter((k) =>
              ["string", "number"].includes(typeof data.facts?.[k]),
            )
            .map((k) => [
              k,
              typeof data.facts[k] === "string"
                ? data.facts[k].slice(0, 150)
                : data.facts[k],
            ]),
        );
        const row = {
          ...l,
          status: "needs_review",
          description: String(data.description || "").slice(0, 10000),
          facts,
          images,
          ...(data.review_correction_reason
            ? {
                correction_review: {
                  reason: String(data.review_correction_reason).slice(0, 500),
                  actor_hash: actorId(actor),
                  at: stamp(),
                },
              }
            : {}),
          content_fingerprint: key([data.description, data.facts, images]),
          quality: quality({ ...data, facts, images }),
        };
        tx.set("leads", id, row);
        return row;
      },
    );
  }
  async function reviewLead(id, input, actor) {
    enabled();
    return mutate(id, "review", actor, async (tx, l) => {
      if (
        l.status !== "needs_review" ||
        l.quality?.reasons?.length ||
        !input.facts_verified ||
        !input.right_to_use ||
        !String(input.evidence || "").trim()
      )
        throw fail("review_required");
      const row = {
        ...l,
        status: "approved",
        review: {
          facts_verified: true,
          right_to_use: true,
          evidence: String(input.evidence).slice(0, 1000),
          actor_hash: actorId(actor),
          at: stamp(),
          fingerprint: l.content_fingerprint,
        },
      };
      tx.set("leads", id, row);
      return row;
    });
  }
  async function rejectLead(id, input, actor) {
    return mutate(id, "reject", actor, async (tx, l) => {
      if (
        !["captured", "extracting", "needs_review", "approved"].includes(
          l.status,
        )
      )
        throw fail("invalid_state");
      if (!input.reason) throw fail("reason_required");
      const row = {
        ...l,
        status: "rejected",
        reason: String(input.reason).slice(0, 500),
      };
      tx.set("leads", id, row);
      return row;
    });
  }
  async function buildDemo(id, input = {}, actor) {
    enabled();
    const initial = await store.get("leads", id);
    if (!initial) throw fail("not_found");
    if (initial.demo_id) return store.get("demos", initial.demo_id);
    if (initial.status !== "approved") throw fail("review_required");
    const demoId = key(["demo", id, initial.content_fingerprint]);
    await store.transaction(async (tx) => {
      const d = await tx.get("demos", demoId);
      if (d?.status === "building" && d.build_lease_until > now())
        throw fail("build_in_progress");
      if (!d || d.status === "building")
        tx.set("demos", demoId, {
          id: demoId,
          lead_id: id,
          status: "building",
          build_lease_until: now() + 5 * 60000,
          expires_at: new Date(now() + 7 * DAY).toISOString(),
        });
      tx.set("jobs", "expire:" + demoId, {
        id: "expire:" + demoId,
        demo_id: demoId,
        type: "expire",
        due_at: new Date(now() + 7 * DAY).toISOString(),
        status: "queued",
      });
    });
    const photos = prepareAssets
      ? await prepareAssets(demoId, initial)
      : input.photos || [];
    if (!photos.length) throw fail("private_photos_required");
    const token = crypto.randomBytes(32).toString("base64url");
    return store.transaction(async (tx) => {
      const l = await tx.get("leads", id);
      const existing = await tx.get("demos", demoId);
      if (existing && existing.status !== "building") return existing;
      const manifests = await Promise.all(
        photos.map((assetId) => tx.get("assets", assetId)),
      );
      if (
        manifests.some(
          (a) =>
            !a ||
            a.demo_id !== demoId ||
            !["website_asset", "poster"].includes(a.rendition),
        )
      )
        throw fail("private_photos_required");
      if (
        l.status !== "approved" ||
        l.content_fingerprint !== initial.content_fingerprint
      )
        throw fail("invalid_state");
      const demo = {
        id: demoId,
        lead_id: id,
        status: "active",
        origin: "cold_outreach",
        visibility: "unlisted",
        token,
        activated_at: stamp(),
        expires_at: new Date(now() + 7 * DAY).toISOString(),
        photos,
        facts: l.facts,
        title: String(input.title || "Forly property preview").slice(0, 150),
        page_ready: true,
        video_ready: false,
      };
      audit(tx, "activate", id, actor);
      tx.set("demos", demoId, demo);
      tx.set("tokens", key(["token", token]), { demo_id: demoId });
      tx.set("jobs", "expire:" + demoId, {
        id: "expire:" + demoId,
        demo_id: demoId,
        type: "expire",
        due_at: demo.expires_at,
        status: "queued",
      });
      tx.set("leads", id, { ...l, status: "demo_active", demo_id: demoId });
      return demo;
    });
  }
  async function getLead(id) {
    const lead = await store.get("leads", id);
    if (!lead) return null;
    return {
      ...lead,
      demo: lead.demo_id ? await store.get("demos", lead.demo_id) : null,
      delivery: await store.get("attempts", id),
    };
  }
  async function listLeads(options = {}) {
    const limit = Math.min(
        100,
        Math.max(1, Math.floor(Number(options.limit)) || 25),
      ),
      cursor = options.cursor;
    if (
      cursor &&
      (typeof cursor !== "string" || !/^[a-f0-9]{64}$/.test(cursor))
    )
      throw fail("invalid_cursor");
    const found = await store.list("leads", { limit: limit + 1, cursor }),
      rows = found.slice(0, limit);
    const demoIds = [...new Set(rows.map((l) => l.demo_id).filter(Boolean))],
      leadIds = rows.map((l) => l.id);
    const getMany = (c, ids) =>
      store.getMany
        ? store.getMany(c, ids)
        : Promise.all(ids.map((id) => store.get(c, id)));
    const [demos, attempts] = await Promise.all([
      getMany("demos", demoIds),
      getMany("attempts", leadIds),
    ]);
    const demoMap = new Map(demos.filter(Boolean).map((d) => [d.id, d])),
      attemptMap = new Map(
        attempts.filter(Boolean).map((a) => [a.lead_id || a.id, a]),
      );
    const counts = {};
    const leads = rows.map((l) => {
      counts[l.status] = (counts[l.status] || 0) + 1;
      const d = demoMap.get(l.demo_id),
        attempt = attemptMap.get(l.id);
      return {
        id: l.id,
        status: l.status,
        campaign_id: l.campaign_id,
        created_at: l.created_at,
        demo_id: l.demo_id,
        page_ready: !!d?.page_ready,
        video_ready: !!d?.video_ready,
        expires_at: d?.expires_at || null,
        delivery_status: attempt?.status || null,
        claim_status: l.claim
          ? l.claim.ownership_verified
            ? "verified"
            : "pending"
          : null,
        payment_status:
          l.status === "upgraded"
            ? "upgraded"
            : l.payment
              ? "reconciled"
              : null,
      };
    });
    return {
      leads,
      next_cursor: found.length > limit ? rows[rows.length - 1].id : null,
      counts,
      counts_scope: "page",
    };
  }
  async function demoForToken(token) {
    if (typeof token !== "string" || token.length > 100) return null;
    const ref = await store.get("tokens", key(["token", token]));
    return ref ? store.get("demos", ref.demo_id) : null;
  }
  const active = (d) =>
    d &&
    ["active", "claim_started", "payment_pending"].includes(d.status) &&
    Date.parse(d.expires_at) > now();
  async function getPublicDemo(token) {
    const d = await demoForToken(token);
    if (!d) return null;
    if (d.status === "upgraded")
      return { status: "upgraded", redirect_url: d.paid_url };
    if (!active(d)) return { status: "expired" };
    return {
      status: d.status,
      title: d.title,
      facts: d.facts,
      photos: d.photos.map(
        (a) => `/api/outreach/assets/${a}?token=${encodeURIComponent(token)}`,
      ),
      video_url: d.video_asset_id
        ? `/api/outreach/assets/${d.video_asset_id}?token=${encodeURIComponent(token)}`
        : null,
      page_ready: true,
      video_ready: !!d.video_asset_id,
      expires_at: d.expires_at,
      claim_url: `/d/${token}/claim`,
      preview: true,
    };
  }
  async function attachVideo(demoId, input, actor) {
    enabled();
    return store.transaction(async (tx) => {
      const d = await tx.get("demos", demoId);
      const a = await tx.get("assets", input.asset_id);
      if (!active(d)) throw fail("demo_inactive");
      if (
        !a ||
        a.demo_id !== demoId ||
        a.rendition !== "watermarked_demo" ||
        !a.watermark_version
      )
        throw fail("watermarked_asset_required");
      audit(tx, "video_attach", demoId, actor);
      tx.set("demos", demoId, {
        ...d,
        video_asset_id: a.id,
        video_ready: true,
      });
      return { video_ready: true };
    });
  }
  async function approveDelivery(id, input, actor) {
    return mutate(id, "delivery_approve", actor, async (tx, l) => {
      const d = await tx.get("demos", l.demo_id || "_");
      const existing = await tx.get("attempts", id);
      const suppression = await tx.get(
        "suppressions",
        key([
          "recipient",
          String(input.recipient_identifier || "")
            .trim()
            .toLowerCase(),
        ]),
      );
      if (!active(d) || l.status === "suppressed" || suppression)
        throw fail("delivery_blocked");
      if (existing) return existing;
      if (
        !input.message ||
        !input.channel ||
        !input.sender ||
        !input.recipient_identifier ||
        !input.permitted_channel
      )
        throw fail("delivery_review_required");
      const row = {
        id,
        lead_id: id,
        status: "approved",
        message: String(input.message).slice(0, 3000),
        copy_hash: key(input.message),
        channel: String(input.channel).slice(0, 80),
        sender: String(input.sender).slice(0, 100),
        recipient_hash: key([
          "recipient",
          String(input.recipient_identifier).trim().toLowerCase(),
        ]),
        approved_at: stamp(),
        approver: actorId(actor),
      };
      tx.set("attempts", id, row);
      return row;
    });
  }
  async function deliveryKit(id) {
    const l = await getLead(id);
    if (
      !l?.demo ||
      !active(l.demo) ||
      l.status === "suppressed" ||
      !l.delivery ||
      !["approved", "manual_sent_confirmed"].includes(l.delivery.status)
    )
      throw fail("delivery_blocked");
    const suppression = await store.get(
      "suppressions",
      l.delivery.recipient_hash,
    );
    if (suppression) throw fail("delivery_blocked");
    return {
      demo: await getPublicDemo(l.demo.token),
      preview_url: `/d/${l.demo.token}`,
      attempt: l.delivery,
    };
  }
  async function confirmManualDelivery(id, input, actor) {
    return mutate(id, "manual_send_confirm", actor, async (tx, l) => {
      const a = await tx.get("attempts", id);
      const d = await tx.get("demos", l.demo_id || "_");
      const suppression = a
        ? await tx.get("suppressions", a.recipient_hash)
        : null;
      if (a?.status === "manual_sent_confirmed") return a;
      if (
        !a ||
        a.status !== "approved" ||
        !active(d) ||
        suppression ||
        l.status === "suppressed"
      )
        throw fail("delivery_blocked");
      if (
        !input.evidence ||
        !input.sent_at ||
        !Number.isFinite(Date.parse(input.sent_at)) ||
        Date.parse(input.sent_at) > now() + 60000
      )
        throw fail("confirmation_required");
      const row = {
        ...a,
        status: "manual_sent_confirmed",
        confirmed_by: actorId(actor),
        sent_at: new Date(input.sent_at).toISOString(),
        evidence: String(input.evidence).slice(0, 500),
        confirmed_at: stamp(),
      };
      tx.set("attempts", id, row);
      return row;
    });
  }
  async function suppressLead(id, input, actor) {
    return mutate(id, "suppress", actor, async (tx, l) => {
      const attempt = await tx.get("attempts", id);
      const recipient = input.recipient_identifier
        ? key([
            "recipient",
            String(input.recipient_identifier).trim().toLowerCase(),
          ])
        : attempt?.recipient_hash;
      if (!recipient || !input.reason)
        throw fail("suppression_identifier_required");
      tx.set("suppressions", recipient, {
        id: recipient,
        scope: "global",
        created_at: stamp(),
        reason: String(input.reason).slice(0, 200),
      });
      tx.set("leads", id, { ...l, status: "suppressed" });
      return { status: "suppressed" };
    });
  }
  async function claimDemo(token, input, actor) {
    const d = await demoForToken(token);
    if (!active(d)) throw fail("demo_inactive");
    if (!actor?.userId) throw fail("verified_contact_required");
    return mutate(d.lead_id, "claim_start", actor, async (tx, l) => {
      const currentDemo = await tx.get("demos", d.id);
      if (!active(currentDemo) || l.status === "suppressed")
        throw fail("demo_inactive");
      if (l.claim && l.claim.contact !== actor.userId)
        throw fail("claim_already_pending");
      if (l.claim) return { status: "ownership_review_pending" };
      const row = {
        ...l,
        status: "claimed",
        claim: {
          contact: actor.userId,
          ownership_verified: false,
          at: stamp(),
        },
      };
      tx.set("leads", l.id, row);
      return { status: "ownership_review_pending" };
    });
  }
  async function verifyClaim(id, input, actor) {
    return mutate(id, "ownership_verify", actor, async (tx, l) => {
      if (!["claimed", "payment_pending"].includes(l.status))
        throw fail("invalid_state");
      if (
        !l.claim ||
        !input.evidence ||
        !input.business_phone ||
        l.claim.contact !== input.business_phone
      )
        throw fail("ownership_evidence_required");
      const row = {
        ...l,
        claim: {
          ...l.claim,
          ownership_verified: true,
          evidence: String(input.evidence).slice(0, 500),
          verified_by: actorId(actor),
        },
      };
      tx.set("leads", id, row);
      return row;
    });
  }
  async function reconcilePayment(id, input, actor) {
    return mutate(id, "payment_reconcile", actor, async (tx, l) => {
      if (!["claimed", "payment_pending"].includes(l.status))
        throw fail("invalid_state");
      if (
        !l.claim?.ownership_verified ||
        !input.payment_reference ||
        !input.reconciliation_note
      )
        throw fail("verified_payment_required");
      const row = {
        ...l,
        status: "payment_pending",
        payment: {
          reference: String(input.payment_reference).slice(0, 200),
          note: String(input.reconciliation_note).slice(0, 500),
          verified_at: stamp(),
          verified_by: actorId(actor),
        },
      };
      tx.set("leads", id, row);
      return row;
    });
  }
  async function upgradeDemo(id, input, actor) {
    enabled();
    const l = await getLead(id);
    if (!l?.claim?.ownership_verified || !l.payment || !input.idempotency_key)
      throw fail("upgrade_preconditions");
    if (l.status === "upgraded") return l;
    if (!provisionPaidPage) throw fail("paid_provisioning_unavailable");
    await mutate(id, "upgrade_reserved", actor, async (tx, current) => {
      if (
        !current.claim?.ownership_verified ||
        !current.payment ||
        !["payment_pending", "upgrading"].includes(current.status)
      )
        throw fail("upgrade_preconditions");
      if (current.status === "upgrading" && current.upgrade_lease_until > now())
        throw fail("upgrade_in_progress");
      const reserved = {
        ...current,
        status: "upgrading",
        upgrade_key: key(input.idempotency_key),
        upgrade_lease_until: now() + 10 * 60000,
      };
      if (current.upgrade_key && current.upgrade_key !== reserved.upgrade_key)
        throw fail("upgrade_already_reserved");
      tx.set("leads", id, reserved);
      return reserved;
    });
    const result = await provisionPaidPage(l, input);
    if (!result?.page_id || !/^\/(?:p|property)\//.test(result.url || ""))
      throw fail("paid_page_required");
    return mutate(id, "upgrade", actor, async (tx, current) => {
      const d = await tx.get("demos", current.demo_id);
      if (current.status === "upgraded") return current;
      if (
        !current.claim?.ownership_verified ||
        !current.payment ||
        current.status !== "upgrading" ||
        current.upgrade_key !== key(input.idempotency_key)
      )
        throw fail("upgrade_preconditions");
      const row = {
        ...current,
        status: "upgraded",
        paid_page_id: result.page_id,
        upgrade_key: key(input.idempotency_key),
      };
      tx.set("leads", id, row);
      tx.set("demos", d.id, { ...d, status: "upgraded", paid_url: result.url });
      return row;
    });
  }
  async function expire(demoId, actor) {
    return store.transaction(async (tx) => {
      const d = await tx.get("demos", demoId);
      if (
        !d ||
        d.status === "upgraded" ||
        ["expired", "deleted"].includes(d.status)
      )
        return d;
      const l = await tx.get("leads", d.lead_id);
      if (Date.parse(d.expires_at) > now()) throw fail("not_due");
      audit(tx, "expire", demoId, actor);
      tx.set("demos", demoId, { ...d, status: "expired" });
      tx.set("leads", l.id, { ...l, status: "expired" });
      tx.set("jobs", "purge:" + demoId, {
        id: "purge:" + demoId,
        demo_id: demoId,
        type: "purge",
        status: "queued",
        due_at: new Date(now() + 30 * DAY).toISOString(),
      });
      return { status: "expired" };
    });
  }
  return {
    store,
    active,
    tokenKey: (token) => key(["token", token]),
    createLead,
    extract,
    reviewLead,
    rejectLead,
    buildDemo,
    getLead,
    listLeads,
    getPublicDemo,
    demoForToken,
    attachVideo,
    approveDelivery,
    deliveryKit,
    confirmManualDelivery,
    suppressLead,
    claimDemo,
    verifyClaim,
    reconcilePayment,
    upgradeDemo,
    expire,
  };
}
const service = createService();
module.exports = { ...service, createService };
