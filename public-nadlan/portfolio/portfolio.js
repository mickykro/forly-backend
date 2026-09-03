/**
 * portfolio.js — renders portfolio matching docs/agent-portfolio-example.html
 */
(function() {
  var app = document.getElementById("portfolio-app");
  var slug = window.location.pathname.split("/").filter(Boolean)[0];

  if (!slug) {
    app.innerHTML = '<div class="no-results"><h2>דף לא נמצא</h2></div>';
    return;
  }

  var data = null;
  var filteredProperties = [];
  var visibleCount = 6;

  fetch("/api/portfolio?slug=" + encodeURIComponent(slug))
    .then(function(r) {
      if (r.redirected) { window.location.href = r.url; return null; }
      if (!r.ok) throw new Error("not_found");
      return r.json();
    })
    .then(function(d) {
      if (!d) return;
      data = d;
      filteredProperties = d.properties || [];
      render();
      trackEvent("view");
    })
    .catch(function() {
      app.innerHTML = '<div class="no-results"><h2>הדף לא נמצא</h2><p>ייתכן שהדף הוסר או שהכתובת שגויה.</p></div>';
    });

  function render() {
    var agent = data.agent;
    var portfolio = data.portfolio;
    var properties = data.properties || [];

    // Update meta
    document.getElementById("page-title").textContent = (agent.brand_name || agent.name) + " | נכסים";
    document.getElementById("page-description").content = portfolio.hero?.intro || "";
    document.getElementById("canonical-url").href = data.canonical_url || "";

    var brandMark = agent.logo_url
      ? '<img class="brand-logo" src="' + esc(agent.logo_url) + '" alt="">'
      : '<span class="brand-mark">' + esc((agent.brand_name || agent.name || "").charAt(0)) + '</span>';

    var portraitHtml = portfolio.hero?.portrait_url
      ? '<img class="portrait" src="' + esc(portfolio.hero.portrait_url) + '" alt="' + esc(agent.name) + '">'
      : '';

    var dealTypes = getUniqueDealTypes();

    app.innerHTML = '\
      <header class="wrap nav">\
        <a class="brand" href="#top">' + brandMark + '<span>' + esc(agent.brand_name || agent.name) + '</span></a>\
        <a href="#contact">יצירת קשר</a>\
      </header>\
      <main id="top">\
        <section class="hero">\
          <div class="wrap hero-grid">\
            <div>\
              <p class="eyebrow">נכסים נבחרים למכירה ולהשכרה</p>\
              <h1>' + esc(portfolio.hero?.headline || "מוצאים את המקום") + '<br><em>' + esc(portfolio.hero?.headline ? "" : "שמרגיש כמו בית.") + '</em></h1>\
              <p class="intro">' + esc(portfolio.hero?.intro || "") + '</p>\
              <div class="actions"><a class="button" href="#properties">לנכסים שלנו</a><button class="button alt" data-lead>דברו איתנו</button></div>\
            </div>\
            <aside class="profile">\
              ' + (agent.city ? '<span class="profile-city">' + esc(agent.city) + '</span>' : '') + '\
              ' + portraitHtml + '\
              <div class="profile-copy">\
                <div class="profile-top">\
                  ' + (agent.logo_url ? '<img class="profile-logo" src="' + esc(agent.logo_url) + '" alt="">' : '') + '\
                  <div><h2>' + esc(agent.brand_name || agent.name) + '</h2><small>' + esc(agent.name) + (agent.license ? ' · רישיון תיווך ' + esc(agent.license) : '') + '</small></div>\
                </div>\
                <dl>\
                  ' + (agent.city ? '<div><dt>אזור התמחות</dt><dd>' + esc(agent.city) + '</dd></div>' : '') + '\
                  ' + (dealTypes ? '<div><dt>סוגי נכסים</dt><dd>' + esc(dealTypes) + '</dd></div>' : '') + '\
                  <div><dt>מענה אישי</dt><dd>נחזור אליכם במהירות</dd></div>\
                  <div><dt>ליווי</dt><dd>עד לקבלת המפתח</dd></div>\
                </dl>\
              </div>\
            </aside>\
          </div>\
        </section>\
        <section class="wrap listings" id="properties">\
          <div class="section-head">\
            <div><p class="eyebrow">הנכסים שלנו</p><h2>הזדמנויות שמחכות לכם.</h2></div>\
            <p><span class="count" id="property-count">' + properties.length + ' נכסים פעילים</span> · מתעדכן בזמן אמת</p>\
          </div>\
          ' + renderFilters() + '\
          <div class="grid" id="property-grid"></div>\
          <div id="no-results" class="no-results" style="display:none"><p>לא נמצאו נכסים תואמים.</p><a href="#" onclick="clearFilters();return false;">ניקוי סינון</a></div>\
          <button class="button alt more" id="load-more" style="display:none">לטעינת נכסים נוספים</button>\
        </section>\
        ' + renderAbout(agent, portfolio) + '\
        ' + renderTestimonials(portfolio) + '\
        <section class="contact" id="contact">\
          <div class="wrap contact-grid">\
            <div>\
              <p class="eyebrow" style="color:#d5b77d">לא מצאתם בדיוק מה שחיפשתם?</p>\
              <h2>ספרו לנו מה אתם<br><em>מחפשים.</em></h2>\
              <p>השאירו פרטים. ' + esc(agent.name || "אנחנו") + ' ' + (agent.name ? 'יחזור' : 'נחזור') + ' אליכם עם הזדמנויות מתאימות.</p>\
            </div>\
            <form id="contact-form">\
              <input name="name" required placeholder="שם מלא">\
              <input name="phone" required type="tel" placeholder="טלפון נייד">\
              <button class="button">שלחו פרטים</button>\
            </form>\
          </div>\
        </section>\
      </main>\
      <footer class="wrap footer">' + esc(agent.brand_name || agent.name) + ' · כל הזכויות שמורות · נבנה באמצעות Forly</footer>\
    ';

    renderProperties();
    setupModal();
    setupForms();
    setupFilters();
  }

  function renderFilters() {
    var cities = getUniqueCities();
    return '\
      <div class="filters">\
        <input type="text" id="filter-search" placeholder="חיפוש...">\
        <select id="filter-type">\
          <option value="">כל סוגי העסקה</option>\
          <option value="sale">מכירה</option>\
          <option value="rent">השכרה</option>\
        </select>\
        <select id="filter-city">\
          <option value="">כל הערים</option>\
          ' + cities.map(function(c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join("") + '\
        </select>\
      </div>\
    ';
  }

  function renderProperties() {
    var grid = document.getElementById("property-grid");
    var noResults = document.getElementById("no-results");
    var loadMore = document.getElementById("load-more");
    var countEl = document.getElementById("property-count");

    if (!grid) return;

    var visible = filteredProperties.slice(0, visibleCount);
    countEl.textContent = filteredProperties.length + " נכסים" + (filteredProperties.length !== data.properties.length ? " מסוננים" : " פעילים");

    if (filteredProperties.length === 0) {
      grid.innerHTML = "";
      noResults.style.display = "block";
      loadMore.style.display = "none";
      return;
    }

    noResults.style.display = "none";
    grid.innerHTML = visible.map(function(p) {
      var tagText = p.listing_type === "rent" ? "להשכרה" : "למכירה";
      return '\
        <a class="card" href="' + esc(p.url) + '">\
          <div class="photo">\
            ' + (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="' + esc(p.title) + '" loading="lazy">' : '') + '\
            <span class="tag">' + tagText + '</span>\
          </div>\
          <div class="card-body">\
            <p class="location">' + esc(p.neighborhood || p.city) + '</p>\
            <h3>' + esc(p.title) + '</h3>\
            <div class="meta">\
              ' + (p.rooms ? '<span>' + p.rooms + ' חדרים</span>' : '') + '\
              ' + (p.size_sqm ? '<span>' + p.size_sqm + ' מ״ר</span>' : '') + '\
            </div>\
            <p class="price">' + formatPrice(p.price, p.listing_type) + '</p>\
          </div>\
        </a>\
      ';
    }).join("");

    loadMore.style.display = visibleCount < filteredProperties.length ? "block" : "none";
  }

  function renderAbout(agent, portfolio) {
    if (!portfolio.about?.body && !agent.city && !agent.license) return "";
    var locations = (portfolio.area?.locations || []).join(", ") || agent.city || "";
    return '\
      <section class="about" id="about">\
        <div class="wrap about-grid">\
          <div class="about-card">\
            <p class="eyebrow">קצת עלינו</p>\
            <h2>' + esc(portfolio.area?.headline || "הדרך הנכונה") + '<br>' + (portfolio.area?.headline ? "" : "למצוא <em>בית.</em>") + '</h2>\
          </div>\
          <div class="about-copy">\
            ' + (portfolio.about?.body ? '<p>' + esc(portfolio.about.body) + '</p>' : '') + '\
            ' + (portfolio.area?.body ? '<p>' + esc(portfolio.area.body) + '</p>' : '') + '\
            <div class="credentials">\
              ' + (locations ? '<div class="credential"><b>' + esc(locations) + '</b><span>אזור ההתמחות</span></div>' : '') + '\
              ' + (agent.license ? '<div class="credential"><b>' + esc(agent.license) + '</b><span>רישיון תיווך</span></div>' : '') + '\
              <div class="credential"><b>אישי</b><span>ליווי מתחילתו ועד סופו</span></div>\
            </div>\
          </div>\
        </div>\
      </section>\
    ';
  }

  function renderTestimonials(portfolio) {
    var testimonials = portfolio.testimonials || [];
    if (testimonials.length === 0) return "";
    return '\
      <section class="wrap testimonials" id="testimonials">\
        <div class="testimonials-head">\
          <p class="eyebrow">לקוחות מספרים</p>\
          <h2>עסקה טובה מתחילה<br>באמון.</h2>\
        </div>\
        <div class="quotes">\
          ' + testimonials.map(function(t) {
            return '\
              <article class="quote">\
                <span class="quote-mark">״</span>\
                <p>' + esc(t.quote) + '</p>\
                <footer>' + esc(t.attribution) + '</footer>\
              </article>\
            ';
          }).join("") + '\
        </div>\
      </section>\
    ';
  }

  function setupFilters() {
    var search = document.getElementById("filter-search");
    var type = document.getElementById("filter-type");
    var city = document.getElementById("filter-city");
    var loadMore = document.getElementById("load-more");

    if (search) search.addEventListener("input", applyFilters);
    if (type) type.addEventListener("change", applyFilters);
    if (city) city.addEventListener("change", applyFilters);
    if (loadMore) loadMore.addEventListener("click", function() {
      visibleCount += 6;
      renderProperties();
    });
  }

  function applyFilters() {
    var searchVal = (document.getElementById("filter-search")?.value || "").toLowerCase();
    var typeVal = document.getElementById("filter-type")?.value || "";
    var cityVal = document.getElementById("filter-city")?.value || "";

    visibleCount = 6;
    filteredProperties = data.properties.filter(function(p) {
      if (typeVal && p.listing_type !== typeVal) return false;
      if (cityVal && p.city !== cityVal) return false;
      if (searchVal) {
        var text = (p.title + " " + p.city + " " + (p.neighborhood || "")).toLowerCase();
        if (text.indexOf(searchVal) === -1) return false;
      }
      return true;
    });
    renderProperties();
  }

  window.clearFilters = function() {
    var search = document.getElementById("filter-search");
    var type = document.getElementById("filter-type");
    var city = document.getElementById("filter-city");
    if (search) search.value = "";
    if (type) type.value = "";
    if (city) city.value = "";
    filteredProperties = data.properties;
    visibleCount = 6;
    renderProperties();
  };

  function setupModal() {
    var modal = document.getElementById("modal");
    var closeBtn = modal.querySelector(".close");

    document.querySelectorAll("[data-lead]").forEach(function(btn) {
      btn.addEventListener("click", function() { modal.classList.add("open"); });
    });

    closeBtn.addEventListener("click", function() { modal.classList.remove("open"); });
    modal.addEventListener("click", function(e) {
      if (e.target === modal) modal.classList.remove("open");
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape") modal.classList.remove("open");
    });
  }

  function setupForms() {
    document.querySelectorAll("#contact-form, #modal-form").forEach(function(form) {
      form.addEventListener("submit", function(e) {
        e.preventDefault();
        var fd = new FormData(form);
        var btn = form.querySelector("button");
        btn.disabled = true;
        btn.textContent = "שולח...";

        fetch("/api/portfolio-lead", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: slug,
            name: fd.get("name"),
            phone: fd.get("phone")
          })
        })
        .then(function() {
          form.innerHTML = "<strong>הפרטים התקבלו. נחזור אליכם בקרוב.</strong>";
        })
        .catch(function() {
          btn.disabled = false;
          btn.textContent = "שלחו פרטים";
          alert("שגיאה בשליחה. נסו שוב.");
        });
      });
    });
  }

  function getUniqueCities() {
    var seen = {};
    return data.properties.filter(function(p) {
      if (!p.city || seen[p.city]) return false;
      seen[p.city] = true;
      return true;
    }).map(function(p) { return p.city; });
  }

  function getUniqueDealTypes() {
    var types = [];
    data.properties.forEach(function(p) {
      if (p.listing_type === "sale" && types.indexOf("מכירה") === -1) types.push("מכירה");
      if (p.listing_type === "rent" && types.indexOf("השכרה") === -1) types.push("השכרה");
    });
    return types.join(" ו") || "";
  }

  function formatPrice(price, type) {
    if (!price) return "";
    var f = new Intl.NumberFormat("he-IL").format(price);
    return type === "rent" ? "₪ " + f + " <small>לחודש</small>" : "₪ " + f;
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  function trackEvent(event) {
    navigator.sendBeacon("/api/portfolio-event", JSON.stringify({ slug: slug, event: event }));
  }
})();
