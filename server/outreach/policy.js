const crypto = require("crypto");
const DAY = 86400000;
function fail(code, message = code) {
  const e = new Error(message);
  e.code = code;
  e.status = code === "not_found" ? 404 : 400;
  return e;
}
function canonicalize(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw fail("invalid_source");
  }
  if (
    u.protocol !== "https:" ||
    !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(
      u.hostname,
    ) ||
    u.username ||
    u.password ||
    u.port
  )
    throw fail("invalid_source");
  const m = u.pathname.match(
    /^\/groups\/([A-Za-z0-9._-]+)\/(?:posts|permalink)\/(\d+)\/?$/,
  );
  if (!m) throw fail("exact_group_post_required");
  return `https://www.facebook.com/groups/${m[1]}/posts/${m[2]}/`;
}
function hash(secret, value) {
  if (!secret) throw fail("configuration_required");
  return crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("hex");
}
function quality(data) {
  const reasons = [];
  if (!data.description || data.description.trim().length < 30)
    reasons.push("description_too_short");
  if (!Array.isArray(data.images) || data.images.length < 3)
    reasons.push("minimum_three_photos");
  if (!data.facts?.location) reasons.push("location_missing");
  if (!data.facts?.property_type) reasons.push("property_type_missing");
  return { score: Math.max(0, 100 - reasons.length * 25), reasons };
}
module.exports = { DAY, fail, canonicalize, hash, quality };
