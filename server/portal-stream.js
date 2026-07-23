/*
 * portal-stream.js — realtime fan-out for the public buyer portal (call4li.com)
 * plus the shared page→card mapper.
 *
 * Any route that changes a property page broadcasts here so the portal updates
 * immediately: listing_added / listing_updated (full card payload) and
 * listing_removed ({page_id}). `version` bumps on every broadcast so the
 * listings cache in routes/portal.js can invalidate itself.
 */

const clients = new Set();
let version = 0;

function addClient(res) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function broadcast(event, data) {
  version++;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

// Heartbeat keeps proxies from closing idle SSE connections.
setInterval(() => {
  for (const res of clients) {
    try { res.write(":hb\n\n"); } catch { clients.delete(res); }
  }
}, 30 * 1000).unref();

function getVersion() { return version; }
function clientCount() { return clients.size; }

// Street = address minus its trailing house number; best-effort (free text),
// used by the portal's street filter.
function streetOf(address) {
  return String(address || "").replace(/\s*\d+[א-ת]?\s*$/, "").trim();
}

// Public card payload — only fields already visible on the public property
// page. Never business_phone, edit_token, or lead data. agent.phone IS shown
// on the page itself, and powers the portal's phone-reveal button.
function toCard(p, pageBaseUrl) {
  const prop = p.property || {};
  const agent = p.agent || {};
  const gallery = (p.gallery && p.gallery.images) || [];
  const hero = p.hero || {};
  return {
    page_id: p.page_id,
    page_url: `${pageBaseUrl}/p/${p.page_id}`,
    created_at: p.created_at && p.created_at.toDate ?
      p.created_at.toDate().toISOString() :
      (p.created_at ? new Date(p.created_at).toISOString() : null),
    title: prop.title || "",
    address: prop.address || "",
    street: streetOf(prop.address),
    neighborhood: prop.neighborhood || "",
    city: prop.city || "",
    price: Number(prop.price) || 0,
    rooms: Number(prop.rooms) || 0,
    size_sqm: Number(prop.size_sqm) || 0,
    floor: Number.isFinite(Number(prop.floor)) ? Number(prop.floor) : null,
    parking: Number(prop.parking) || 0,
    agent: {
      name: agent.name || "",
      brand_name: agent.brand_name || agent.name || "",
      logo_url: agent.logo_url || null,
      phone: agent.phone || "",
    },
    poster_url: hero.poster_url || (gallery[0] && gallery[0].url) || null,
    video_url: hero.video_url || null,
    photo_count: gallery.length,
    view_count: p.view_count || 0,
  };
}

module.exports = { addClient, broadcast, getVersion, clientCount, toCard };
