/*
 * publish-campaign-more.js — the campaign card's way out when no group can
 * take a post (the planner said no_eligible_group / duplicate and the card
 * lists why): add more of the agent's own groups to the running campaign
 * (POST /api/posting/campaigns/:id/groups — the same gate as starting one),
 * join a suggested group on Facebook, refresh the group list, or stop.
 * Loaded after publish-campaign.js, which calls render() on every refresh;
 * under node it is module.exports (addable() is pure).
 * Group names come from Facebook: every one is escaped.
 */
(function (root) {
  "use strict";
  const DISALLOWED = new Set(["forbidden", "disallowed", "not_allowed", "no_agents"]);
  // The agent's member groups that could still join this campaign: a member
  // now, fit for the property, allowed for agents, and not in it already.
  function addable(settings, campaign) {
    const inIt = new Set(((campaign && campaign.groups) || []).map((g) => String(g.group_id)));
    return ((settings && settings.member_groups) || []).filter((g) => g && g.membership_state === "member" && !g.excluded &&
      g.fits !== false && !DISALLOWED.has(g.agent_policy) && !inIt.has(String(g.group_id)));
  }

  const picks = new Map(); // campaign id → Set of ticked group ids, kept across re-renders

  // o: { campaign, settings, stuck, U, post, say, refresh }
  function render(box, o) {
    if (!box) return;
    box.hidden = !o.stuck;
    if (!o.stuck) return;
    const U = o.U, c = o.campaign;
    const ticked = picks.get(c.id) || new Set();
    picks.set(c.id, ticked);
    const more = addable(o.settings, c);
    const sug = ((o.settings && o.settings.suggested_groups) || []).filter((g) => U.fbUrl(g.url));
    box.innerHTML = '<p class="camp-more-h">מה אפשר לעשות?</p>' +
      (more.length
        ? '<p class="camp-small">להוסיף לקמפיין עוד קבוצות שאתם חברים בהן:</p><div class="camp-more-list">' + more.map((g) => {
          const id = U.esc(g.group_id), on = ticked.has(String(g.group_id));
          return `<div class="camp-g${on ? " on" : ""}"><label><input type="checkbox" data-add="${id}"${on ? " checked" : ""}>` +
            ` <span class="camp-gn">${U.esc(g.name)}</span> <small>${U.esc(U.groupNote(g))}</small></label></div>`;
        }).join("") + '</div><button type="button" class="btn btn-gold btn-sm" data-act="add">הוספה לקמפיין</button>'
        : '<p class="camp-small">אין עוד קבוצות שאתם חברים בהן שמתאימות לנכס הזה.</p>') +
      (sug.length ? '<p class="camp-small">או להצטרף לקבוצה באזור ואז לרענן:</p>' + sug.slice(0, 5).map((g) =>
        `<div class="camp-s"><span>${U.esc(g.name || "קבוצה")}${g.city ? ` · ${U.esc(g.city)}` : ""}</span>` +
        ` <a href="${U.esc(U.fbUrl(g.url))}" target="_blank" rel="noopener noreferrer">הצטרפות ↗</a></div>`).join("") : "") +
      '<p class="camp-small"><button type="button" class="btn btn-ghost btn-sm" data-act="resync">רענון רשימת הקבוצות</button>' +
      ' <span class="camp-muted">הצטרפתם לקבוצה, או שפייסבוק טעתה שאינכם חברים? רעננו.</span></p>' +
      '<p class="camp-small camp-muted">אפשר גם לעצור את הפרסום ולהתחיל שוב כשהקבוצות יתפנו.</p>';
    if (box.dataset.wired) { box._o = o; return; }
    box.dataset.wired = "1";
    box._o = o;
    box.addEventListener("change", (ev) => {
      const i = ev.target, id = i && i.dataset && i.dataset.add;
      if (!id) return;
      const set = picks.get(box._o.campaign.id);
      if (i.checked) set.add(id); else set.delete(id);
    });
    box.addEventListener("click", async (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest("button[data-act]");
      if (!b) return;
      const cur = box._o, U2 = cur.U, set = picks.get(cur.campaign.id);
      b.disabled = true;
      try {
        if (b.dataset.act === "add") {
          const ids = addable(cur.settings, cur.campaign).map((g) => String(g.group_id)).filter((id) => set.has(id));
          if (!ids.length) { cur.say("סמנו לפחות קבוצה אחת"); return; }
          const unknown = addable(cur.settings, cur.campaign).some((g) => ids.includes(String(g.group_id)) && g.agent_policy === "unknown");
          await cur.post(`/api/posting/campaigns/${encodeURIComponent(cur.campaign.id)}/groups`, { group_ids: ids, include_unknown: unknown });
          set.clear();
          cur.say("הקבוצות נוספו ✓ פורלי מתזמנת את הפוסט הבא");
        } else {
          await cur.post("/api/posting/groups/resync");
          cur.say("רשימת הקבוצות עודכנה");
        }
        await cur.refresh();
      } catch (e) {
        ((e && e.body && e.body.group_ids) || []).forEach((id) => set.delete(String(id)));
        cur.say(U2.errorText(e));
      } finally { b.disabled = false; }
    });
  }

  const More = { addable, render };
  if (typeof module === "object" && module.exports) { module.exports = More; return; }
  root.ForlyCampaignMore = More;
})(typeof window !== "undefined" ? window : globalThis);
