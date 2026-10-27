const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");
const { fail } = require("./policy");
const root = () =>
  path.resolve(
    process.env.OUTREACH_PRIVATE_DIR ||
      path.join(require("os").tmpdir(), "forly-outreach-private"),
  );
function createAssets({
  storage = store,
  service = require("./service"),
  privateDir = root(),
  now = () => Date.now(),
} = {}) {
  async function registerRenditions({ demoId, renditions }) {
    const demo = await storage.get("demos", demoId);
    if (!demo || !(service.active(demo) || demo.status === "building"))
      throw fail("demo_inactive");
    const rows = [];
    await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
    for (const item of renditions) {
      if (
        ![
          "source_private",
          "watermarked_demo",
          "clean_paid",
          "poster",
          "website_asset",
        ].includes(item.rendition)
      )
        throw fail("invalid_rendition");
      if (item.rendition === "watermarked_demo" && !item.watermark_version)
        throw fail("watermark_required");
      const bytes = await fs.readFile(item.path);
      if (bytes.length > 100 * 1024 * 1024) throw fail("asset_too_large");
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      if (item.sha256 && item.sha256 !== sha) throw fail("checksum_mismatch");
      const id = crypto.randomUUID(),
        dest = path.join(privateDir, id);
      await fs.writeFile(dest, bytes, { mode: 0o600, flag: "wx" });
      const row = {
        id,
        demo_id: demoId,
        rendition: item.rendition,
        path: dest,
        sha256: sha,
        watermark_version: item.watermark_version || null,
        origin_url:
          item.rendition === "source_private"
            ? String(item.origin_url || "").slice(0, 2048)
            : null,
        source_timestamp:
          item.rendition === "source_private"
            ? new Date(now()).toISOString()
            : null,
        reference_count: 1,
        content_type:
          item.content_type ||
          (item.rendition.includes("demo") || item.rendition === "clean_paid"
            ? "video/mp4"
            : "image/jpeg"),
        created_at: new Date(now()).toISOString(),
        expires_at: demo.expires_at,
        visibility: "private",
        revoked: false,
      };
      try {
        await storage.transaction(async (tx) => {
          const d = await tx.get("demos", demoId);
          if (!(service.active(d) || d?.status === "building"))
            throw fail("demo_inactive");
          tx.set("assets", id, row);
        });
      } catch (error) {
        await fs.rm(dest, { force: true });
        throw error;
      }
      rows.push({
        id,
        rendition: row.rendition,
        url:
          row.rendition === "watermarked_demo"
            ? `/api/outreach/assets/${id}`
            : null,
      });
    }
    return rows;
  }
  async function resolve(id, token) {
    const a = await storage.get("assets", id);
    if (
      !a ||
      a.revoked ||
      !["watermarked_demo", "website_asset", "poster"].includes(a.rendition)
    )
      return null;
    const d = await service.demoForToken(token);
    if (!d || d.id !== a.demo_id || !service.active(d)) return null;
    if (a.rendition === "watermarked_demo" && d.video_asset_id !== a.id)
      return null;
    if (a.rendition !== "watermarked_demo" && !d.photos.includes(a.id))
      return null;
    const file = path.resolve(a.path);
    if (!file.startsWith(path.resolve(privateDir) + path.sep)) return null;
    return { path: file, content_type: a.content_type };
  }
  async function purge(demoId) {
    const d = await storage.get("demos", demoId);
    if (!d || !["expired", "archived", "deleted"].includes(d.status))
      throw fail("demo_not_expired");
    let count = 0;
    for (;;) {
      const rows = await storage.list("assets", { limit: 200, demoId });
      if (!rows.length) break;
      for (const a of rows) {
        const file = path.resolve(a.path);
        if (!file.startsWith(path.resolve(privateDir) + path.sep))
          throw fail("invalid_private_asset_path");
        await fs.rm(file, { force: true });
        await storage.transaction(async (tx) => {
          tx.delete("assets", a.id);
        });
        count++;
      }
    }
    return count;
  }
  async function importRemote(demoId, urls) {
    return require("./import-assets").createPrepareAssets({
      assets: { registerRenditions },
    })(demoId, { images: urls });
  }
  return { registerRenditions, resolve, purge, importRemote };
}
module.exports = { ...createAssets(), createAssets };
