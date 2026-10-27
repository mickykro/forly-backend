"use strict";
const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { isPrivateIp, sniffMatchesExt } = require("../utils");
const MAX_BYTES = 10 * 1024 * 1024;
async function downloadImage(
  raw,
  { lookup = dns.lookup, request, redirects = 0 } = {},
) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("invalid_source_image_url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        isPrivateIp(a.address) ||
        (net.isIP(a.address) === 6 && !/^[23][a-f0-9]{3}:/i.test(a.address)),
    )
  )
    throw new Error("blocked_private_address");
  const pinned = addresses[0];
  const transport =
    request || (url.protocol === "https:" ? https.request : http.request);
  return new Promise((resolve, reject) => {
    let deadline;
    const req = transport(
      url,
      {
        agent: false,
        lookup: (_hostname, options, cb) => {
          if (options?.all) cb(null, [pinned]);
          else cb(null, pinned.address, pinned.family);
        },
        headers: {
          accept: "image/jpeg,image/png,image/webp",
          "user-agent": "Forly-Preview/1.0",
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          clearTimeout(deadline);
          if (redirects >= 3 || !res.headers.location)
            return reject(new Error("source_redirect_limit"));
          return downloadImage(new URL(res.headers.location, url).href, {
            lookup,
            request,
            redirects: redirects + 1,
          }).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          clearTimeout(deadline);
          return reject(new Error("source_download_failed"));
        }
        if (Number(res.headers["content-length"]) > MAX_BYTES) {
          res.destroy();
          return reject(new Error("source_image_too_large"));
        }
        let length = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          length += chunk.length;
          if (length > MAX_BYTES) {
            res.destroy();
            reject(new Error("source_image_too_large"));
          } else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          clearTimeout(deadline);
          const bytes = Buffer.concat(chunks);
          const ext = ["jpg", "png", "webp"].find((ext) =>
            sniffMatchesExt(bytes, ext),
          );
          if (!ext) return reject(new Error("invalid_source_image"));
          resolve({
            bytes,
            content_type: "image/" + (ext === "jpg" ? "jpeg" : ext),
          });
        });
      },
    );
    deadline = setTimeout(
      () => req.destroy(new Error("source_download_timeout")),
      15000,
    );
    req.once("close", () => clearTimeout(deadline));
    req.setTimeout(15000, () =>
      req.destroy(new Error("source_download_timeout")),
    );
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.end();
  });
}
function createPrepareAssets({
  assets = require("./assets"),
  download = downloadImage,
} = {}) {
  return async function prepareAssets(demoId, lead) {
    if (
      !Array.isArray(lead.images) ||
      !lead.images.length ||
      lead.images.length > 20
    )
      throw new Error("invalid_source_images");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "outreach-import-"));
    const photos = [];
    try {
      for (let i = 0; i < lead.images.length; i++) {
        const source =
          typeof lead.images[i] === "string"
            ? lead.images[i]
            : lead.images[i]?.url;
        const { bytes, content_type } = await download(source);
        const file = path.join(tmp, String(i));
        await fs.writeFile(file, bytes, { mode: 0o600 });
        const rows = await assets.registerRenditions({
          demoId,
          renditions: [
            {
              rendition: "source_private",
              path: file,
              content_type,
              origin_url: source,
            },
            { rendition: "website_asset", path: file, content_type },
          ],
        });
        const photo = rows.find((r) => r.rendition === "website_asset");
        if (!photo) throw new Error("asset_manifest_failed");
        photos.push(photo.id);
      }
      return photos;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  };
}
module.exports = { downloadImage, createPrepareAssets, MAX_BYTES };
