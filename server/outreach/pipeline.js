const crypto = require("node:crypto");
const { fail } = require("./policy");
function normalizeFacts(fields = {}, text = "") {
  const facts = {};
  for (const [target, source] of Object.entries({
    location: "city",
    area: "size_sqm",
    listing_type: "deal",
    rooms: "rooms",
    price: "price",
    currency: "currency",
    floor: "floor",
  }))
    if (fields[source] !== null && fields[source] !== undefined)
      facts[target] = fields[source];
  const terms = [
    ["garden_apartment", /דירת\s*גן|garden apartment/i],
    ["penthouse", /פנטהאוז|\bpenthouse\b/i],
    ["duplex", /דופלקס|\bduplex\b/i],
    ["villa", /וילה|\bvilla\b/i],
    ["house", /בית\s*פרטי|\b(?:private house|detached house|house)\b/i],
    ["apartment", /דירה|דירת|\b(?:apartment|flat|condo)\b/i],
    ["commercial", /חנות|משרד|\b(?:shop|office)\b/i],
    ["land", /מגרש|\bland\b/i],
  ];
  const match = terms.find(([, pattern]) => pattern.test(text));
  if (match) facts.property_type = match[0];
  return facts;
}
function createPipeline({
  store,
  service,
  config,
  database = require("../db"),
  driverEnabled = () => require("../driver-browser").driverEnabled(),
  now = Date.now,
  fetchFn = fetch,
  reserve = async () => false,
  extractSource = (...args) => require("../listing-driver").fromDriver(...args),
  parseSource = (...args) => require("../listing-extract").parseListing(...args),
}) {
  const stamp = () => new Date(now()).toISOString();
  const actorHash = (actor) =>
    crypto
      .createHmac("sha256", config.secret || "local-test")
      .update(String(actor?.userId || "worker"))
      .digest("hex");
  function enabled() {
    if (!config.enabled || !config.policyApproved || !config.secret)
      throw fail("outreach_disabled");
  }
  async function startExtraction(id, input, actor) {
    enabled();
    if (!config.operatorPhone || !driverEnabled())
      throw fail("dedicated_operator_required");
    return store.transaction(async (tx) => {
      const lead = await tx.get("leads", id);
      const jobId = "extract:" + id;
      const previous = await tx.get("jobs", jobId);
      if (!lead) throw fail("not_found");
      if (previous) return { job_id: jobId, status: previous.status };
      if (lead.status !== "captured") throw fail("invalid_state");
      tx.set("audit", crypto.randomUUID(), {
        action: "extract_queued",
        entity_id: id,
        actor_hash: actorHash(actor),
        created_at: stamp(),
      });
      tx.set("leads", id, { ...lead, status: "extracting" });
      tx.set("jobs", jobId, {
        id: jobId,
        lead_id: id,
        type: "extract",
        status: "queued",
        due_at: stamp(),
      });
      return { job_id: jobId, status: "queued" };
    });
  }
  async function extract(job) {
    enabled();
    const lead = await store.get("leads", job.lead_id);
    if (!lead || lead.status !== "extracting") return;
    const reservation = await reserve({
      id: "extract:" + job.id,
      purpose: "extract",
      day: stamp().slice(0, 10),
      maxDaily: 10,
      maxConcurrent: 1,
    });
    if (!reservation) {
      await store.transaction(async (tx) => {
        const current = await tx.get("leads", lead.id);
        if (current?.status === "extracting")
          tx.set("leads", lead.id, {
            ...current,
            status: "build_failed",
            error_code: "extraction_budget_or_unknown",
          });
      });
      return;
    }
    try {
      const conn = await database.getConnection(config.operatorPhone);
      if (!conn?.facebook_browser_connected_at)
        throw fail("dedicated_operator_not_connected");
      const profileName = require("../profile-name").profileName(
        "facebook",
        config.operatorPhone,
        conn.facebook_profile_gen || 0,
      );
      const source = await extractSource(
        { url: lead.source_post_url },
        {
          profileName,
          phone: config.operatorPhone,
          platform: "facebook",
          conn,
          jobId: job.id,
        },
      );
      const parsed = await parseSource(
        source.text,
      );
      await service.extract(
        lead.id,
        {
          description: source.description || source.text,
          facts: normalizeFacts(
            parsed.fields,
            source.description || source.text,
          ),
          images: source.photos.map((p) => p.url),
        },
        { id: "outreach-extractor" },
      );
    } catch (error) {
      await store.transaction(async (tx) => {
        const current = await tx.get("leads", lead.id);
        if (current?.status === "extracting")
          tx.set("leads", lead.id, {
            ...current,
            status: "build_failed",
            error_code: "extraction_failed",
          });
      });
      // An operator reviews failed/unknown work; no blind paid-browser retries.
    } finally {
      await reservation.release();
    }
  }
  async function buildDemo(id, input, actor) {
    enabled();
    const demo = await service.buildDemo(id, input, actor);
    if (config.webhook)
      await store.transaction(async (tx) => {
        const jobId = "video:" + demo.id;
        if (await tx.get("jobs", jobId)) return;
        tx.set("jobs", jobId, {
          id: jobId,
          demo_id: demo.id,
          type: "video",
          status: "queued",
          due_at: stamp(),
        });
      });
    return demo;
  }
  async function video(job) {
    enabled();
    const demo = await store.get("demos", job.demo_id);
    if (!service.active(demo) || demo.video_ready) return;
    const reservation = await reserve({
      id: "video:" + job.id,
      purpose: "outreach_video",
      day: stamp().slice(0, 10),
      maxDaily: 10,
      maxConcurrent: 1,
    });
    if (!reservation) {
      await store.transaction(async (tx) => {
        const current = await tx.get("demos", demo.id);
        if (current && service.active(current))
          tx.set("demos", demo.id, {
            ...current,
            video_status: "budget_or_unknown",
          });
      });
      return;
    }
    try {
      // Persist send_started BEFORE networking. A timeout may have started a paid
      // render: manual reconciliation is required instead of replaying the webhook.
      const started = await store.transaction(async (tx) => {
        const current = await tx.get("jobs", job.id);
        if (current?.send_started_at) return false;
        tx.set("jobs", job.id, { ...current, send_started_at: stamp() });
        return true;
      });
      if (!started) return;
      const images = [];
      for (const id of demo.photos) {
        const body = { demo_id: demo.id, asset_id: id };
        images.push({
          url: config.baseUrl + "/api/outreach/render-asset",
          body,
          headers: require("../callback-auth").signCallback({
            secret: config.callbackSecret,
            purpose: "source",
            body,
            timestamp: now(),
            requestId: crypto.randomUUID(),
          }),
        });
      }
      let outcome = "provider_accepted";
      try {
        const payload = {
          version: 1,
          origin: "cold_outreach",
          brandMode: "outreach_demo",
          demo_id: demo.id,
          correlation_id: job.id,
          image_requests: images,
          property_details: demo.facts,
          callback_url: config.baseUrl + "/api/video-overlay",
        };
        const response = await fetchFn(config.webhook, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...require("../callback-auth").signCallback({
              secret: config.callbackSecret,
              purpose: "pipeline",
              body: payload,
              timestamp: now(),
              requestId: crypto.randomUUID(),
            }),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
        if (!response.ok) outcome = "build_failed";
      } catch {
        outcome = "outcome_unknown";
      }
      await store.transaction(async (tx) => {
        const current = await tx.get("demos", demo.id);
        if (current && service.active(current))
          tx.set("demos", demo.id, { ...current, video_status: outcome });
      });
    } finally {
      await reservation.release();
    }
  }
  return { startExtraction, buildDemo, handlers: { extract, video } };
}
module.exports = { createPipeline, normalizeFacts };
