/**
 * portfolio.js — client-side portfolio loading, filters, and lead form.
 * ponytail: vanilla JS, no build step
 */
(function() {
  const app = document.getElementById("portfolio-app");
  const slug = window.location.pathname.split("/").filter(Boolean)[0];

  if (!slug) {
    app.innerHTML = "<div class='empty-state'><h2>דף לא נמצא</h2></div>";
    return;
  }

  let data = null;
  let filteredProperties = [];

  // Load portfolio data
  fetch(`/api/portfolio?slug=${encodeURIComponent(slug)}`)
    .then((r) => {
      if (r.redirected) { window.location.href = r.url; return null; }
      if (!r.ok) throw new Error("not_found");
      return r.json();
    })
    .then((d) => {
      if (!d) return;
      data = d;
      filteredProperties = d.properties || [];
      render();
      trackEvent("view");
    })
    .catch(() => {
      app.innerHTML = "<div class='empty-state'><h2>הדף לא נמצא</h2><p>ייתכן שהדף הוסר או שהכתובת שגויה.</p></div>";
    });

  function render() {
    const { agent, portfolio, properties } = data;
    const hasProperties = filteredProperties.length > 0;

    app.innerHTML = `
      <header class="portfolio-header">
        ${portfolio.hero?.portrait_url ? `<img class="portrait" src="${esc(portfolio.hero.portrait_url)}" alt="${esc(agent.name)}">` : ""}
        <h1>${esc(agent.brand_name || agent.name)}</h1>
        ${portfolio.hero?.intro ? `<p class="intro">${esc(portfolio.hero.intro)}</p>` : ""}
        ${agent.license ? `<p class="license">רישיון תיווך: ${esc(agent.license)}</p>` : ""}
      </header>

      ${hasProperties ? `
        <div class="filters">
          <input type="text" id="search" placeholder="חיפוש..." oninput="filterProperties()">
          <select id="type" onchange="filterProperties()">
            <option value="">כל סוגי העסקה</option>
            <option value="sale">מכירה</option>
            <option value="rent">השכרה</option>
          </select>
          <select id="city" onchange="filterProperties()">
            <option value="">כל הערים</option>
            ${uniqueCities().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
          </select>
        </div>
        <div class="property-grid" id="property-grid"></div>
      ` : ""}

      ${portfolio.about?.body ? `
        <section class="about-section">
          <h2>אודות</h2>
          <p>${esc(portfolio.about.body)}</p>
        </section>
      ` : ""}

      ${portfolio.area?.body || (portfolio.area?.locations?.length > 0) ? `
        <section class="area-section">
          ${portfolio.area.headline ? `<h2>${esc(portfolio.area.headline)}</h2>` : "<h2>אזורי פעילות</h2>"}
          ${portfolio.area.body ? `<p>${esc(portfolio.area.body)}</p>` : ""}
          <div class="locations">
            ${(portfolio.area.locations || []).map((l) => `<span class="location-tag">${esc(l)}</span>`).join("")}
          </div>
        </section>
      ` : ""}

      ${(portfolio.testimonials?.length > 0) ? `
        <section class="testimonials-section">
          <h2>מה אומרים הלקוחות</h2>
          <div class="testimonial-grid">
            ${portfolio.testimonials.map((t) => `
              <div class="testimonial">
                <blockquote>"${esc(t.quote)}"</blockquote>
                <div class="attribution">— ${esc(t.attribution)}</div>
              </div>
            `).join("")}
          </div>
        </section>
      ` : ""}

      <section class="contact-section">
        <h2>צרו קשר</h2>
        <p>השאירו פרטים ו${esc(agent.name || "נחזור")} ${agent.name ? "יחזור" : ""} אליכם</p>
        <form class="contact-form" id="contact-form">
          <input type="text" name="name" placeholder="שם מלא" required>
          <input type="tel" name="phone" placeholder="טלפון" required>
          <textarea name="message" placeholder="הודעה (אופציונלי)" rows="3"></textarea>
          <button type="submit">שליחה</button>
        </form>
        <p id="form-status" style="margin-top: 16px; display: none;"></p>
      </section>
    `;

    if (hasProperties) renderProperties();
    setupForm();
  }

  function renderProperties() {
    const grid = document.getElementById("property-grid");
    if (!grid) return;
    grid.innerHTML = filteredProperties.map((p) => `
      <a href="${esc(p.url)}" class="property-card">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.title)}" loading="lazy">` : ""}
        <div class="content">
          <h3>${esc(p.title)}</h3>
          <p class="location">${esc(p.city)}${p.neighborhood ? `, ${esc(p.neighborhood)}` : ""}</p>
          ${p.price ? `<p class="price">${formatPrice(p.price, p.listing_type)}</p>` : ""}
          <div class="details">
            ${p.rooms ? `<span>${p.rooms} חדרים</span>` : ""}
            ${p.size_sqm ? `<span>${p.size_sqm} מ"ר</span>` : ""}
          </div>
        </div>
      </a>
    `).join("");
  }

  function uniqueCities() {
    return [...new Set(data.properties.map((p) => p.city).filter(Boolean))];
  }

  window.filterProperties = function() {
    const search = (document.getElementById("search")?.value || "").toLowerCase();
    const type = document.getElementById("type")?.value || "";
    const city = document.getElementById("city")?.value || "";

    filteredProperties = data.properties.filter((p) => {
      if (type && p.listing_type !== type) return false;
      if (city && p.city !== city) return false;
      if (search) {
        const text = `${p.title} ${p.city} ${p.neighborhood}`.toLowerCase();
        if (!text.includes(search)) return false;
      }
      return true;
    });
    renderProperties();
  };

  function setupForm() {
    const form = document.getElementById("contact-form");
    const status = document.getElementById("form-status");
    if (!form) return;

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        slug: slug,
        name: fd.get("name"),
        phone: fd.get("phone"),
        message: fd.get("message") || undefined,
      };

      fetch("/api/portfolio-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((d) => {
          status.textContent = "תודה! נחזור אליך בהקדם.";
          status.style.display = "block";
          status.style.color = "green";
          form.reset();
        })
        .catch(() => {
          status.textContent = "שגיאה בשליחה. נסו שוב.";
          status.style.display = "block";
          status.style.color = "red";
        });
    });
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  function formatPrice(price, type) {
    const f = new Intl.NumberFormat("he-IL").format(price);
    return type === "rent" ? `₪${f}/חודש` : `₪${f}`;
  }

  function trackEvent(event) {
    navigator.sendBeacon("/api/portfolio-event", JSON.stringify({ slug, event }));
  }
})();
