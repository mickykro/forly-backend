const crypto = require("node:crypto");
const { canonicalize, hash, quality, fail } = require("./policy");
const { normalizeFacts } = require("./pipeline");
const SAFE_ERRORS = new Set([
  "group_scan_login_required",
  "group_scan_checkpoint",
  "group_scan_captcha",
  "group_scan_unreadable",
  "group_scan_destination_mismatch",
  "group_scan_deadline",
  "dedicated_operator_required",
  "profile_busy",
  "profile_revoked",
  "profile_quarantined",
  "discovery_disabled",
  "scan_timeout",
  "scan_interrupted",
]);
const SAFE_WARNINGS = new Set([
  "selected_group_not_eligible",
  "no_eligible_groups",
  "group_limit_reached",
  "post_limit_reached",
  "group_no_readable_posts",
  "login_warning",
]);
const safeError = (error) =>
  SAFE_ERRORS.has(error?.code) ? error.code : "scan_outcome_unknown";
const PROPERTY =
  /(?:דירה|דירת|דירות|פנטהאוז|דופלקס|וילה|בית\s*פרטי|מגרש|נכס|apartment|penthouse|duplex|villa|house|condo|flat|property|land)/i;
const OFFER =
  /(?:למכירה|להשכרה|מוצע|מציע|for\s+(?:sale|rent)|selling|sale\s*:|rent\s*:)/i;
const WANTED = /(?:מחפש(?:ים|ות|ת)?|דרוש(?:ה|ים)?|looking\s+for|wanted)/i;
function bound(value, fallback, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : fallback;
}
function rankPost(post) {
  const description =
    typeof post.description === "string"
      ? post.description.trim().slice(0, 10000)
      : "";
  const images = [
    ...new Set(
      (Array.isArray(post.images) ? post.images : [])
        .map((p) => (typeof p === "string" ? p : p?.url))
        .filter((u) => {
          try {
            const url = new URL(u);
            return url.protocol === "https:" && !url.username && !url.password;
          } catch {
            return false;
          }
        }),
    ),
  ].slice(0, 20);
  if (description.length < 30) return { reason: "description_too_short" };
  if (
    !PROPERTY.test(description) ||
    !OFFER.test(description) ||
    WANTED.test(description)
  )
    return { reason: "not_property_offer" };
  if (images.length < 3) return { reason: "minimum_three_photos" };
  let url;
  try {
    url = canonicalize(post.source_post_url);
  } catch {
    return { reason: "exact_post_missing" };
  }
  return {
    url,
    description,
    images,
    score:
      50 +
      Math.min(20, images.length * 2) +
      Math.min(30, Math.floor(description.length / 30)),
  };
}
async function withDeadline(task, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail("scan_timeout")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function createDiscovery({
  store = require("./store"),
  service = require("./service"),
  config = {},
  database = require("../db"),
  reserve = async () => false,
  now = Date.now,
  readGroups = (...args) => require("./group-reader").readGroups(...args),
  parseSource = (...args) =>
    require("../listing-extract").parseListing(...args),
  timeouts = {},
  profileName = (...args) => require("../profile-name").profileName(...args),
} = {}) {
  const key = (value) => hash(config.secret, value),
    stamp = () => new Date(now()).toISOString();
  function enabled() {
    if (
      !config.enabled ||
      !config.policyApproved ||
      config.groupScanEnabled !== true ||
      !config.secret ||
      !config.operatorPhone
    )
      throw fail("discovery_disabled");
    if (
      (process.env.NODE_ENV === "production" ||
        process.env.FORLY_ENV === "prod") &&
      reserve.durable !== true
    )
      throw fail("durable_scan_budget_required");
  }
  const actorHash = (actor) =>
    key(["scan_actor", actor?.userId || actor?.id || "worker"]);
  function audit(tx, action, id, actor) {
    const event = crypto.randomUUID();
    tx.set("audit", event, {
      id: event,
      action,
      entity_id: id,
      actor_hash: actorHash(actor),
      created_at: stamp(),
    });
  }
  function publicScan(row) {
    if (!row || row.kind !== "scan") return null;
    return Object.fromEntries(
      [
        "id",
        "status",
        "campaign_id",
        "created_at",
        "started_at",
        "completed_at",
        "groups_visited",
        "posts_seen",
        "selected",
        "duplicates",
        "reasons",
        "warnings",
        "candidate_ids",
        "error_code",
        "phase",
        "parsed_candidates",
      ]
        .filter((k) => row[k] !== undefined)
        .map((k) => [k, row[k]]),
    );
  }
  async function start(input = {}, actor = {}) {
    enabled();
    const campaign = String(input.campaign_id || "outreach").slice(0, 100);
    const request = String(
      input.idempotency_key || input.request_id || stamp().slice(0, 10),
    ).slice(0, 200);
    const id = "scan_" + key(["scan", campaign, request]);
    return store.transaction(async (tx) => {
      enabled();
      const existing = await tx.get("scans", id);
      if (existing) return publicScan(existing);
      const row = {
        id,
        kind: "scan",
        campaign_id: campaign,
        status: "queued",
        created_at: stamp(),
        max_groups: bound(input.max_groups, 3, 3),
        max_posts: bound(input.max_posts, 20, 20),
        max_candidates: bound(input.max_candidates, 5, 5),
        selected: 0,
        duplicates: 0,
        reasons: {},
        candidate_ids: [],
      };
      audit(tx, "scan_queued", id, actor);
      tx.set("scans", id, row);
      tx.set("jobs", "scan:" + id, {
        id: "scan:" + id,
        scan_id: id,
        type: "outreach_scan",
        status: "queued",
        due_at: stamp(),
      });
      return publicScan(row);
    });
  }
  async function status(id) {
    return publicScan(await store.get("scans", id));
  }
  async function list(options = {}) {
    const rows = await store.list("scans", {
      limit: Math.min(bound(options.limit, 30, 100) + 1, 101),
      cursor: options.cursor,
      kind: "scan",
    });
    const scans = rows.filter((r) => r.kind === "scan");
    const limit = bound(options.limit, 30, 100);
    return {
      scans: scans.slice(0, limit).map(publicScan),
      next_cursor: scans.length > limit ? scans[limit - 1].id : null,
    };
  }
  async function finish(id, patch, runId, actor = { id: "scan-worker" }) {
    return store.transaction(async (tx) => {
      const row = await tx.get("scans", id);
      if (!row || row.status !== "running" || row.run_id !== runId) return;
      audit(tx, "scan_" + patch.status, id, actor);
      tx.set("scans", id, {
        ...row,
        ...patch,
        phase: "complete",
        completed_at: stamp(),
      });
    });
  }
  async function handler(job) {
    enabled();
    const id = job.scan_id,
      runId = crypto.randomUUID();
    const deadline = now() + bound(timeouts.totalMs, 8 * 60000, 8 * 60000);
    async function authorized(tx) {
      enabled();
      const current = await tx.get("scans", id);
      if (!current || current.status !== "running" || current.run_id !== runId)
        throw fail("scan_interrupted");
      if (now() >= deadline || current.lease_until <= now())
        throw fail("scan_timeout");
      return current;
    }
    async function progress(patch) {
      return store.transaction(async (tx) => {
        const current = await authorized(tx);
        tx.set("scans", id, { ...current, ...patch });
      });
    }
    const row = await store.transaction(async (tx) => {
      enabled();
      const current = await tx.get("scans", id);
      if (!current || current.kind !== "scan") return null;
      if (
        current.status === "running" &&
        now() - Date.parse(current.started_at) >= 10 * 60000
      ) {
        audit(tx, "scan_outcome_unknown", id, { id: "scan-worker" });
        tx.set("scans", id, {
          ...current,
          status: "outcome_unknown",
          error_code: "interrupted_scan_unknown",
          completed_at: stamp(),
        });
        return null;
      }
      if (current.status !== "queued") return null;
      const cursor = await tx.get(
        "scans",
        "cursor_" + key(["group_cursor", current.campaign_id]),
      );
      audit(tx, "scan_started", id, { id: "scan-worker" });
      tx.set("scans", id, {
        ...current,
        status: "running",
        phase: "discovering",
        started_at: stamp(),
        run_id: runId,
        lease_until: deadline + 60000,
      });
      return { ...current, group_offset: cursor?.group_offset || 0 };
    });
    if (!row) return;
    let admission,
      holdAdmission = false;
    try {
      admission = await reserve({
        id: "outreach-scan:" + id,
        purpose: "outreach_scan",
        day: stamp().slice(0, 10),
        maxDaily: bound(config.scanDailyCap, 3, 10),
        maxConcurrent: 1,
      });
      if (!admission) {
        await finish(
          id,
          { status: "blocked", error_code: "scan_budget_or_unknown" },
          runId,
        );
        return;
      }
      const conn = await database.getConnection(config.operatorPhone);
      if (
        !conn?.facebook_browser_connected_at ||
        ["revoked", "quarantined"].includes(conn.facebook_profile_state)
      ) {
        await finish(
          id,
          { status: "blocked", error_code: "dedicated_operator_not_connected" },
          runId,
        );
        return;
      }
      const result = await withDeadline(
        readGroups({
          phone: config.operatorPhone,
          conn,
          profileName: profileName(
            "facebook",
            config.operatorPhone,
            conn.facebook_profile_gen || 0,
          ),
          maxGroups: row.max_groups,
          maxPosts: row.max_posts,
          groupOffset: row.group_offset,
          jobId: job.id || "scan:" + id,
        }),
        Math.min(
          bound(timeouts.readerMs, 270000, 270000),
          Math.max(1, deadline - now()),
        ),
      );
      if (
        Number.isSafeInteger(result.next_group_offset) &&
        result.next_group_offset >= 0
      )
        await store.transaction(async (tx) => {
          await authorized(tx);
          tx.set("scans", "cursor_" + key(["group_cursor", row.campaign_id]), {
            id: "cursor_" + key(["group_cursor", row.campaign_id]),
            kind: "cursor",
            group_offset: result.next_group_offset,
            updated_at: stamp(),
          });
        });
      const posts = (Array.isArray(result.posts) ? result.posts : []).slice(
        0,
        row.max_posts,
      );
      const warnings = [
        ...new Set((result.warnings || []).filter((v) => SAFE_WARNINGS.has(v))),
      ].slice(0, 10);
      await progress({
        phase: "qualifying",
        groups_visited: Math.min(row.max_groups, (result.groups || []).length),
        posts_seen: posts.length,
        warnings,
      });
      const reasons = {},
        candidates = [];
      let duplicates = 0;
      const reason = (code) => (reasons[code] = (reasons[code] || 0) + 1);
      for (const post of posts) {
        const ranked = rankPost(post);
        if (ranked.reason) reason(ranked.reason);
        else candidates.push(ranked);
      }
      candidates.sort(
        (a, b) => b.score - a.score || a.url.localeCompare(b.url),
      );
      const selected = [];
      let parsed = 0;
      for (const candidate of candidates) {
        enabled();
        if (parsed >= row.max_candidates) break;
        if (now() >= deadline) {
          reason("scan_deadline");
          break;
        }
        const sourceId = "seen_" + key(["discovered_source", candidate.url]);
        const fresh = await store.transaction(async (tx) => {
          await authorized(tx);
          const previous = await tx.get("scans", sourceId);
          if (previous) return false;
          tx.set("scans", sourceId, {
            id: sourceId,
            kind: "source",
            scan_id: id,
            status: "reserved",
            created_at: stamp(),
            source_hash: key(["post", candidate.url]),
          });
          return true;
        });
        if (!fresh) {
          duplicates++;
          continue;
        }
        parsed++;
        try {
          const parsedSource = await withDeadline(
            parseSource(candidate.description),
            Math.min(
              bound(timeouts.parserMs, 45000, 45000),
              Math.max(1, deadline - now()),
            ),
          );
          const facts = normalizeFacts(
            parsedSource.fields || {},
            candidate.description,
          );
          const check = quality({
            description: candidate.description,
            images: candidate.images,
            facts,
          });
          if (check.reasons.length) {
            reason("required_facts_missing");
            continue;
          }
          const leadId = key([candidate.url, row.campaign_id, "1"]);
          const outcome = await store.transaction(async (tx) => {
            await authorized(tx);
            const previous = await tx.get("leads", leadId);
            const marker = await tx.get("scans", sourceId);
            if (
              !marker ||
              marker.scan_id !== id ||
              marker.status !== "reserved"
            )
              throw fail("scan_interrupted");
            const editable =
              !previous || ["captured", "extracting"].includes(previous.status);
            if (editable) {
              const actor = { id: "scan-worker" };
              audit(
                tx,
                previous ? "discovered_extract" : "discovered_capture",
                leadId,
                actor,
              );
              const lead = {
                ...(previous || {}),
                id: leadId,
                campaign_id: row.campaign_id,
                source_post_url: candidate.url,
                content_version: "1",
                status: "needs_review",
                created_at: previous?.created_at || stamp(),
                origin: "cold_outreach",
                description: candidate.description,
                facts,
                images: candidate.images,
                content_fingerprint: key([
                  candidate.description,
                  facts,
                  candidate.images,
                ]),
                quality: check,
              };
              tx.set("leads", leadId, lead);
            }
            tx.set("scans", sourceId, {
              ...marker,
              status: editable ? "review_ready" : "duplicate",
              lead_id: leadId,
            });
            return editable;
          });
          if (outcome) selected.push(leadId);
          else duplicates++;
          await progress({
            selected: selected.length,
            duplicates,
            reasons: { ...reasons },
            candidate_ids: [...selected],
            parsed_candidates: parsed,
          });
        } catch (error) {
          if (
            ["discovery_disabled", "scan_interrupted", "scan_timeout"].includes(
              error?.code,
            )
          )
            throw error;
          reason("candidate_outcome_unknown");
          // Durable marker remains reserved: never repeat an uncertain paid parse.
        }
      }
      await finish(
        id,
        {
          status: "done",
          groups_visited: Math.min(
            row.max_groups,
            (result.groups || []).length,
          ),
          posts_seen: posts.length,
          selected: selected.length,
          duplicates,
          reasons,
          warnings,
          candidate_ids: selected,
          parsed_candidates: parsed,
        },
        runId,
      );
    } catch (error) {
      const code = safeError(error);
      // A raced provider/browser task may still be running. Keep the durable
      // slot until its bounded lease expires instead of admitting overlapping work.
      if (code === "scan_timeout") holdAdmission = true;
      await finish(
        id,
        {
          status: [
            "discovery_disabled",
            "group_scan_login_required",
            "group_scan_checkpoint",
            "group_scan_captcha",
            "dedicated_operator_required",
            "profile_revoked",
            "profile_quarantined",
          ].includes(code)
            ? "blocked"
            : "outcome_unknown",
          error_code: code,
        },
        runId,
      );
    } finally {
      if (admission?.release && !holdAdmission) await admission.release();
    }
  }
  return { start, status, list, handler };
}
module.exports = { createDiscovery, rankPost };
