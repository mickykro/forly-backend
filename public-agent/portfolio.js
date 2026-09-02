/**
 * portfolio.js — agent portfolio editor
 * ponytail: vanilla JS, minimal
 */
(function() {
  const editor = document.getElementById("editor");
  let data = null;

  // Check auth
  const token = document.cookie.match(/forly_token=([^;]+)/)?.[1];
  if (!token) {
    window.location.href = "/";
    return;
  }

  fetch("/api/my-portfolio", {
    headers: { "Authorization": `Bearer ${token}` },
  })
    .then((r) => r.ok ? r.json() : Promise.reject())
    .then((d) => {
      data = d;
      render();
    })
    .catch(() => {
      editor.innerHTML = "<p>שגיאה בטעינת הנתונים. <a href='/'>חזרה</a></p>";
    });

  function render() {
    const { profile, portfolio, pages } = data;
    const hasPortfolio = !!portfolio;

    editor.innerHTML = `
      ${hasPortfolio ? `
        <div class="portfolio-link">
          <span>דף הנכסים שלך:</span>
          <a href="${esc(portfolio.url)}" target="_blank">${esc(portfolio.url)}</a>
        </div>
      ` : `
        <div style="text-align:center;padding:30px 0">
          <p>עדיין אין לך דף נכסים</p>
          <button class="btn btn-gold" id="createBtn">יצירת דף נכסים</button>
        </div>
      `}

      <h2>פרופיל</h2>
      <div class="field">
        <label>שם העסק</label>
        <input id="business_name" value="${esc(profile.business_name)}">
      </div>
      <div class="field">
        <label>שם מלא</label>
        <input id="full_name" value="${esc(profile.full_name)}">
      </div>
      <div class="field">
        <label>עיר</label>
        <input id="city" value="${esc(profile.city)}">
      </div>
      <div class="field">
        <label>מספר רישיון</label>
        <input id="license_number" value="${esc(profile.license_number)}">
      </div>

      ${hasPortfolio ? `
        <h2>כותרת הדף</h2>
        <div class="field">
          <label>כותרת ראשית</label>
          <input id="hero_headline" value="${esc(portfolio.hero?.headline || "")}" maxlength="120">
        </div>
        <div class="field">
          <label>תיאור קצר</label>
          <textarea id="hero_intro" maxlength="500">${esc(portfolio.hero?.intro || "")}</textarea>
        </div>

        <h2>אודות</h2>
        <div class="field">
          <textarea id="about_body" maxlength="1500" placeholder="ספרו על עצמכם והניסיון שלכם...">${esc(portfolio.about?.body || "")}</textarea>
        </div>

        <h2>אזורי פעילות</h2>
        <div class="field">
          <label>כותרת</label>
          <input id="area_headline" value="${esc(portfolio.area?.headline || "")}" maxlength="120">
        </div>
        <div class="field">
          <label>תיאור</label>
          <textarea id="area_body" maxlength="1500">${esc(portfolio.area?.body || "")}</textarea>
        </div>
        <div class="field">
          <label>ערים/שכונות (מופרדות בפסיק)</label>
          <input id="area_locations" value="${esc((portfolio.area?.locations || []).join(", "))}">
        </div>

        <h2>חוות דעת</h2>
        <div id="testimonials-list">
          ${(portfolio.testimonials || []).map((t, i) => testimonialCard(t, i)).join("")}
        </div>
        <button class="btn btn-ghost btn-sm" id="addTestimonial">+ הוספת חוות דעת</button>
        <p class="legal-warning">פרסום חוות דעת שאינן אמיתיות עלול להוות הפרת חוק ולחשוף אתכם לתביעה.</p>

        <h2>נכסים בדף</h2>
        <div id="pages-list">
          ${pages.map((p) => pageRow(p)).join("")}
        </div>
      ` : ""}

      ${hasPortfolio ? `
        <button class="btn btn-gold btn-save" id="saveBtn">שמירה</button>
      ` : ""}
      <p id="status" style="text-align:center;margin-top:16px;display:none"></p>
    `;

    if (!hasPortfolio) {
      document.getElementById("createBtn")?.addEventListener("click", createPortfolio);
    } else {
      document.getElementById("saveBtn")?.addEventListener("click", savePortfolio);
      document.getElementById("addTestimonial")?.addEventListener("click", addTestimonial);
      document.querySelectorAll(".remove-testimonial").forEach((btn) => {
        btn.addEventListener("click", () => removeTestimonial(btn.dataset.index));
      });
    }
  }

  function testimonialCard(t, i) {
    return `
      <div class="testimonial-card" data-index="${i}">
        <button class="remove-btn remove-testimonial" data-index="${i}">הסרה</button>
        <div class="field">
          <label>ציטוט</label>
          <textarea class="t-quote" maxlength="500">${esc(t.quote)}</textarea>
        </div>
        <div class="field">
          <label>שם הלקוח</label>
          <input class="t-attribution" value="${esc(t.attribution)}" maxlength="80">
        </div>
      </div>
    `;
  }

  function pageRow(p) {
    const checked = p.portfolio_visible !== false ? "checked" : "";
    return `
      <div class="page-row" data-page-id="${esc(p.page_id)}">
        <input type="checkbox" class="page-visible" ${checked}>
        <span class="title">${esc(p.title || p.address || p.page_id)}</span>
        <span style="color:#999">${p.status}</span>
      </div>
    `;
  }

  function addTestimonial() {
    const list = document.getElementById("testimonials-list");
    const i = list.children.length;
    if (i >= 6) { alert("ניתן להוסיף עד 6 חוות דעת"); return; }
    list.insertAdjacentHTML("beforeend", testimonialCard({ quote: "", attribution: "" }, i));
    list.lastElementChild.querySelector(".remove-testimonial").addEventListener("click", (e) => {
      removeTestimonial(e.target.dataset.index);
    });
  }

  function removeTestimonial(index) {
    const card = document.querySelector(`.testimonial-card[data-index="${index}"]`);
    if (card) card.remove();
  }

  async function createPortfolio() {
    const btn = document.getElementById("createBtn");
    btn.disabled = true;
    btn.textContent = "יוצר...";
    try {
      const r = await fetch("/api/my-portfolio/create", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      const d = await r.json();
      if (d.portfolio_url) {
        window.location.reload();
      } else {
        throw new Error(d.error || "unknown");
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "יצירת דף נכסים";
      showStatus("שגיאה ביצירת הדף", "red");
    }
  }

  async function savePortfolio() {
    const btn = document.getElementById("saveBtn");
    btn.disabled = true;
    btn.textContent = "שומר...";

    // Collect testimonials
    const testimonials = [];
    document.querySelectorAll(".testimonial-card").forEach((card) => {
      testimonials.push({
        quote: card.querySelector(".t-quote").value.trim(),
        attribution: card.querySelector(".t-attribution").value.trim(),
      });
    });

    // Collect page visibility
    const properties = [];
    document.querySelectorAll(".page-row").forEach((row, i) => {
      properties.push({
        page_id: row.dataset.pageId,
        portfolio_visible: row.querySelector(".page-visible").checked,
        portfolio_rank: i,
      });
    });

    const body = {
      business_name: val("business_name"),
      full_name: val("full_name"),
      city: val("city"),
      license_number: val("license_number"),
      portfolio: {
        hero: { headline: val("hero_headline"), intro: val("hero_intro") },
        about: { body: val("about_body") },
        area: {
          headline: val("area_headline"),
          body: val("area_body"),
          locations: val("area_locations").split(",").map((s) => s.trim()).filter(Boolean),
        },
        testimonials,
        properties,
      },
    };

    try {
      const r = await fetch("/api/my-portfolio", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.ok) {
        showStatus("נשמר בהצלחה!", "green");
      } else {
        throw new Error(d.error || "unknown");
      }
    } catch (err) {
      showStatus("שגיאה בשמירה: " + err.message, "red");
    } finally {
      btn.disabled = false;
      btn.textContent = "שמירה";
    }
  }

  function val(id) {
    return document.getElementById(id)?.value?.trim() || "";
  }

  function showStatus(msg, color) {
    const s = document.getElementById("status");
    s.textContent = msg;
    s.style.color = color;
    s.style.display = "block";
    setTimeout(() => s.style.display = "none", 4000);
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }
})();
