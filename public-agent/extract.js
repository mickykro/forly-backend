/* Forly create wizard — "paste text or a link" helpers.
   Pure functions over an element lookup so they run under node for tests and
   in the browser as window.FlyExtract. The wiring (button, fetch, card) lives
   in create.html. */
(function (root) {
  "use strict";

  // server field → input, in the order the card should show them
  var FIELD_MAP = {
    deal: "#pType", address: "#pAddress", city: "#pCity", neighborhood: "#pHood",
    price: "#pPrice", rooms: "#pRooms", size_sqm: "#pSqm", floor: "#pFloor", parking: "#pParking",
    sqm_built: "#pSqmBuilt", sqm_balcony: "#pSqmBalcony", sqm_garden: "#pSqmGarden",
    elevator: "#pElevator", shabbat_elevator: "#pShabbatElevator", storage: "#pStorage",
  };
  var ORDER = Object.keys(FIELD_MAP);

  function isUrl(s) { return /^https?:\/\/\S+$/.test(String(s || "").trim()); }
  function formatPrice(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  function fire(el, type) {
    var ev = (typeof Event === "function") ? new Event(type, { bubbles: true }) : { type: type };
    el.dispatchEvent(ev);
  }
  function isEmpty(el) {
    if (el.type === "checkbox") return !el.checked;
    if (el.type === "select-one") return true;             // has a default; server decides
    return !String(el.value == null ? "" : el.value).trim();
  }

  // Writes only into empty inputs. Returns the selectors it changed.
  function fillFields(fields, byId) {
    var changed = [];
    ORDER.forEach(function (key) {
      var v = fields ? fields[key] : null;
      if (v === null || v === undefined) return;
      var el = byId(FIELD_MAP[key]);
      if (!el || !isEmpty(el)) return;
      if (el.type === "checkbox") { if (v !== true) return; el.checked = true; fire(el, "change"); }
      else if (el.type === "select-one") { if (el.value === v) return; el.value = v; fire(el, "change"); }
      else { el.value = key === "price" ? formatPrice(v) : String(v); fire(el, "input"); fire(el, "change"); }
      changed.push(FIELD_MAP[key]);
    });
    return changed;
  }

  // Selectors of inputs the card should show: server-missing ∩ still-empty, display order.
  function missingFor(missing, byId, isDemo) {
    var out = [];
    if (isDemo) ["#agName", "#agPhone"].forEach(function (sel) {
      var el = byId(sel); if (el && isEmpty(el)) out.push(sel);
    });
    ORDER.forEach(function (key) {
      if ((missing || []).indexOf(key) < 0) return;
      var el = byId(FIELD_MAP[key]);
      if (!el) return;
      if (key === "deal" || isEmpty(el)) out.push(FIELD_MAP[key]);
    });
    return out;
  }

  function errorKey(status, code) {
    if (code === "facebook_not_connected") return "ext_err_fb_connect";
    if (code === "page_unreadable") return "ext_err_unreadable";
    if (code === "extract_limit") return "ext_err_limit";
    return "ext_err_unavailable";
  }

  var api = { FIELD_MAP: FIELD_MAP, isUrl: isUrl, formatPrice: formatPrice, fillFields: fillFields, missingFor: missingFor, errorKey: errorKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FlyExtract = api;
})(typeof window !== "undefined" ? window : this);
