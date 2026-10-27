const crypto = require("crypto");
function createWorker({
  store = require("./store"),
  service = require("./service"),
  assets = require("./assets"),
  now = () => Date.now(),
  leaseMs = 60000,
  handlers = {},
} = {}) {
  async function tick() {
    const rows = await store.list("jobs", {
      limit: 200,
      pending: true,
      dueBefore: new Date(now()).toISOString(),
    });
    let completed = 0;
    for (const job of rows) {
      if (
        Date.parse(job.due_at) > now() ||
        job.status === "done" ||
        (job.lease_until && job.lease_until > now())
      )
        continue;
      const owner = crypto.randomUUID();
      const claimed = await store.transaction(async (tx) => {
        const current = await tx.get("jobs", job.id);
        if (
          !current ||
          current.status === "done" ||
          current.lease_until > now() ||
          Date.parse(current.due_at) > now()
        )
          return false;
        tx.set("jobs", job.id, {
          ...current,
          status: "running",
          lease_owner: owner,
          lease_until: now() + leaseMs,
        });
        return true;
      });
      if (!claimed) continue;
      try {
        if (handlers[job.type]) await handlers[job.type](job);
        else if (job.type === "expire")
          await service.expire(job.demo_id, { id: "expiry-worker" });
        else if (job.type === "purge") {
          await assets.purge(job.demo_id);
          await store.transaction(async (tx) => {
            const d = await tx.get("demos", job.demo_id);
            const l = d ? await tx.get("leads", d.lead_id) : null;
            if (d) {
              tx.delete("tokens", service.tokenKey(d.token));
              tx.set("demos", d.id, { id: d.id, status: "deleted" });
              const event = crypto.randomUUID();
              tx.set("audit", event, {
                id: event,
                action: "purge",
                entity_id: d.id,
                actor_type: "worker",
                created_at: new Date(now()).toISOString(),
              });
              if (l) {
                tx.delete("attempts", l.id);
                tx.set("leads", l.id, {
                  id: l.id,
                  status: "deleted",
                  created_at: l.created_at,
                });
              }
            }
          });
        }
        await store.transaction(async (tx) => {
          const current = await tx.get("jobs", job.id);
          if (current?.lease_owner === owner)
            tx.set("jobs", job.id, { ...current, status: "done" });
        });
        completed++;
      } catch (e) {
        await store.transaction(async (tx) => {
          const current = await tx.get("jobs", job.id);
          if (current?.lease_owner === owner)
            tx.set("jobs", job.id, {
              ...current,
              status: "queued",
              lease_until: 0,
              error_code: e.code || "job_failed",
            });
        });
      }
    }
    return { completed };
  }
  return { tick };
}
module.exports = { createWorker };
