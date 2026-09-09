/**
 * portfolio.js — agent portfolio editor with form → preview → create flow
 */
(function() {
  const editor = document.getElementById("editor");
  let data = null;
  let showingPreview = false;
  let portraitUrl = null; // uploaded portrait URL

  FLY.req("/api/my-portfolio", { noRedirect: true })
    .then((d) => {
      data = d;
      render();
    })
    .catch((e) => {
      if (e.status === 403) {
        editor.innerHTML = "<p>דף הנכסים אינו פעיל בחשבון שלך. <a href='/'>חזרה</a></p>";
        return;
      }
      if (e.status === 401) {
        window.location.href = "/?next=" + encodeURIComponent("/portfolio.html");
        return;
      }
      editor.innerHTML = "<p>שגיאה בטעינת הנתונים. <a href='/'>חזרה</a></p>";
    });

  function render() {
    const { profile, portfolio, pages } = data;
    const hasPortfolio = !!portfolio;
    const p = portfolio || {}; // use empty object for new portfolios
    portraitUrl = p.hero?.portrait_url || null;

    editor.innerHTML = `
      ${hasPortfolio ? `
        <div class="portfolio-link">
          <span>דף הנכסים שלך:</span>
          <a href="${esc(rel(portfolio.url))}" target="_blank">${esc(location.host + rel(portfolio.url))}</a>
        </div>
      ` : `
        <div class="info-banner">
          <b>יצירת דף נכסים חדש</b>
          <span>מלאו את הפרטים, צפו בתצוגה מקדימה ואשרו.</span>
        </div>
      `}

      <div id="formView">
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

        <h2>תמונת פרופיל</h2>
        <div class="field portrait-field">
          <div class="portrait-preview" id="portraitPreview">
            ${p.hero?.portrait_url ? `<img src="${esc(p.hero.portrait_url)}" alt="תמונת פרופיל">` : '<span class="no-portrait">לא הועלתה תמונה</span>'}
          </div>
          <div class="portrait-actions">
            <label class="btn btn-ghost btn-sm">
              <input type="file" id="portraitInput" accept="image/jpeg,image/png,image/webp" style="display:none">
              ${p.hero?.portrait_url ? 'החלפת תמונה' : 'העלאת תמונה'}
            </label>
            ${p.hero?.portrait_url ? '<button type="button" class="btn btn-ghost btn-sm" id="removePortrait">הסרת תמונה</button>' : ''}
          </div>
          <p class="field-hint">תמונה שתופיע בדף הפורטפוליו שלכם. מומלץ תמונה אנכית באיכות גבוהה.</p>
        </div>

        <h2>כותרת הדף</h2>
        <div class="field">
          <label>כותרת ראשית</label>
          <input id="hero_headline" value="${esc(p.hero?.headline || "")}" maxlength="120" placeholder="לדוגמה: נדל״ן בתל אביב עם ${esc(profile.full_name || "השם שלך")}">
        </div>
        <div class="field">
          <label>תיאור קצר</label>
          <textarea id="hero_intro" maxlength="500" placeholder="משפט או שניים שמתארים את השירות שלכם...">${esc(p.hero?.intro || "")}</textarea>
        </div>

        <h2>אודות</h2>
        <div class="field">
          <textarea id="about_body" maxlength="1500" placeholder="ספרו על עצמכם והניסיון שלכם...">${esc(p.about?.body || "")}</textarea>
        </div>

        <h2>אזורי פעילות</h2>
        <div class="field">
          <label>כותרת</label>
          <input id="area_headline" value="${esc(p.area?.headline || "")}" maxlength="120" placeholder="לדוגמה: אזורי הפעילות שלי">
        </div>
        <div class="field">
          <label>תיאור</label>
          <textarea id="area_body" maxlength="1500" placeholder="תארו את האזורים שאתם מתמחים בהם...">${esc(p.area?.body || "")}</textarea>
        </div>
        <div class="field">
          <label>ערים/שכונות (מופרדות בפסיק)</label>
          <input id="area_locations" value="${esc((p.area?.locations || []).join(", "))}" placeholder="תל אביב, רמת גן, גבעתיים">
        </div>

        <h2>חוות דעת</h2>
        <div id="testimonials-list">
          ${(p.testimonials || []).map((t, i) => testimonialCard(t, i)).join("")}
        </div>
        <button class="btn btn-ghost btn-sm" id="addTestimonial">+ הוספת חוות דעת</button>
        <p class="legal-warning">פרסום חוות דעת שאינן אמיתיות עלול להוות הפרת חוק ולחשוף אתכם לתביעה.</p>

        ${pages.length ? `
          <h2>נכסים בדף</h2>
          <div id="pages-list">
            ${pages.map((pg) => pageRow(pg)).join("")}
          </div>
        ` : ""}

        <div class="btn-row">
          <button class="btn btn-gold" id="previewBtn">תצוגה מקדימה</button>
        </div>
      </div>

      <div id="previewView" class="hidden">
        <div class="preview-header">
          <button class="btn btn-ghost" id="backToFormBtn">← חזרה לעריכה</button>
          <h2>תצוגה מקדימה</h2>
        </div>
        <div id="previewContent" class="preview-frame"></div>
        <div class="btn-row">
          <button class="btn btn-ghost" id="backToFormBtn2">← חזרה לעריכה</button>
          <button class="btn btn-gold" id="confirmBtn">${hasPortfolio ? "שמירת שינויים" : "אישור ויצירה"}</button>
        </div>
      </div>

      <p id="status" style="text-align:center;margin-top:16px;display:none"></p>
    `;

    // Bind events
    document.getElementById("previewBtn").addEventListener("click", showPreview);
    document.getElementById("backToFormBtn").addEventListener("click", hidePreview);
    document.getElementById("backToFormBtn2").addEventListener("click", hidePreview);
    document.getElementById("confirmBtn").addEventListener("click", hasPortfolio ? savePortfolio : createPortfolio);
    document.getElementById("addTestimonial").addEventListener("click", addTestimonial);
    document.querySelectorAll(".remove-testimonial").forEach((btn) => {
      btn.addEventListener("click", () => removeTestimonial(btn.dataset.index));
    });

    // Portrait upload
    document.getElementById("portraitInput").addEventListener("change", handlePortraitUpload);
    const removeBtn = document.getElementById("removePortrait");
    if (removeBtn) removeBtn.addEventListener("click", removePortrait);
  }

  async function handlePortraitUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Validate file type and size
    const validTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!validTypes.includes(file.type)) {
      alert("יש להעלות קובץ מסוג JPEG, PNG או WebP בלבד.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      alert("גודל הקובץ המקסימלי הוא 10MB.");
      return;
    }

    const preview = document.getElementById("portraitPreview");
    preview.innerHTML = '<span class="uploading">מעלה...</span>';

    try {
      const urls = await FLY.uploadFiles([file]);
      if (urls && urls[0]) {
        portraitUrl = urls[0];
        updatePortraitPreview();
      } else {
        throw new Error("upload_failed");
      }
    } catch (err) {
      preview.innerHTML = '<span class="no-portrait">שגיאה בהעלאה</span>';
      alert("שגיאה בהעלאת התמונה. נסו שוב.");
    }
  }

  function removePortrait() {
    portraitUrl = null;
    updatePortraitPreview();
  }

  function updatePortraitPreview() {
    const preview = document.getElementById("portraitPreview");
    const actionsDiv = preview.nextElementSibling;

    if (portraitUrl) {
      preview.innerHTML = `<img src="${esc(portraitUrl)}" alt="תמונת פרופיל">`;
      actionsDiv.innerHTML = `
        <label class="btn btn-ghost btn-sm">
          <input type="file" id="portraitInput" accept="image/jpeg,image/png,image/webp" style="display:none">
          החלפת תמונה
        </label>
        <button type="button" class="btn btn-ghost btn-sm" id="removePortrait">הסרת תמונה</button>
      `;
    } else {
      preview.innerHTML = '<span class="no-portrait">לא הועלתה תמונה</span>';
      actionsDiv.innerHTML = `
        <label class="btn btn-ghost btn-sm">
          <input type="file" id="portraitInput" accept="image/jpeg,image/png,image/webp" style="display:none">
          העלאת תמונה
        </label>
      `;
    }

    // Re-bind events
    document.getElementById("portraitInput").addEventListener("change", handlePortraitUpload);
    const removeBtn = document.getElementById("removePortrait");
    if (removeBtn) removeBtn.addEventListener("click", removePortrait);
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

  function collectFormData() {
    const testimonials = [];
    document.querySelectorAll(".testimonial-card").forEach((card) => {
      const quote = card.querySelector(".t-quote").value.trim();
      const attribution = card.querySelector(".t-attribution").value.trim();
      if (quote || attribution) testimonials.push({ quote, attribution });
    });

    const properties = [];
    document.querySelectorAll(".page-row").forEach((row, i) => {
      properties.push({
        page_id: row.dataset.pageId,
        portfolio_visible: row.querySelector(".page-visible").checked,
        portfolio_rank: i,
      });
    });

    return {
      business_name: val("business_name"),
      full_name: val("full_name"),
      city: val("city"),
      license_number: val("license_number"),
      portfolio: {
        hero: { headline: val("hero_headline"), intro: val("hero_intro"), portrait_url: portraitUrl },
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
  }

  async function showPreview() {
    const f = collectFormData();
    // Real preview: feed the live portfolio renderer the unsaved form data.
    let properties = [];
    const slug = data.portfolio?.slug;
    if (slug) {
      properties = await fetch("/api/portfolio?slug=" + encodeURIComponent(slug))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d && d.properties) || [])
        .catch(() => []);
    }
    sessionStorage.setItem("portfolio_preview", JSON.stringify({
      agent: {
        name: f.full_name,
        brand_name: f.business_name,
        logo_url: data.profile.logo_url || null,
        city: f.city,
        license: f.license_number,
      },
      portfolio: f.portfolio,
      properties,
      canonical_url: "",
    }));

    document.getElementById("previewContent").innerHTML =
      '<iframe class="preview-iframe" src="/portfolio/index.html?preview=1"></iframe>';
    document.getElementById("formView").classList.add("hidden");
    document.getElementById("previewView").classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  function hidePreview() {
    document.getElementById("previewView").classList.add("hidden");
    document.getElementById("formView").classList.remove("hidden");
  }

  async function createPortfolio() {
    const btn = document.getElementById("confirmBtn");
    btn.disabled = true;
    btn.textContent = "יוצר...";

    const formData = collectFormData();

    try {
      // First create the portfolio
      const createRes = await FLY.req("/api/my-portfolio/create", { method: "POST", body: {}, noRedirect: true });
      if (!createRes.portfolio_url) throw new Error(createRes.error || "create_failed");

      // Then save the form data
      const saveRes = await FLY.req("/api/my-portfolio", { method: "POST", body: formData, noRedirect: true });
      if (!saveRes.ok) throw new Error(saveRes.error || "save_failed");

      // Success - redirect to view
      window.location.href = createRes.portfolio_url;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "אישור ויצירה";
      showStatus("שגיאה ביצירת הדף: " + (err.code || err.message), "red");
    }
  }

  async function savePortfolio() {
    const btn = document.getElementById("confirmBtn");
    btn.disabled = true;
    btn.textContent = "שומר...";

    const formData = collectFormData();

    try {
      const d = await FLY.req("/api/my-portfolio", { method: "POST", body: formData, noRedirect: true });
      if (d.ok) {
        showStatus("נשמר בהצלחה!", "green");
        hidePreview();
      } else {
        throw new Error(d.error || "unknown");
      }
    } catch (err) {
      showStatus("שגיאה בשמירה: " + (err.code || err.message), "red");
    } finally {
      btn.disabled = false;
      btn.textContent = "שמירת שינויים";
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

  // ponytail: server may still hand back an absolute URL — keep links same-origin
  const rel = (u) => String(u || "").replace(/^https?:\/\/[^/]+/, "");

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }
})();
