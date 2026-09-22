/*
 * Forly help pages — renders window.FORLY_DOCS (instructions/content/*.js) as
 * /instructions and /instructions/<slug>. The server sends this same page for
 * every slug; routing, search, checklists and chat demos all live here.
 */
(function () {
  var DOCS = (window.FORLY_DOCS || []).slice().sort(function (a, b) { return a.order - b.order; });
  var BY = {};
  DOCS.forEach(function (d) { BY[d.slug] = d; });
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var main = $("#main"), nav = $("#nav"), q = $("#q"), side = $("#side");
  var BASE = "/instructions";

  // ── text: escape, then `chip`, **bold**, [label](/instructions/x) ──
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<button type="button" class="chip" data-copy="$1" title="העתקה">$1</button>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((\/instructions[^)\s]*)\)/g, '<a href="$2" data-nav>$1</a>')
      // numbers and addresses stay left-to-right inside Hebrew text
      .replace(/(^|[\s(])(?:https?:\/\/)?(wa\.me\/\d+)/g, '$1<a dir="ltr" href="https://$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\+972[\d\s-]{8,}\d/g, '<bdi dir="ltr">$&</bdi>');
  }
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: progress just isn't kept */ } },
  };

  // ── sections ──
  var R = {
    intro: function (s) { return '<p class="intro">' + inline(s.text) + "</p>"; },
    tip: function (s) { return '<div class="callout">💡 ' + inline(s.text) + "</div>"; },
    warning: function (s) { return '<div class="callout warn">⚠️ ' + inline(s.text) + "</div>"; },
    rules: function (s) { return box(s, '<ul class="rules">' + s.items.map(function (i) { return "<li>" + inline(i) + "</li>"; }).join("") + "</ul>"); },
    table: function (s) {
      var head = "<tr>" + s.head.map(function (h) { return "<th>" + inline(h) + "</th>"; }).join("") + "</tr>";
      var rows = s.rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("");
      return box(s, '<div class="tbl"><table><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>");
    },
    faq: function (s) {
      return box(s, s.items.map(function (i) { return "<details><summary>" + inline(i.q) + "</summary><p>" + inline(i.a) + "</p></details>"; }).join(""));
    },
    cards: function (s) { return box(s, cards(s.items)); },
    steps: function (s) {
      var done = store.get("forly-docs:" + s.id) || [];
      var items = s.steps.map(function (st, i) {
        var on = done.indexOf(i) >= 0;
        return '<li class="' + (on ? "done" : "") + '"><input type="checkbox" aria-label="סימון שלב ' + (i + 1) + '" data-step="' + s.id + '" data-i="' + i + '"' + (on ? " checked" : "") + ">" +
          "<div><b>" + inline(st.title) + "</b><p>" + inline(st.text) + "</p>" + (st.tip ? '<div class="tipline">💡 ' + inline(st.tip) + "</div>" : "") + "</div></li>";
      }).join("");
      return box(s, '<div class="progress" data-for="' + s.id + '"><div class="bar"><i></i></div><span></span><button type="button" data-reset="' + s.id + '">איפוס</button></div><ol class="steps">' + items + "</ol>");
    },
    chat: function (s, idx) {
      var body = '<div class="phone"><div class="phone-head"><i>🦉</i><div><b>פורלי</b><br><small>וואטסאפ</small></div></div>' +
        '<div class="thread" data-chat="' + idx + '"></div></div>' +
        '<div class="chat-ctl"><button type="button" class="btn line" data-play="' + idx + '">▶ הצגה</button><button type="button" class="btn line" data-all="' + idx + '">הצגת הכל</button></div>' +
        (s.caption ? '<p class="caption">' + inline(s.caption) + "</p>" : "");
      return box(s, body);
    },
  };
  function box(s, html) { return '<section class="sec">' + (s.title ? "<h2>" + inline(s.title) + "</h2>" : "") + html + "</section>"; }
  function cards(items) {
    return '<div class="cards">' + items.map(function (c) {
      var d = BY[c.slug] || {};
      return '<a class="card" href="' + BASE + "/" + (c.slug || "") + '" data-nav><span class="ic">' + esc(c.icon || d.icon || "📄") + "</span><b>" + inline(c.title || d.title) + "</b><span>" + inline(c.text || d.summary || "") + "</span></a>";
    }).join("") + "</div>";
  }

  // ── pages ──
  var chats = [];
  function renderDoc(d) {
    chats = [];
    var i = DOCS.indexOf(d), prev = DOCS[i - 1], next = DOCS[i + 1];
    var html = '<div class="crumbs"><a href="' + BASE + '" data-nav>מדריך</a> › ' + esc(d.title) + "</div>" +
      "<h1>" + esc(d.icon) + " " + esc(d.title) + "</h1>" +
      (d.badge ? '<span class="badge">' + esc(d.badge) + "</span>" : "") +
      '<p class="summary">' + inline(d.summary) + "</p>" +
      d.sections.map(function (s) {
        if (s.type === "chat") { chats.push(s); return R.chat(s, chats.length - 1); }
        return R[s.type] ? R[s.type](s) : "";
      }).join("") +
      '<div class="pager">' + (prev ? '<a href="' + BASE + "/" + prev.slug + '" data-nav><small>→ הקודם</small>' + esc(prev.icon + " " + prev.title) + "</a>" : "<span></span>") +
      (next ? '<a class="next" href="' + BASE + "/" + next.slug + '" data-nav><small>הבא ←</small>' + esc(next.icon + " " + next.title) + "</a>" : "<span></span>") + "</div>";
    main.innerHTML = html;
    document.title = d.title + " · מדריך פורלי";
    main.querySelectorAll(".progress").forEach(function (p) { updateProgress(p.getAttribute("data-for")); });
    armChats();
  }
  function renderHome() {
    chats = [];
    main.innerHTML = '<section class="hero"><h1>איך עובדים עם פורלי</h1><p>מדריך צעד-אחר-צעד לכל מה שאפשר לעשות בפורלי — מהכניסה הראשונה ועד דף נכס שמביא לידים.</p>' +
      '<div class="quick">' +
      '<a href="' + BASE + '/login" data-nav><b>1. כניסה</b>קוד חד-פעמי בוואטסאפ</a>' +
      '<a href="' + BASE + '/profile" data-nav><b>2. פרופיל</b>לוגו, צבעים ופרטים</a>' +
      '<a href="' + BASE + '/create" data-nav><b>3. נכס ראשון</b>מהאתר או מהוואטסאפ</a>' +
      '<a href="' + BASE + '/publish" data-nav><b>4. פרסום</b>פייסבוק וקבוצות</a></div></section>' +
      box({ title: "כל הנושאים" }, cards(DOCS.map(function (d) { return { slug: d.slug }; })));
    document.title = "מדריך פורלי";
  }
  function renderMissing(slug) {
    main.innerHTML = "<h1>לא מצאנו את העמוד</h1><p class=\"summary\">אין נושא בשם ״" + esc(slug) + "״. אולי אחד מאלה?</p>" + cards(DOCS.map(function (d) { return { slug: d.slug }; }));
    document.title = "לא נמצא · מדריך פורלי";
  }
  function slugFromPath() { var m = location.pathname.match(/^\/instructions\/?([a-z-]*)/); return m ? m[1] : ""; }
  function route(scroll, keepQuery) {
    var slug = slugFromPath();
    if (!keepQuery) q.value = "";
    nav.querySelectorAll("a").forEach(function (a) { a.hidden = false; });
    if (!slug) renderHome(); else if (BY[slug]) renderDoc(BY[slug]); else renderMissing(slug);
    nav.querySelectorAll("a").forEach(function (a) {
      if (a.getAttribute("data-slug") === slug) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    side.classList.remove("open");
    $(".menu-btn").setAttribute("aria-expanded", "false");
    if (location.hash) { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
    else if (scroll !== false) window.scrollTo(0, 0);
  }

  // ── nav + search ──
  nav.innerHTML = DOCS.map(function (d) {
    return '<a href="' + BASE + "/" + d.slug + '" data-nav data-slug="' + d.slug + '"><span class="ic">' + esc(d.icon) + "</span>" + esc(d.title) + (d.badge ? '<span class="pilot">פיילוט</span>' : "") + "</a>";
  }).join("");
  function textOf(d) {
    var parts = [d.title, d.summary];
    d.sections.forEach(function (s) {
      ["title", "text", "caption"].forEach(function (k) { if (s[k]) parts.push(s[k]); });
      (s.steps || []).forEach(function (x) { parts.push(x.title, x.text, x.tip || ""); });
      (s.items || []).forEach(function (x) { parts.push(typeof x === "string" ? x : [x.q, x.a, x.title, x.text].join(" ")); });
      (s.messages || []).forEach(function (m) { parts.push(m.text); });
      (s.rows || []).forEach(function (r) { parts.push(r.join(" ")); });
    });
    return parts.join(" \n ").replace(/[`*]/g, "");
  }
  var INDEX = DOCS.map(function (d) { return { d: d, text: textOf(d) }; });
  function search(term) {
    term = term.trim();
    if (term.length < 2) { route(false, true); return; }
    var low = term.toLowerCase(), hits = [];
    INDEX.forEach(function (e) {
      var t = e.text, i = t.toLowerCase().indexOf(low);
      if (i < 0) return;
      var a = Math.max(0, i - 50), snip = (a ? "…" : "") + t.slice(a, i + low.length + 70) + "…";
      hits.push('<a href="' + BASE + "/" + e.d.slug + '" data-nav><b>' + esc(e.d.icon + " " + e.d.title) + "</b><small>" +
        esc(snip).replace(new RegExp(esc(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), function (m) { return "<mark>" + m + "</mark>"; }) + "</small></a>");
    });
    nav.querySelectorAll("a").forEach(function (a) { a.hidden = !BY[a.getAttribute("data-slug")] || textOf(BY[a.getAttribute("data-slug")]).toLowerCase().indexOf(low) < 0; });
    main.innerHTML = "<h1>תוצאות חיפוש</h1><p class=\"summary\">״" + esc(term) + "״ · " + hits.length + " נושאים</p>" +
      (hits.length ? '<section class="sec results">' + hits.join("") + "</section>" : "<p>לא נמצא. נסו מילה אחרת, או כתבו לנו בוואטסאפ.</p>");
  }
  q.addEventListener("input", function () { search(q.value); });

  // ── checklists ──
  function updateProgress(id) {
    var boxes = main.querySelectorAll('input[data-step="' + id + '"]'), n = 0;
    boxes.forEach(function (b) { if (b.checked) n++; b.closest("li").classList.toggle("done", b.checked); });
    var p = main.querySelector('.progress[data-for="' + id + '"]');
    if (!p) return;
    p.querySelector("i").style.width = (boxes.length ? (100 * n) / boxes.length : 0) + "%";
    p.querySelector("span").textContent = n === boxes.length && n ? "הושלם 🎉" : n + " / " + boxes.length + " שלבים";
  }
  main.addEventListener("change", function (e) {
    var id = e.target.getAttribute("data-step");
    if (!id) return;
    var done = [];
    main.querySelectorAll('input[data-step="' + id + '"]').forEach(function (b) { if (b.checked) done.push(Number(b.getAttribute("data-i"))); });
    store.set("forly-docs:" + id, done);
    updateProgress(id);
  });

  // ── WhatsApp demos: play when scrolled into view ──
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function bubble(m) {
    return '<div class="msg ' + (m.from === "agent" ? "agent" : "bot") + '">' + inline(m.text) +
      (m.buttons ? '<div class="btns">' + m.buttons.map(function (b) { return "<span>" + esc(b) + "</span>"; }).join("") + "</div>" : "") + "</div>";
  }
  function showAll(i) { var t = main.querySelector('[data-chat="' + i + '"]'); if (t) { t._run = (t._run || 0) + 1; t.innerHTML = chats[i].messages.map(bubble).join(""); } }
  function play(i) {
    var t = main.querySelector('[data-chat="' + i + '"]');
    if (!t) return;
    if (reduce) return showAll(i);
    var run = (t._run = (t._run || 0) + 1), k = 0;
    t.innerHTML = "";
    (function nextMsg() {
      if (t._run !== run || k >= chats[i].messages.length) return;
      var m = chats[i].messages[k++];
      if (m.from !== "agent") {
        t.insertAdjacentHTML("beforeend", '<div class="typing"><i></i><i></i><i></i></div>');
        setTimeout(function () { if (t._run !== run) return; var ty = t.querySelector(".typing"); if (ty) ty.remove(); t.insertAdjacentHTML("beforeend", bubble(m)); setTimeout(nextMsg, 700); }, 900);
      } else { t.insertAdjacentHTML("beforeend", bubble(m)); setTimeout(nextMsg, 800); }
    })();
  }
  function armChats() {
    var threads = main.querySelectorAll(".thread");
    if (!("IntersectionObserver" in window) || reduce) { threads.forEach(function (t) { showAll(Number(t.getAttribute("data-chat"))); }); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); play(Number(e.target.getAttribute("data-chat"))); } });
    }, { threshold: 0.35 });
    threads.forEach(function (t) { io.observe(t); });
  }

  // ── clicks: internal links, copy chips, chat controls, checklist reset, mobile menu ──
  var toastEl = $("#toast"), toastT;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 1600); }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-nav]");
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); history.pushState(null, "", a.getAttribute("href")); route(); main.focus({ preventScroll: true }); return; }
    var chip = e.target.closest("[data-copy]");
    if (chip) {
      var txt = chip.getAttribute("data-copy");
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { toast("הועתק: " + txt); }, function () { toast(txt); });
      return;
    }
    if (e.target.hasAttribute("data-play")) return play(Number(e.target.getAttribute("data-play")));
    if (e.target.hasAttribute("data-all")) return showAll(Number(e.target.getAttribute("data-all")));
    var reset = e.target.getAttribute("data-reset");
    if (reset) { store.set("forly-docs:" + reset, []); main.querySelectorAll('input[data-step="' + reset + '"]').forEach(function (b) { b.checked = false; }); updateProgress(reset); return; }
    if (e.target.closest(".menu-btn")) { var open = side.classList.toggle("open"); e.target.closest(".menu-btn").setAttribute("aria-expanded", String(open)); }
  });
  window.addEventListener("popstate", function () { route(); });
  route();
})();
