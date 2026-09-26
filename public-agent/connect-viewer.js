/*
 * connect-viewer.js — the login browser inside the connect modal.
 *
 * Reads the server's frame stream (GET /api/connections/browser/:p/view) and
 * sends clicks, scrolls and typing back (POST …/view/input). Coordinates go as
 * fractions of the frame, so the server maps them to its own page size.
 *
 * Typing goes through a hidden textarea: it is what opens a phone's keyboard,
 * and it lets Hebrew, autocomplete and IME composition work. Two zero-width
 * sentinels stay in it so a phone's backspace has something to delete.
 */
window.ForlyViewer = (() => {
  const S = "​​";
  const SPECIAL = new Set(["Enter", "Tab", "Escape", "Delete", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
  let cur = null;

  function unmount() {
    if (!cur) return;
    cur.alive = false;
    try { cur.ac.abort(); } catch (e) { /* already done */ }
    cur.box.innerHTML = "";
    cur = null;
  }

  // opts: { onEnd(code), onFrame() }. code: session_ended | no_open_session |
  // session_expired | driver_busy | viewer_unavailable | connected | closed | …
  function mount(box, platform, opts = {}) {
    unmount();
    box.innerHTML = `<div class="cv">
      <div class="cv-bar">
        <button type="button" class="btn btn-ghost cv-btn" data-a="back">חזרה</button>
        <button type="button" class="btn btn-ghost cv-btn" data-a="reload">רענון</button>
        <span class="cv-url" dir="ltr"></span>
        <button type="button" class="btn btn-ghost cv-btn" data-a="kbd">⌨ מקלדת</button>
      </div>
      <div class="cv-screen"><img class="cv-img" alt="" draggable="false" hidden><div class="cv-wait">פותחים את הדפדפן…</div></div>
      <textarea class="cv-keys" aria-label="הקלדה לדפדפן" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
    </div>`;
    const me = { box, alive: true, ac: new AbortController(), size: null, gotFrame: false, queue: Promise.resolve(), ended: false };
    cur = me;
    const img = box.querySelector(".cv-img"), wait = box.querySelector(".cv-wait"), url = box.querySelector(".cv-url"), ta = box.querySelector(".cv-keys");
    const base = `/api/connections/browser/${platform}/view`;

    const end = (code) => {
      if (me.ended || !me.alive) return;
      me.ended = true;
      wait.hidden = false; wait.textContent = "הדפדפן נסגר";
      if (opts.onEnd) opts.onEnd(code, me.gotFrame);
    };
    // Sequential, so text and keys arrive in the order they were typed.
    const send = (ev) => (me.queue = me.queue.then(async () => {
      if (!me.alive || me.ended) return {};
      let r;
      try {
        r = await fetch(`${base}/input`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ev) });
      } catch (e) { return {}; }
      if (r.status === 409) { end("session_ended"); return {}; }
      return r.ok ? r.json().catch(() => ({})) : {};
    }));

    // ── frames ──
    const onEvent = (e) => {
      if (e.t === "frame") {
        me.size = { w: e.w, h: e.h };
        img.src = `data:image/jpeg;base64,${e.d}`;
        if (!me.gotFrame) { me.gotFrame = true; img.hidden = false; wait.hidden = true; if (opts.onFrame) opts.onFrame(); }
        url.textContent = e.u || "";
      } else if (e.t === "end") end(e.reason || "closed");
    };
    (async () => {
      let tries = 0;
      while (me.alive && !me.ended) {
        let r;
        try { r = await fetch(base, { credentials: "include", signal: me.ac.signal, headers: { Accept: "text/event-stream" } }); }
        catch (e) { r = null; }
        if (!me.alive) return;
        if (r && !r.ok) { const b = await r.json().catch(() => ({})); end(b.error || "viewer_unavailable"); return; }
        if (r && r.body) {
          tries = 0;
          const reader = r.body.getReader(), dec = new TextDecoder();
          let buf = "";
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf("\n\n")) >= 0) {
                const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
                const line = chunk.split("\n").find((l) => l.startsWith("data: "));
                if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch (e) { /* skip a bad event */ } }
              }
            }
          } catch (e) { /* dropped: reconnect below */ }
        }
        if (!me.alive || me.ended) return;
        // A dropped connection (proxy timeout, network blip) reconnects;
        // the server keeps the browser for a while with nobody watching.
        if (++tries > 5) { end("viewer_unavailable"); return; }
        await new Promise((ok) => setTimeout(ok, 1500 * tries));
      }
    })();

    // ── pointer: a tap/click is a click; a finger drag or wheel scrolls ──
    const frac = (clientX, clientY) => {
      const r = img.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)) };
    };
    const scale = () => (me.size ? me.size.h / img.getBoundingClientRect().height : 1);
    let down = null, wheelAcc = null, wheelTimer = null;
    const flushWheel = () => {
      wheelTimer = null;
      if (!wheelAcc) return;
      const w = wheelAcc; wheelAcc = null;
      const clamp = (v) => Math.max(-5000, Math.min(5000, Math.round(v)));
      send({ t: "wheel", x: w.x, y: w.y, dx: clamp(w.dx), dy: clamp(w.dy) });
    };
    const addWheel = (p, dx, dy) => {
      wheelAcc = wheelAcc ? { x: wheelAcc.x, y: wheelAcc.y, dx: wheelAcc.dx + dx, dy: wheelAcc.dy + dy } : { x: p.x, y: p.y, dx, dy };
      if (!wheelTimer) wheelTimer = setTimeout(flushWheel, 60);
    };
    img.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, lastY: e.clientY, lastX: e.clientX, moved: 0, type: e.pointerType };
      try { img.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    });
    img.addEventListener("pointermove", (e) => {
      if (!down) return;
      down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y));
      if (down.type !== "mouse" && down.moved > 10) {
        const k = scale();
        addWheel(frac(down.x, down.y), (down.lastX - e.clientX) * k, (down.lastY - e.clientY) * k);
        down.lastX = e.clientX; down.lastY = e.clientY;
      }
    });
    img.addEventListener("pointerup", (e) => {
      const d = down; down = null;
      if (!d || d.moved > 10) return;
      const touch = d.type !== "mouse";
      // A phone opens its keyboard only on focus inside the tap itself; if
      // the page's focus did not land in a text field, it is closed again.
      ta.focus({ preventScroll: true });
      send(Object.assign({ t: "click" }, frac(d.x, d.y))).then((r) => { if (touch && r && r.editable === false) ta.blur(); });
    });
    img.addEventListener("pointercancel", () => { down = null; });
    img.addEventListener("wheel", (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      addWheel(frac(e.clientX, e.clientY), e.deltaX * k, e.deltaY * k);
    }, { passive: false });
    img.addEventListener("contextmenu", (e) => e.preventDefault());

    // ── typing ──
    let composing = false;
    const reset = () => { ta.value = S; try { ta.setSelectionRange(S.length, S.length); } catch (e) { /* ignore */ } };
    reset();
    const flush = () => {
      const v = ta.value;
      if (v === S) return;
      const gone = S.length - (v.match(/​/g) || []).length;
      for (let i = 0; i < gone; i++) send({ t: "key", key: "Backspace" });
      v.replace(/​/g, "").split("\n").forEach((part, i) => {
        if (i > 0) send({ t: "key", key: "Enter" });
        for (let j = 0; j < part.length; j += 200) {
          const text = part.slice(j, j + 200).replace(/[\u0000-\u001f\u007f]/g, "");
          if (text) send({ t: "text", text });
        }
      });
      reset();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229 || !SPECIAL.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      send({ t: "key", key: e.key, shift: e.shiftKey });
    });
    ta.addEventListener("compositionstart", () => { composing = true; });
    ta.addEventListener("compositionend", () => { composing = false; flush(); });
    ta.addEventListener("input", () => { if (!composing) flush(); });

    box.querySelector(".cv-bar").addEventListener("click", (e) => {
      const a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
      if (a === "kbd") ta.focus();
      else if (a === "back" || a === "reload") send({ t: a });
    });
    return { send };
  }

  return { mount, unmount };
})();
