const { fail } = require("./policy");
// Deterministic materialization: safe to resume after a process crash. All media
// stays private; paid-assets checks the FINAL upgraded state on every request.
function createPaidProvisioner({
  database = require("../db"),
  store = require("./store"),
  now = Date.now,
} = {}) {
  return async function provision(lead, input = {}) {
    if (!lead.claim?.ownership_verified || !lead.payment?.reference)
      throw fail("verified_payment_required");
    const pageId = "outreach-" + lead.id;
    const previous = await database.getPage(pageId);
    if (previous) {
      if (
        previous.business_phone !== lead.claim.contact ||
        previous.origin !== "outreach_paid" ||
        previous.listing_id !== pageId
      )
        throw fail("paid_page_conflict");
      return { page_id: pageId, url: "/p/" + pageId };
    }
    const demo = lead.demo || (await store.get("demos", lead.demo_id));
    if (!demo || demo.lead_id !== lead.id) throw fail("demo_required");
    const facts = demo.facts || {};
    const property = {
      title: demo.title,
      address: String(facts.address || ""),
      city: String(facts.city || facts.location || ""),
      neighborhood: "",
      listing_type: facts.listing_type === "rent" ? "rent" : "sale",
      property_type: String(facts.property_type || ""),
      rooms: Number(facts.rooms) || 0,
      size_sqm: Number(facts.size_sqm || facts.area) || 0,
      price: Number(facts.price) || 0,
      currency: require("../currency").normalizeCurrency(facts.currency) || "ILS",
      floor: Number(facts.floor) || 0,
      tags: [],
    };
    const phone = lead.claim.contact;
    const agentName = String(
      input.agent_name || input.brand_name || "Forly agent",
    ).slice(0, 100);
    const agent = {
      name: agentName,
      brand_name: agentName,
      phone,
      logo_url: null,
      tagline: "",
      license: String(input.license || "").slice(0, 100),
    };
    const assets = await store.list("assets", {
      demoId: lead.demo_id,
      limit: 200,
    });
    const clean = assets.find(
      (a) => a.rendition === "clean_paid" && !a.revoked,
    );
    const assetUrl = (id) => "/api/outreach/paid-assets/" + lead.id + "/" + id;
    const photos = (demo.photos || []).filter((id) =>
      assets.some(
        (a) => a.id === id && a.rendition === "website_asset" && !a.revoked,
      ),
    );
    if (!photos.length) throw fail("private_photos_required");
    const existingBusiness = await database.getBusiness(phone);
    if (!existingBusiness)
      await database.setBusiness(phone, {
        phone,
        full_name: agentName,
        business_name: agentName,
        created_at: new Date(now()),
        outreach_claim_verified: true,
      });
    const listing = {
      listing_id: pageId,
      business_phone: phone,
      source: "outreach_paid",
      status: "active",
      page_id: pageId,
      ...property,
      description: String(lead.description || "").slice(0, 2000),
      photos_urls: photos.map(assetUrl),
      agent,
      created_at: new Date(now()),
    };
    await database.saveListing(listing);
    const page = {
      page_id: pageId,
      listing_id: pageId,
      business_phone: phone,
      origin: "outreach_paid",
      status: "active",
      visibility: "unlisted",
      portfolio_visible: false,
      distribution_eligible: false,
      created_at: new Date(now()),
      updated_at: new Date(now()),
      expires_at: new Date(now() + 36500 * 86400000),
      edit_token: require("../edit").newEditToken(),
      edit_count: 0,
      extension_count: 0,
      agent,
      property,
      language: "he",
      theme: null,
      hero: {
        phrase: "",
        poster_url: assetUrl(photos[0]),
        video_url: clean ? assetUrl(clean.id) : null,
      },
      gallery: {
        images: photos.map((id) => ({
          url: assetUrl(id),
          caption: "",
          description: "",
        })),
      },
      carousel: { slides: [] },
      area: { blurb: "", stops: [], stats: [] },
      features: {
        clean_video: !!clean,
        editable_template: true,
        editable_copy: true,
        lead_capture: true,
        analytics: true,
        public_visibility_opt_in: true,
      },
      cta: {
        headline: "רוצים לראות את הנכס מקרוב?",
        sub: "השאירו פרטים לתיאום ביקור.",
        bullets: [],
        button_label: "תיאום ביקור",
      },
      sections: { gallery: photos.length >= 3, carousel: false, area: false },
      public_slug: pageId,
      portfolio_rank: null,
      view_count: 0,
      lead_count: 0,
      stats: { views: 0, leads: 0 },
    };
    await database.savePage(page);
    return { page_id: pageId, url: "/p/" + pageId };
  };
}
module.exports = { createPaidProvisioner };
