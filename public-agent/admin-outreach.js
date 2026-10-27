(function () {
  "use strict";
  var $ = function (s) {
      return document.querySelector(s);
    },
    esc = FLY.esc,
    api = "/api/admin/outreach",
    selected = null,
    cursor = null,
    detailTimer = null,
    reviewFacts = {},
    deliveryCopy = {},
    scanTimer = null,
    scanId = null,
    scanWarnings = [];
  function error(e) {
    $("#outreachError").textContent =
      e && e.code === "stepup_required"
        ? "נדרש אימות OTP מחדש לפני שינוי."
        : "הפעולה לא הושלמה: " + ((e && e.code) || "שגיאה");
  }
  function req(path, body) {
    return FLY.req(
      api + path,
      body
        ? { method: "POST", body: body, noRedirect: true }
        : { noRedirect: true },
    );
  }
  function scanTerminal(status) {
    return (
      [
        "done",
        "completed",
        "failed",
        "cancelled",
        "blocked",
        "outcome_unknown",
      ].indexOf(status) >= 0
    );
  }
  function renderScan(scan) {
    (Array.isArray(scan.warnings) ? scan.warnings : []).forEach(
      function (warning) {
        var text = typeof warning === "string" ? warning : warning.code;
        if (text && scanWarnings.indexOf(text) < 0) scanWarnings.push(text);
      },
    );
    var metrics = [
      ["קבוצות שנבדקו", "groups_visited"],
      ["פוסטים שנצפו", "posts_seen"],
      ["מועמדים שנבחרו", "selected"],
      ["כפילויות", "duplicates"],
    ];
    var html = field("מצב הסריקה", scan.status);
    if (scan.phase)
      html += field(
        "שלב",
        {
          reading_groups: "קריאת קבוצות ופוסטים",
          qualifying: "בחירת מועמדים מתאימים",
        }[scan.phase] || scan.phase,
      );
    if (scan.error_code)
      html += field(
        "נדרשת פעולה",
        {
          group_scan_login_required:
            "פרופיל הסריקה אינו מחובר לפייסבוק. התחברו לפרופיל והפעילו סריקה חדשה.",
          group_scan_checkpoint: "פייסבוק דורשת אימות בפרופיל הסריקה.",
          group_scan_captcha: "יש להשלים את בדיקת פייסבוק בפרופיל הסריקה.",
        }[scan.error_code] || scan.error_code,
      );
    metrics.forEach(function (pair) {
      var value = scan[pair[1]];
      html += field(
        pair[0],
        typeof value === "number" && Number.isFinite(value) ? value : "—",
      );
    });
    var reasons = scan.reasons || {};
    if (Array.isArray(reasons))
      html += field("סיכום בחירה ודחייה", reasons.join(", "));
    else
      Object.keys(reasons).forEach(function (reason) {
        html += field(reason, reasons[reason]);
      });
    if (scanWarnings.length)
      html +=
        "<h4>הערות הסריקה</h4><ul>" +
        scanWarnings
          .map(function (warning) {
            return "<li>" + esc(warning) + "</li>";
          })
          .join("") +
        "</ul>";
    $("#outreachScanProgress").innerHTML = html;
    $("#outreachScanStart").disabled = !scanTerminal(scan.status);
  }
  function pollScan() {
    if (!scanId) return;
    req("/scans/" + encodeURIComponent(scanId))
      .then(function (scan) {
        renderScan(scan);
        if (scanTerminal(scan.status)) {
          scanTimer = null;
          load();
        } else scanTimer = setTimeout(pollScan, 3000);
      })
      .catch(function (e) {
        error(e);
        $("#outreachScanStart").disabled = false;
      });
  }
  function restoreScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    return req("/scans")
      .then(function (data) {
        var scans = Array.isArray(data) ? data : data.scans || [];
        if (!scans.length) return;
        var scan = scans[0];
        scanId = scan.id || scan.scan_id;
        if (!scanId) return;
        scanWarnings = [];
        renderScan(scan);
        if (!scanTerminal(scan.status)) pollScan();
      })
      .catch(error);
  }
  function load(next) {
    return req(
      "/leads?limit=25" +
        (next && cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    )
      .then(function (data) {
        var rows = Array.isArray(data) ? data : data.leads || data.items || [];
        cursor = data.next_cursor || null;
        $("#outreachMore").classList.toggle("hidden", !cursor);
        $("#outreachList").innerHTML =
          "<p>" +
          esc(rows.length) +
          ' מועמדים בעמוד</p><table class="admin"><thead><tr><th>מזהה</th><th>מצב</th><th>דף / וידאו</th><th>תפוגה</th><th>שליחה / בעלות / תשלום</th></tr></thead><tbody>' +
          rows
            .map(function (row) {
              return (
                '<tr><td><button data-lead="' +
                esc(row.id) +
                '" class="btn btn-ghost">' +
                esc(row.id) +
                "</button></td><td>" +
                esc(row.status) +
                "</td><td>" +
                esc(row.page_ready ? "דף מוכן" : "ממתין") +
                " / " +
                esc(row.video_ready ? "וידאו מוכן" : "ממתין") +
                "</td><td>" +
                esc(row.expires_at || "—") +
                "</td><td>" +
                esc(row.delivery_status || "—") +
                " / " +
                esc(row.claim_status || "—") +
                " / " +
                esc(row.payment_status || "—") +
                "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table>";
      })
      .catch(error);
  }
  var actions = [
    ["extract", "חילוץ מהפוסט המאושר"],
    ["corrections", "תיקון עובדות מול המקור"],
    ["review", "אישור עובדות וזכויות"],
    ["reject", "דחייה"],
    ["build", "יצירת הדגמה"],
    ["delivery-approve", "אישור ערכת שליחה"],
    ["manual-confirm", "תיעוד שליחה ידנית"],
    ["suppress", "לא ליצור קשר"],
    ["verify-claim", "אימות בעלות"],
    ["payment", "התאמת תשלום"],
    ["upgrade", "שדרוג"],
  ];
  function field(label, value) {
    return value === null || value === undefined || value === ""
      ? ""
      : "<div><strong>" +
          esc(label) +
          '</strong><p style="white-space:pre-wrap">' +
          esc(String(value)) +
          "</p></div>";
  }
  function factsView(facts) {
    var labels = {
      location: "מיקום",
      property_type: "סוג נכס",
      listing_type: "עסקה",
      rooms: "חדרים",
      area: "שטח",
      price: "מחיר",
      floor: "קומה",
    };
    return Object.keys(labels)
      .map(function (key) {
        return field(labels[key], facts && facts[key]);
      })
      .join("");
  }
  function sourceLink(value) {
    try {
      var url = new URL(value);
      if (
        url.protocol === "https:" &&
        ["facebook.com", "www.facebook.com", "m.facebook.com"].indexOf(
          url.hostname,
        ) >= 0
      )
        return (
          '<a href="' +
          esc(url.href) +
          '" target="_blank" rel="noopener noreferrer">פתיחת הפוסט שנבדק</a>'
        );
    } catch (e) {}
    return "";
  }
  function detail(id) {
    if (detailTimer) clearTimeout(detailTimer);
    selected = id;
    deliveryCopy = {};
    req("/leads/" + encodeURIComponent(id))
      .then(function (data) {
        var lead = data.lead || data;
        reviewFacts = lead.facts || {};
        var pane = $("#outreachDetail");
        pane.classList.remove("hidden");
        if (lead.status === "extracting")
          detailTimer = setTimeout(function () {
            if (selected === id && !pane.classList.contains("hidden"))
              detail(id);
          }, 5000);
        var demo = lead.demo || {},
          review = lead.review || {},
          claim = lead.claim || {},
          payment = lead.payment || {},
          delivery = lead.delivery || {};
        pane.innerHTML =
          "<h3>בדיקת מועמד</h3>" +
          field("מזהה", id) +
          field("מצב", lead.status) +
          sourceLink(lead.source_post_url) +
          field("נוצר", lead.created_at) +
          "<h4>עובדות מהמקור</h4>" +
          factsView(reviewFacts) +
          field("טקסט המקור לבדיקה", lead.description) +
          field("תמונות שחולצו", (lead.images || []).length) +
          field(
            "בדיקות איכות",
            ((lead.quality && lead.quality.reasons) || []).join(", "),
          ) +
          "<h4>בדיקה ואסמכתאות</h4>" +
          field("אסמכתת עובדות וזכויות", review.evidence) +
          field("נבדק בתאריך", review.at) +
          field(
            "תיקון עובדות",
            lead.correction_review && lead.correction_review.reason,
          ) +
          "<h4>הדגמה והמשך טיפול</h4>" +
          field("דף", demo.page_ready ? "מוכן" : "ממתין") +
          field(
            "וידאו",
            demo.video_ready ? "מוכן" : demo.video_status || "ממתין",
          ) +
          field("תפוגה", demo.expires_at) +
          field(
            "בעלות",
            claim.contact
              ? claim.ownership_verified
                ? "אומתה"
                : "ממתינה לבדיקה"
              : "אין בקשה",
          ) +
          field("אסמכתת בעלות", claim.evidence) +
          field("תשלום", payment.reference ? "הותאם" : "ממתין") +
          field("הערת התאמת תשלום", payment.note) +
          field("מצב שליחה", delivery.status) +
          field("שליחה ידנית בתאריך", delivery.sent_at) +
          field("אסמכתת שליחה", delivery.evidence) +
          "<div>" +
          actions
            .map(function (a) {
              return (
                '<button class="btn btn-ghost" data-action="' +
                a[0] +
                '">' +
                a[1] +
                "</button>"
              );
            })
            .join(" ") +
          '</div><button class="btn btn-ghost" data-action="kit">ערכת שליחה מאושרת</button><div id="outreachKit"></div>';
      })
      .catch(error);
  }
  function kitView(kit) {
    deliveryCopy = {};
    var preview = kit.preview_url,
      video = kit.demo && kit.demo.video_url,
      message = kit.attempt && kit.attempt.message;
    var out = "<h4>ערכת שליחה מאושרת</h4>";
    if (typeof preview === "string" && /^\/d\/[A-Za-z0-9_-]+$/.test(preview)) {
      deliveryCopy.preview = location.origin + preview;
      out +=
        '<p><a href="' +
        esc(preview) +
        '" target="_blank" rel="noopener noreferrer">פתיחת ההדגמה</a> <button class="btn btn-ghost" data-copy="preview">העתקת קישור ההדגמה</button></p>';
    }
    if (typeof message === "string") {
      deliveryCopy.message = message;
      out +=
        '<p style="white-space:pre-wrap">' +
        esc(message) +
        '</p><button class="btn btn-ghost" data-copy="message">העתקת נוסח מאושר</button>';
    }
    if (
      typeof video === "string" &&
      /^\/api\/outreach\/assets\/[A-Za-z0-9_-]+\?token=[A-Za-z0-9_-]+$/.test(
        video,
      )
    ) {
      deliveryCopy.video = location.origin + video;
      out +=
        '<p><a href="' +
        esc(video) +
        '" target="_blank" rel="noopener noreferrer">וידאו עם סימן מים</a> <button class="btn btn-ghost" data-copy="video">העתקת קישור הווידאו</button></p>';
    } else out += "<p>הווידאו עדיין לא מוכן. אין לציין שנוצר וידאו.</p>";
    out +=
      field("תפוגה", kit.demo && kit.demo.expires_at) +
      field("גרסת נוסח", kit.attempt && kit.attempt.copy_hash);
    $("#outreachKit").innerHTML = out;
  }
  function action(name) {
    if (name === "kit") {
      req("/leads/" + encodeURIComponent(selected) + "/delivery-kit")
        .then(function (kit) {
          kitView(kit);
        })
        .catch(error);
      return;
    }
    var reason = window.prompt("סיבה לפעולה (ללא פרטי קשר):");
    if (!reason) return;
    var body = { reason: reason, idempotency_key: crypto.randomUUID() };
    if (name === "review") {
      if (
        !window.confirm(
          "העובדות נבדקו מול המקור והשימוש במדיה מותר לפי המדיניות המאושרת?",
        )
      )
        return;
      body.facts_verified = true;
      body.right_to_use = true;
      body.factual_accuracy = true;
      body.policy_approved = true;
      body.evidence =
        window.prompt("אסמכתה לאישור העובדות והשימוש במדיה:") || "";
    }
    if (name === "extract") {
      body.approved_source = true;
    }
    if (name === "corrections") {
      try {
        body.facts = JSON.parse(
          window.prompt(
            "תיקון עובדות לפי המקור בלבד: location, property_type, listing_type, rooms, area, price, floor",
            JSON.stringify(reviewFacts, null, 2),
          ) || "{}",
        );
      } catch (e) {
        return;
      }
    }
    if (name === "delivery-approve") {
      body.channel = window.prompt("ערוץ מורשה:");
      body.sender = window.prompt("חשבון השולח:");
      body.recipient_identifier = window.prompt(
        "מזהה נמען לצורך מניעת קשר חוזר:",
      );
      body.message = window.prompt("נוסח ההודעה המאושר:");
      body.permitted_channel = window.confirm(
        "הערוץ והחשבון מורשים ליצירת קשר זו?",
      );
    }
    if (name === "suppress") {
      body.recipient_identifier = window.prompt(
        "מזהה נמען (או ריק לשימוש ברשומה המאושרת):",
      );
    }
    if (name === "manual-confirm") {
      body.channel = window.prompt("ערוץ מורשה:");
      body.sender = window.prompt("מזהה חשבון השולח:");
      body.sent_at = window.prompt(
        "מועד שליחה (ISO):",
        new Date().toISOString(),
      );
      body.evidence = window.prompt("אסמכתה לאישור שליחה:");
    }
    if (name === "verify-claim") {
      body.evidence = window.prompt("אסמכתה לאימות בעלות על הנכס:");
      body.business_phone = window.prompt("טלפון העסק המאומת בבקשת הבעלות:");
    }
    if (name === "payment") {
      body.payment_reference = window.prompt("אסמכתה מוגנת לתשלום:");
      body.reconciliation_note = reason;
    }
    if (name === "upgrade") {
      body.payment_reference = window.prompt("אסמכתה לתשלום שהותאם:");
    }
    req("/leads/" + encodeURIComponent(selected) + "/" + name, body)
      .then(function () {
        detail(selected);
        load();
      })
      .catch(error);
  }
  var tab = $("#tabOutreach"),
    pane = $("#paneOutreach");
  if (!tab || !pane) return;
  tab.addEventListener("click", function () {
    document.querySelectorAll(".tabs button").forEach(function (b) {
      b.classList.toggle("on", b === tab);
    });
    document.querySelectorAll('#viewAdmin [id^="pane"]').forEach(function (p) {
      p.classList.toggle("hidden", p !== pane);
    });
    load();
    restoreScan();
  });
  document.querySelectorAll(".tabs button").forEach(function (b) {
    if (b !== tab)
      b.addEventListener("click", function () {
        tab.classList.remove("on");
        pane.classList.add("hidden");
      });
  });
  $("#outreachScanForm").addEventListener("submit", function (event) {
    event.preventDefault();
    if (scanTimer) clearTimeout(scanTimer);
    var form = event.currentTarget;
    var body = {
      campaign_id: form.campaign_id.value || "outreach",
      max_groups: Number(form.max_groups.value) || 3,
      max_candidates: Number(form.max_candidates.value) || 5,
      idempotency_key: crypto.randomUUID(),
    };
    $("#outreachScanStart").disabled = true;
    scanWarnings = [];
    $("#outreachScanProgress").textContent = "ממתינים לאישור תחילת הסריקה…";
    req("/scans", body)
      .then(function (scan) {
        scanId = scan.id || scan.scan_id;
        if (!scanId) throw { code: "invalid_scan_response" };
        renderScan(scan);
        if (scanTerminal(scan.status)) load();
        else pollScan();
      })
      .catch(function (e) {
        error(e);
        $("#outreachScanStart").disabled = false;
      });
  });
  $("#outreachCapture").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    req("/leads", {
      source_post_url: form.source_post_url.value,
      campaign_id: form.campaign_id.value,
      reason: "Operator supplied approved source URL",
    })
      .then(function () {
        form.reset();
        load();
      })
      .catch(error);
  });
  $("#outreachRefresh").addEventListener("click", function () {
    load();
  });
  $("#outreachMore").addEventListener("click", function () {
    load(true);
  });
  $("#outreachList").addEventListener("click", function (event) {
    var button = event.target.closest("[data-lead]");
    if (button) detail(button.dataset.lead);
  });
  $("#outreachDetail").addEventListener("click", function (event) {
    var copy = event.target.closest("[data-copy]");
    if (copy && deliveryCopy[copy.dataset.copy]) {
      if (!navigator.clipboard) {
        FLY.toast("ההעתקה דורשת חיבור מאובטח");
        return;
      }
      navigator.clipboard
        .writeText(deliveryCopy[copy.dataset.copy])
        .then(function () {
          FLY.toast("הועתק");
        })
        .catch(function () {
          FLY.toast("לא ניתן להעתיק, נסו שוב");
        });
      return;
    }
    var button = event.target.closest("[data-action]");
    if (button) action(button.dataset.action);
  });
})();
