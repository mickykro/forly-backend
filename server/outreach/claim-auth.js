const crypto = require("crypto");
const { normalizeAuthPhone } = require("../utils");
const fail = (code) =>
  Object.assign(new Error(code), {
    code,
    status: code === "rate_limited" ? 429 : 400,
  });
function createClaimAuth({
  store,
  service,
  sendCode,
  secret = process.env.OUTREACH_HMAC_SECRET,
  now = () => Date.now(),
}) {
  const key = (...parts) => {
    if (!secret) throw fail("claim_unavailable");
    return crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(parts))
      .digest("hex");
  };
  async function permitted(token) {
    const demo = await service.demoForToken(token);
    if (!service.active(demo)) throw fail("demo_inactive");
    return demo;
  }
  const phoneOf = (value) => {
    const phone = normalizeAuthPhone(value);
    if (!phone || !/^972\d{9}$/.test(phone)) throw fail("invalid_phone");
    return phone;
  };
  async function request(token, input, ip) {
    await permitted(token);
    const phone = phoneOf(input.phone),
      id = key("challenge", token, phone),
      phoneId = key("phone-cap", phone, Math.floor(now() / 3600000)),
      ipId = key(
        "ip-cap",
        String(ip || "unknown"),
        Math.floor(now() / 3600000),
      );
    const code = String(crypto.randomInt(100000, 1000000));
    const allowed = await store.transaction(async (tx) => {
      const previous = await tx.get("challenges", id),
        phoneCap = await tx.get("challenges", phoneId),
        ipCap = await tx.get("challenges", ipId);
      if (
        (previous && now() - previous.created_at < 60000) ||
        phoneCap?.count >= 3 ||
        ipCap?.count >= 10
      )
        return false;
      tx.set("challenges", id, {
        id,
        code_hash: key("otp", id, code),
        created_at: now(),
        expires_at: now() + 300000,
        expire_at: new Date(now() + 300000),
        attempts: 0,
        status: "sending",
      });
      tx.set("challenges", phoneId, {
        id: phoneId,
        count: (phoneCap?.count || 0) + 1,
        expires_at: now() + 3600000,
        expire_at: new Date(now() + 3600000),
      });
      tx.set("challenges", ipId, {
        id: ipId,
        count: (ipCap?.count || 0) + 1,
        expires_at: now() + 3600000,
        expire_at: new Date(now() + 3600000),
      });
      return true;
    });
    if (!allowed) throw fail("rate_limited");
    try {
      if (!sendCode) throw fail("claim_unavailable");
      await sendCode(phone, code);
      await store.transaction(async (tx) => {
        const row = await tx.get("challenges", id);
        if (row?.code_hash === key("otp", id, code))
          tx.set("challenges", id, { ...row, status: "sent" });
      });
    } catch (error) {
      throw fail("code_send_failed");
    }
    return { status: "code_sent" };
  }
  async function verify(token, input) {
    await permitted(token);
    if (input.acknowledged !== true) throw fail("acknowledgement_required");
    const phone = phoneOf(input.phone),
      id = key("challenge", token, phone),
      hash = key("otp", id, String(input.code || ""));
    const valid = await store.transaction(async (tx) => {
      const row = await tx.get("challenges", id);
      if (
        !row ||
        row.status !== "sent" ||
        row.expires_at <= now() ||
        row.attempts >= 5
      )
        return false;
      const matches = crypto.timingSafeEqual(
        Buffer.from(row.code_hash, "hex"),
        Buffer.from(hash, "hex"),
      );
      tx.set("challenges", id, {
        ...row,
        attempts: row.attempts + 1,
        status: matches ? "consumed" : "sent",
      });
      return matches;
    });
    if (!valid) throw fail("invalid_code");
    await service.claimDemo(
      token,
      { acknowledged: true },
      { userId: phone, verified_contact: true },
    );
    return {
      status: "ownership_review_pending",
      ownership_review_required: true,
    };
  }
  return { request, verify };
}
module.exports = { createClaimAuth };
