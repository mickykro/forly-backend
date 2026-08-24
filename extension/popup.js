/*
 * popup.js — status and the two controls that matter: start and stop.
 * The agent can always stop the queue instantly; nothing runs on its own.
 */
const $ = (id) => document.getElementById(id);

function paint(s) {
  const paired = !!s.token;
  $("sub").textContent = paired
    ? (s.running ? "פועל — עוברים קבוצה־קבוצה" : "מחובר, ממתין")
    : "לא מחובר — התחברו מעמוד ההפצה ב-Forly";
  $("modePill").textContent = s.mode === "auto" ? "אוטומטי" : "אישור ידני";
  $("modePill").className = "pill" + (s.mode === "auto" ? "" : " on");
  $("modeWarn").hidden = s.mode !== "auto";
  $("start").disabled = !paired || !s.session || s.running;
  $("stop").disabled = !s.running;
  $("hint").textContent = s.session
    ? "" : "פותחים את עמוד ההפצה ב-Forly ובוחרים נכס כדי להתחיל.";
  const box = $("logs");
  box.textContent = "";
  for (const l of s.logs || []) {
    const d = document.createElement("div");
    const t = new Date(l.at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    d.textContent = `${t} · ${l.line}`;
    box.appendChild(d);
  }
}

function refresh() {
  chrome.runtime.sendMessage({ forly: "state" }, (s) => paint(s || {}));
}

$("start").onclick = () => chrome.runtime.sendMessage({ forly: "start" }, refresh);
$("stop").onclick = () => chrome.runtime.sendMessage({ forly: "stop" }, refresh);

$("pairBtn").onclick = () => {
  const token = $("tokenIn").value.trim();
  const base = $("baseIn").value.trim().replace(/\/+$/, "");
  if (!token || !base) return;
  chrome.runtime.sendMessage({ forly: "pair", token, base }, () => {
    $("tokenIn").value = "";
    $("manual").open = false;
    refresh();
  });
};

refresh();
setInterval(refresh, 3000);
