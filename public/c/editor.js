// Same-origin Hosting rewrites → private Cloud Functions in europe-west1
const GET_URL  = '/api/get-draft';
const SAVE_URL = '/api/save-draft';

const carouselId = window.location.pathname.split('/').filter(Boolean).pop();
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const headerSpinner = document.getElementById('headerSpinner');
const saveModal = document.getElementById('saveModal');
const saveModalTitle = document.getElementById('saveModalTitle');
const saveModalMessage = document.getElementById('saveModalMessage');
const saveModalDismissBtn = document.getElementById('saveModalDismissBtn');
const successToast = document.getElementById('successToast');
const containerEl = document.getElementById('slideContainer');
const panelEl = document.getElementById('contextPanel');

let carouselData = null;
let lastFocusedIframe = null;

const DRAG_THRESHOLD = 15;
const MAX_UNDO = 30;
const undoStack = [];

const FONT_FAMILIES = [
  'Heebo', 'Rubik', 'Assistant', 'Frank Ruhl Libre', 'Suez One', 'Secular One',
];
const FONT_LINK_HREF = 'https://fonts.googleapis.com/css2?' +
  'family=Heebo:wght@400;500;700;900&' +
  'family=Rubik:wght@400;500;700&' +
  'family=Assistant:wght@400;500;700&' +
  'family=Frank+Ruhl+Libre:wght@400;500;700&' +
  'family=Suez+One&' +
  'family=Secular+One&display=swap';

// Current selection — text or container or none
const selection = { type: null, el: null, iframe: null };

const EDITOR_STYLE = `
  .__editor-draggable { cursor: move; touch-action: none; }
  .__editor-draggable:hover {
    outline: 2px dashed rgba(45, 156, 219, 0.7);
    outline-offset: 2px;
  }
  .__editor-draggable.__editor-dragging {
    outline: 2px solid #2D9CDB;
  }
  .__editor-selected {
    outline: 3px solid #9D4EDD !important;
    outline-offset: 2px;
  }
  [contenteditable="true"] { cursor: text; }
  [contenteditable="true"]:hover {
    outline: 2px dashed rgba(157, 78, 221, 0.7);
    outline-offset: 2px;
  }
  [contenteditable="true"]:focus {
    outline: 2px solid #9D4EDD;
    outline-offset: 2px;
  }
  body.__bg-editing { cursor: move; }
  body.__bg-editing [contenteditable="true"] { pointer-events: none; outline: none !important; }
  body.__bg-editing .__editor-draggable { pointer-events: none; outline: none !important; }
`;

async function loadCarousel() {
  try {
    const res = await fetch(`${GET_URL}?id=${carouselId}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'failed to load');
    }
    carouselData = await res.json();
    await renderSlides();
  } catch (err) {
    containerEl.innerHTML = `<div style="padding:80px;text-align:center;color:#c33">
      <h2>הקישור לא תקין או פג תוקף</h2>
      <p>${err.message}</p>
    </div>`;
  }
}

async function renderSlides() {
  containerEl.innerHTML = '';
  for (const slide of carouselData.slides) {
    const card = document.createElement('div');
    card.className = 'slide-card';
    card.dataset.slideIndex = slide.index;

    const controls = document.createElement('div');
    controls.className = 'slide-controls';

    const label = document.createElement('span');
    label.className = 'slide-label';
    label.textContent = `שקף ${slide.index}`;

    const actions = document.createElement('div');
    actions.className = 'slide-actions';

    const addTextBtn = makeBtn('+ טקסט');
    const addContainerBtn = makeBtn('+ מיכל');
    const changeBgBtn = makeBtn('שנה רקע');
    const adjustBgBtn = makeBtn('התאם רקע');

    actions.appendChild(addTextBtn);
    actions.appendChild(addContainerBtn);
    actions.appendChild(changeBgBtn);
    actions.appendChild(adjustBgBtn);
    controls.appendChild(label);
    controls.appendChild(actions);

    const wrap = document.createElement('div');
    wrap.className = 'slide-wrap';

    const iframe = document.createElement('iframe');
    iframe.className = 'slide-frame';
    iframe.dataset.slideIndex = slide.index;
    iframe.setAttribute('scrolling', 'no');

    const htmlText = await fetch(slide.html_url).then(r => r.text());

    wrap.appendChild(iframe);
    card.appendChild(controls);
    card.appendChild(wrap);
    containerEl.appendChild(card);

    addTextBtn.addEventListener('click', () => addTextTo(iframe));
    addContainerBtn.addEventListener('click', () => addContainerTo(iframe));
    changeBgBtn.addEventListener('click', () => triggerBgChange(iframe));
    adjustBgBtn.addEventListener('click', () => toggleBgEdit(iframe, adjustBgBtn));

    // Attach load listener BEFORE assigning srcdoc to avoid a race where the
    // load event fires before we get a chance to listen — that race made the
    // last slide silently un-editable because enableEditMode was never called.
    const loaded = new Promise(resolve => {
      iframe.addEventListener('load', resolve, { once: true });
    });
    iframe.srcdoc = htmlText;
    await loaded;
    enableEditMode(iframe);
    fitIframe(iframe);
  }

  const refit = () => document.querySelectorAll('iframe.slide-frame').forEach(fitIframe);
  window.addEventListener('resize', refit);
  refit();
}

function makeBtn(text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  return b;
}

function fitIframe(iframe) {
  const wrap = iframe.parentElement;
  if (!wrap || !wrap.clientWidth) return;
  iframe.style.transform = `scale(${wrap.clientWidth / 1080})`;
}

// ─────────────────────────── Undo stack ───────────────────────────

function snapshotIframe(iframe) {
  if (!iframe || !iframe.contentDocument) return null;
  return iframe.contentDocument.documentElement.outerHTML;
}

function pushUndo(iframe, htmlBefore) {
  if (!htmlBefore || !iframe) return;
  undoStack.push({ iframe, html: htmlBefore });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoButton();
}

function undo() {
  if (!undoStack.length) return;
  const { iframe, html } = undoStack.pop();
  if (iframe.dataset.bgEdit === '1') exitBgEditState(iframe);
  clearSelection();
  // Listener must register BEFORE srcdoc assignment to avoid a race where
  // the load event fires synchronously and is missed.
  iframe.addEventListener('load', () => {
    enableEditMode(iframe);
    fitIframe(iframe);
  }, { once: true });
  iframe.srcdoc = html;
  updateUndoButton();
}

function updateUndoButton() {
  const btn = document.getElementById('undoBtn');
  if (btn) btn.disabled = undoStack.length === 0;
}

// ─────────────────────────── Edit mode ───────────────────────────

function enableEditMode(iframe) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;

  if (!doc.querySelector('style[data-editor-affordance]')) {
    const style = doc.createElement('style');
    style.setAttribute('data-editor-affordance', '');
    style.textContent = EDITOR_STYLE;
    doc.head.appendChild(style);
  }

  if (!doc.querySelector('link[data-editor-fonts]')) {
    const link = doc.createElement('link');
    link.setAttribute('data-editor-fonts', '');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', FONT_LINK_HREF);
    doc.head.appendChild(link);
  }

  // Make text editable. Walk the tree and mark each "text unit" — an element
  // that has text and whose only element-children are inline formatting
  // (span/b/i/a/br…). This makes whole headings/paragraphs editable even when
  // they contain inline spans, which the old leaf-only rule left selectable but
  // not editable.
  const INLINE = new Set(['SPAN','B','I','EM','STRONG','A','BR','SMALL','MARK','U','S','SUB','SUP','FONT','WBR','CODE','LABEL']);
  const TEXT_SKIP = new Set(['STYLE','SCRIPT','LINK','META','HEAD','TITLE','IMG','SVG','BR']);
  const markEditable = (el) => {
    if (!el || el.nodeType !== 1 || TEXT_SKIP.has(el.tagName)) return;
    const kids = Array.from(el.children);
    const hasText = el.textContent.trim().length > 0;
    const allInline = kids.every(c => INLINE.has(c.tagName));
    if (hasText && allInline) {
      el.setAttribute('contenteditable', 'true');
      attachTextEditUndo(el, iframe);
      return;
    }
    kids.forEach(markEditable);
  };
  markEditable(doc.body);

  doc.querySelectorAll('img').forEach(img => {
    img.setAttribute('draggable', 'false');
  });

  // Make EVERY element movable — no exception — except the page itself, the
  // full-bleed canvas/background (use "adjust background" for that), and inline
  // fragments inside an editable text block (those move as one block). In-flow
  // elements are promoted to absolute on first drag (see makeDraggable).
  const DRAG_SKIP = new Set(['STYLE','SCRIPT','LINK','META','HEAD','TITLE']);
  const slideRoot = doc.querySelector('.slide, main') || doc.body;
  const isFullBleed = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 1060 && r.height >= 1330;
  };

  // Decorative full-bleed layers (background images, dark overlays/tints) sit on
  // top of the content and otherwise swallow every click — which made whole
  // slides un-editable. Let pointer events pass through them to the content
  // beneath; they're still re-styled via "change/adjust background".
  doc.querySelectorAll('*').forEach(el => {
    if (el === doc.body || el === slideRoot || el === doc.documentElement) return;
    if (isFullBleed(el) && el.textContent.trim() === '') {
      el.dataset.__passthrough = '1';
      el.style.pointerEvents = 'none';
    }
  });

  doc.querySelectorAll('*').forEach(el => {
    if (el === doc.body) return;
    if (DRAG_SKIP.has(el.tagName)) return;
    if (isFullBleed(el)) return;
    if (el.dataset.__passthrough === '1') return;
    const ce = el.closest('[contenteditable="true"]');
    if (ce && ce !== el) return;   // a fragment inside an editable text block
    makeDraggable(el, doc, iframe);
  });

  const markFocused = () => { lastFocusedIframe = iframe; };
  doc.addEventListener('pointerdown', markFocused, true);
  doc.addEventListener('focusin', markFocused, true);
}

function attachTextEditUndo(el, iframe) {
  if (el.dataset.__editTracked) return;
  el.dataset.__editTracked = '1';
  let preEdit = null;
  let dirty = false;

  el.addEventListener('focus', () => {
    preEdit = snapshotIframe(iframe);
    dirty = false;
    selectText(el, iframe);
  });
  el.addEventListener('input', () => { dirty = true; });
  el.addEventListener('blur', () => {
    if (dirty && preEdit) pushUndo(iframe, preEdit);
    preEdit = null;
    dirty = false;
  });
}

function makeDraggable(el, doc, iframe) {
  if (el.classList.contains('__editor-draggable')) return;
  el.classList.add('__editor-draggable');
  const win = doc.defaultView;

  el.addEventListener('pointerdown', (e) => {
    if (iframe.dataset.bgEdit === '1') return;
    if (e.target.closest && e.target.closest('.__editor-draggable') !== el) return;

    const active = doc.activeElement;
    const targetEditable = e.target.closest && e.target.closest('[contenteditable="true"]');
    // If you're currently editing this element, give small gestures room to
    // place the caret / select text — but a larger, deliberate drag still moves
    // it, so a focused element is never stuck in place.
    const downOnFocusedEditable = !!(active && active === targetEditable
      && active.getAttribute('contenteditable') === 'true');
    const threshold = downOnFocusedEditable ? 30 : DRAG_THRESHOLD;

    const downTarget = e.target;
    const downWasOnEditable = !!(downTarget && downTarget.closest && downTarget.closest('[contenteditable="true"]'));

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let preDragSnapshot = null;
    let origLeft = 0;
    let origTop = 0;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      if (!dragging) {
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
        dragging = true;
        preDragSnapshot = snapshotIframe(iframe);
        if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
        const sel = doc.defaultView.getSelection && doc.defaultView.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
        const rect = el.getBoundingClientRect();
        const parent = el.offsetParent || doc.body;
        const parentRect = parent.getBoundingClientRect();
        origLeft = rect.left - parentRect.left;
        origTop = rect.top - parentRect.top;
        // Promote in-flow elements to absolute so they can be freely moved,
        // pinning their current size/position so the slide doesn't reflow.
        const pos = win.getComputedStyle(el).position;
        if (pos !== 'absolute' && pos !== 'fixed') {
          el.style.width = `${rect.width}px`;
          el.style.position = 'absolute';
          el.style.margin = '0';
          el.style.left = `${origLeft}px`;
          el.style.top = `${origTop}px`;
          el.style.right = 'auto';
          el.style.bottom = 'auto';
        }
        el.classList.add('__editor-dragging');
      }

      ev.preventDefault();
      el.style.left = `${origLeft + dx}px`;
      el.style.top = `${origTop + dy}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };

    const onUp = () => {
      if (dragging && preDragSnapshot) {
        pushUndo(iframe, preDragSnapshot);
        // Keep the container selected after a drag
        selectContainer(el, iframe);
      } else if (!downWasOnEditable) {
        // Click without drag on the container background → select for styling
        selectContainer(el, iframe);
      }
      el.classList.remove('__editor-dragging');
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', onUp);
      win.removeEventListener('pointercancel', onUp);
    };

    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onUp);
    win.addEventListener('pointercancel', onUp);
  });
}

// ─────────────────────────── Selection + context panel ───────────────────────────

function selectText(el, iframe) {
  clearContainerHighlights();
  selection.type = 'text';
  selection.el = el;
  selection.iframe = iframe;
  populateTextPanel(el);
  showPanel('text');
}

function selectContainer(el, iframe) {
  const doc = iframe.contentDocument;
  if (doc && doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
  clearContainerHighlights();
  el.classList.add('__editor-selected');
  selection.type = 'container';
  selection.el = el;
  selection.iframe = iframe;
  populateContainerPanel(el);
  showPanel('container');
}

function clearSelection() {
  clearContainerHighlights();
  selection.type = null;
  selection.el = null;
  selection.iframe = null;
  hidePanel();
}

function clearContainerHighlights() {
  document.querySelectorAll('iframe.slide-frame').forEach(iframe => {
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.querySelectorAll('.__editor-selected').forEach(e => e.classList.remove('__editor-selected'));
  });
}

function showPanel(mode) {
  panelEl.dataset.mode = mode;
  panelEl.classList.add('visible');
}

function hidePanel() {
  panelEl.dataset.mode = '';
  panelEl.classList.remove('visible');
}

function populateTextPanel(el) {
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  // font-family may be a stack — strip quotes, pick first
  const firstFont = (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim();
  const fontSelect = document.getElementById('fontSelect');
  fontSelect.value = FONT_FAMILIES.includes(firstFont) ? firstFont : 'Heebo';

  const sizePx = parseFloat(cs.fontSize) || 40;
  document.getElementById('fontSize').value = Math.round(sizePx);

  document.getElementById('fontColor').value = rgbToHex(cs.color || 'rgb(0,0,0)');
}

function populateContainerPanel(el) {
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  const bg = cs.backgroundColor || 'rgba(255,255,255,1)';
  const parsed = parseColor(bg);
  document.getElementById('bgColor').value = rgbToHex(`rgb(${parsed.r}, ${parsed.g}, ${parsed.b})`);
  document.getElementById('bgOpacity').value = Math.round(parsed.a * 100);
  // Store current state on the element so we can recompose rgba on either change
  el.dataset.__bgColor = document.getElementById('bgColor').value;
  el.dataset.__bgOpacity = document.getElementById('bgOpacity').value;
}

function parseColor(str) {
  // Handles "rgb(r, g, b)", "rgba(r, g, b, a)", "#rrggbb"
  const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  if (str.startsWith('#')) {
    return { r: parseInt(str.slice(1, 3), 16), g: parseInt(str.slice(3, 5), 16), b: parseInt(str.slice(5, 7), 16), a: 1 };
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

function rgbToHex(rgb) {
  const m = rgb.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return '#000000';
  const toHex = n => Number(n).toString(16).padStart(2, '0');
  return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
}

function hexToRgba(hex, alphaPct) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alphaPct / 100})`;
}

// Wire panel inputs — selection-aware (selected text vs whole element) + live preview

// Capture a styling "session": which element we're editing + any current text-selection
// range inside it + a pre-change snapshot for undo. Reused across all input events in
// one user gesture (e.g. dragging the color picker).
function captureTextStyleSession() {
  if (selection.type !== 'text' || !selection.el) return null;
  const iframe = selection.iframe;
  const doc = iframe.contentDocument;
  let range = null;
  let styledSpan = null;
  const sel = doc.getSelection && doc.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const r = sel.getRangeAt(0);
    const inside = selection.el === r.commonAncestorContainer
      || (selection.el.contains && selection.el.contains(r.commonAncestorContainer));
    if (inside) {
      range = r.cloneRange();
      // If the selection range matches an existing styled span's contents,
      // remember it so we layer new styles onto the same span instead of
      // wrapping it in yet another span.
      const c = r.commonAncestorContainer;
      const candidate = c.nodeType === 1 ? c : c.parentElement;
      const wrapping = candidate && candidate.closest && candidate.closest('span[style]');
      if (wrapping && selection.el.contains(wrapping) && wrapping.textContent === r.toString()) {
        styledSpan = wrapping;
      }
    }
  }
  return { iframe, el: selection.el, range, styledSpan, snapshot: snapshotIframe(iframe) };
}

function applyTextStyle(session, prop, value) {
  if (!session) return;
  const { el, range } = session;
  const doc = el.ownerDocument;
  if (range && !range.collapsed) {
    // Reuse an existing styled span if the selection already covers one
    // (captureTextStyleSession detected this). Otherwise create a new wrapper.
    let span = session.styledSpan;
    if (!span) {
      span = doc.createElement('span');
      try {
        range.surroundContents(span);
      } catch {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }
      session.styledSpan = span;
      const sel = doc.getSelection();
      sel.removeAllRanges();
      const newRange = doc.createRange();
      newRange.selectNodeContents(span);
      sel.addRange(newRange);
      session.range = newRange.cloneRange();
    }
    span.style[prop] = value;
  } else {
    // No selection — pick the most relevant target so styles like border-radius
    // land on the element that actually has a background.
    let target = el;
    // 1. If a descendant span carries inline styling, that's the active styled chunk
    const styledDescendant = el.querySelector && el.querySelector('span[style]');
    if (styledDescendant) target = styledDescendant;
    // 2. Caret position trumps when it's inside a different styled span
    const sel = doc.getSelection && doc.getSelection();
    if (sel && sel.rangeCount > 0) {
      const node = sel.anchorNode;
      const candidate = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
      const cursorSpan = candidate && candidate.closest && candidate.closest('span[style]');
      if (cursorSpan && el.contains(cursorSpan)) target = cursorSpan;
    }
    target.style[prop] = value;
  }
}

function wireLiveTextControl(inputId, prop, transform) {
  const input = document.getElementById(inputId);
  let session = null;
  const startSession = () => { session = captureTextStyleSession(); };
  input.addEventListener('mousedown', startSession);
  input.addEventListener('touchstart', startSession, { passive: true });
  input.addEventListener('focus', startSession);
  input.addEventListener('input', (e) => {
    if (!session) session = captureTextStyleSession();
    if (!session) return;
    const value = transform ? transform(e.target.value) : e.target.value;
    applyTextStyle(session, prop, value);
  });
  input.addEventListener('change', () => {
    if (session && session.snapshot) pushUndo(session.iframe, session.snapshot);
    // Collapse iframe selection so the NEXT picker drag starts cleanly —
    // otherwise a stale range would cause us to wrap the just-wrapped span again.
    if (session && session.iframe && session.iframe.contentDocument) {
      const sel = session.iframe.contentDocument.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    }
    session = null;
  });
}

wireLiveTextControl('fontColor', 'color');
wireLiveTextControl('fontSize', 'fontSize', v => `${v}px`);
wireLiveTextControl('textBgColor', 'backgroundColor');
wireLiveTextControl('textBgRadius', 'borderRadius', v => `${v}px`);

document.getElementById('textBgClearBtn').addEventListener('click', () => {
  if (selection.type !== 'text' || !selection.el) return;
  const root = selection.el;
  // Don't push undo if nothing would change
  const hasBg = !!root.style.backgroundColor
    || !!Array.from(root.querySelectorAll('*')).find(c => c.style && c.style.backgroundColor);
  if (!hasBg) return;
  pushUndo(selection.iframe, snapshotIframe(selection.iframe));
  // Unconditionally remove inline background-color on the root and every
  // descendant — covers all the wrapper spans we (or earlier sessions) created.
  if (root.style.backgroundColor) root.style.backgroundColor = '';
  root.querySelectorAll('*').forEach(child => {
    if (child.style && child.style.backgroundColor) child.style.backgroundColor = '';
  });
});

// Font: select fires only 'change'; no continuous preview is meaningful
document.getElementById('fontSelect').addEventListener('change', (e) => {
  const session = captureTextStyleSession();
  if (!session) return;
  applyTextStyle(session, 'fontFamily', `'${e.target.value}', sans-serif`);
  if (session.snapshot) pushUndo(session.iframe, session.snapshot);
});
document.getElementById('bgColor').addEventListener('change', (e) => {
  if (selection.type !== 'container' || !selection.el) return;
  pushUndo(selection.iframe, snapshotIframe(selection.iframe));
  selection.el.dataset.__bgColor = e.target.value;
  const pct = parseFloat(selection.el.dataset.__bgOpacity || '100');
  selection.el.style.backgroundColor = hexToRgba(e.target.value, pct);
});
document.getElementById('bgOpacity').addEventListener('input', (e) => {
  if (selection.type !== 'container' || !selection.el) return;
  selection.el.dataset.__bgOpacity = e.target.value;
  const hex = selection.el.dataset.__bgColor || '#ffffff';
  selection.el.style.backgroundColor = hexToRgba(hex, parseFloat(e.target.value));
});
document.getElementById('bgOpacity').addEventListener('change', () => {
  // Single undo entry per slider release
  if (selection.type !== 'container' || !selection.el) return;
  // We pushed nothing during 'input'; push now for the committed value
  pushUndo(selection.iframe, snapshotIframe(selection.iframe));
});
document.getElementById('deleteContainerBtn').addEventListener('click', () => {
  if (selection.type !== 'container' || !selection.el) return;
  pushUndo(selection.iframe, snapshotIframe(selection.iframe));
  selection.el.remove();
  clearSelection();
});
document.getElementById('closePanelBtn').addEventListener('click', () => clearSelection());

// ─────────────────────────── Z-order (forward/back) ───────────────────────────

function getZ(el) {
  const v = el.ownerDocument.defaultView.getComputedStyle(el).zIndex;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

function reorder(el, direction) {
  if (!el || !el.parentElement) return false;
  const parent = el.parentElement;
  const siblings = Array.from(parent.children).filter(c => c !== el);
  switch (direction) {
    case 'front': {
      const maxZ = siblings.reduce((m, c) => Math.max(m, getZ(c)), 0);
      el.style.zIndex = String(maxZ + 1);
      parent.appendChild(el);
      return true;
    }
    case 'back': {
      const minZ = siblings.reduce((m, c) => Math.min(m, getZ(c)), 0);
      el.style.zIndex = String(minZ - 1);
      if (parent.firstElementChild !== el) parent.insertBefore(el, parent.firstElementChild);
      return true;
    }
    case 'forward':
      el.style.zIndex = String(getZ(el) + 1);
      return true;
    case 'backward':
      el.style.zIndex = String(getZ(el) - 1);
      return true;
  }
  return false;
}

// Reorder target depends on what's selected:
// - container selection: that container
// - text selection: the nearest absolute-positioned ancestor
function getReorderTarget() {
  if (!selection.el) return null;
  if (selection.type === 'container') return { el: selection.el, iframe: selection.iframe };
  if (selection.type === 'text') {
    const ancestor = selection.el.closest && selection.el.closest('.__editor-draggable');
    if (ancestor) return { el: ancestor, iframe: selection.iframe };
  }
  return null;
}

function wireOrderBtn(id, direction) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const tgt = getReorderTarget();
    if (!tgt) return;
    const snap = snapshotIframe(tgt.iframe);
    if (reorder(tgt.el, direction)) {
      pushUndo(tgt.iframe, snap);
    }
  });
}
wireOrderBtn('orderFrontBtn', 'front');
wireOrderBtn('orderForwardBtn', 'forward');
wireOrderBtn('orderBackwardBtn', 'backward');
wireOrderBtn('orderBackBtn', 'back');
wireOrderBtn('orderFrontBtnText', 'front');
wireOrderBtn('orderForwardBtnText', 'forward');
wireOrderBtn('orderBackwardBtnText', 'backward');
wireOrderBtn('orderBackBtnText', 'back');


// Click outside any slide → deselect
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#contextPanel')) return;
  if (e.target.closest('.slide-card')) return;
  clearSelection();
}, true);

// ─────────────────────────── BG edit (pan + zoom) ───────────────────────────

// The slide's visible background can live on <body> and/or the full-bleed
// .slide/main wrapper. Return every element that should receive bg changes so
// "change background" and "adjust background" act on what the user actually sees.
function bgHosts(doc) {
  const hosts = [doc.body];
  const root = doc.querySelector('.slide, main');
  if (root && root !== doc.body) hosts.push(root);
  return hosts;
}

function toggleBgEdit(iframe, button) {
  if (iframe.dataset.bgEdit === '1') {
    exitBgEditState(iframe);
    button.textContent = 'התאם רקע';
    button.classList.remove('active');
  } else {
    enterBgEditState(iframe);
    button.textContent = 'סיום';
    button.classList.add('active');
  }
}

function enterBgEditState(iframe) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  clearSelection();
  pushUndo(iframe, snapshotIframe(iframe));
  iframe.dataset.bgEdit = '1';
  iframe.parentElement.classList.add('bg-editing');
  doc.body.classList.add('__bg-editing');
  if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();

  iframe._bgState = { posX: 0, posY: 0, sizePct: 100 };
  bgHosts(doc).forEach(host => {
    host.style.backgroundRepeat = 'no-repeat';
    host.style.backgroundPosition = '0px 0px';
    host.style.backgroundSize = '100%';
  });

  attachBgPointerHandlers(iframe);
}

function exitBgEditState(iframe) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  doc.body.classList.remove('__bg-editing');
  iframe.parentElement.classList.remove('bg-editing');
  delete iframe.dataset.bgEdit;
  if (iframe._bgCleanup) {
    iframe._bgCleanup();
    iframe._bgCleanup = null;
  }
}

function attachBgPointerHandlers(iframe) {
  const doc = iframe.contentDocument;
  const body = doc.body;
  const win = doc.defaultView;

  function applyBg() {
    const s = iframe._bgState;
    bgHosts(doc).forEach(host => {
      host.style.backgroundPosition = `${s.posX}px ${s.posY}px`;
      host.style.backgroundSize = `${s.sizePct}%`;
    });
  }

  let startX = 0, startY = 0;
  let basePosX = 0, basePosY = 0;
  let pinchStartDist = 0, pinchStartSize = 0;

  const touchDist = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const onPointerDown = (e) => {
    if (e.pointerType === 'touch' && !e.isPrimary) return;
    startX = e.clientX;
    startY = e.clientY;
    basePosX = iframe._bgState.posX;
    basePosY = iframe._bgState.posY;

    const onMove = (ev) => {
      ev.preventDefault();
      iframe._bgState.posX = basePosX + (ev.clientX - startX);
      iframe._bgState.posY = basePosY + (ev.clientY - startY);
      applyBg();
    };
    const onUp = () => {
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', onUp);
      win.removeEventListener('pointercancel', onUp);
    };
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onUp);
    win.addEventListener('pointercancel', onUp);
  };

  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      pinchStartDist = touchDist(e.touches);
      pinchStartSize = iframe._bgState.sizePct;
    }
  };
  const onTouchMove = (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const d = touchDist(e.touches);
      const next = pinchStartSize * (d / pinchStartDist);
      iframe._bgState.sizePct = Math.max(10, Math.min(500, next));
      applyBg();
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    const next = iframe._bgState.sizePct - e.deltaY * 0.1;
    iframe._bgState.sizePct = Math.max(10, Math.min(500, next));
    applyBg();
  };

  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('touchstart', onTouchStart, { passive: false });
  doc.addEventListener('touchmove', onTouchMove, { passive: false });
  doc.addEventListener('wheel', onWheel, { passive: false });

  iframe._bgCleanup = () => {
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('touchstart', onTouchStart);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('wheel', onWheel);
  };
}

// ─────────────────────────── Toolbar / per-slide actions ───────────────────────────

document.getElementById('undoBtn').addEventListener('click', undo);

function addTextTo(iframe) {
  if (!iframe || !iframe.contentDocument) return;
  if (iframe.dataset.bgEdit === '1') return;
  pushUndo(iframe, snapshotIframe(iframe));
  const doc = iframe.contentDocument;
  const root = doc.querySelector('.slide, main') || doc.body;
  const topZ = Array.from(root.children).reduce((m, c) => Math.max(m, getZ(c)), 0) + 1;
  const newText = doc.createElement('div');
  newText.style.cssText = `position:absolute;top:50%;right:50%;transform:translate(50%,-50%);z-index:${topZ};font-family:Heebo,sans-serif;font-size:48px;color:#ffffff;font-weight:700;text-shadow:0 2px 8px rgba(0,0,0,0.4);`;
  newText.setAttribute('contenteditable', 'true');
  newText.textContent = 'טקסט חדש';
  root.appendChild(newText);
  attachTextEditUndo(newText, iframe);
  makeDraggable(newText, doc, iframe);
  newText.focus();
}

function addContainerTo(iframe) {
  if (!iframe || !iframe.contentDocument) return;
  if (iframe.dataset.bgEdit === '1') return;
  pushUndo(iframe, snapshotIframe(iframe));
  const doc = iframe.contentDocument;
  const root = doc.querySelector('.slide, main') || doc.body;
  const topZ = Array.from(root.children).reduce((m, c) => Math.max(m, getZ(c)), 0) + 1;
  const container = doc.createElement('div');
  container.style.cssText = `position:absolute;left:140px;top:1000px;z-index:${topZ};width:800px;min-height:200px;padding:42px 56px;border-radius:32px;background:rgba(255,255,255,0.9);box-shadow:0 14px 40px rgba(0,0,0,0.10);`;
  const text = doc.createElement('div');
  text.style.cssText = 'font-family:Heebo,sans-serif;font-size:44px;font-weight:700;color:#2D1B3D;text-align:right;';
  text.setAttribute('contenteditable', 'true');
  text.textContent = 'טקסט חדש';
  container.appendChild(text);
  root.appendChild(container);
  makeDraggable(container, doc, iframe);
  attachTextEditUndo(text, iframe);
  selectContainer(container, iframe);
}

let bgTargetIframe = null;
function triggerBgChange(iframe) {
  if (iframe.dataset.bgEdit === '1') return;
  bgTargetIframe = iframe;
  const input = document.getElementById('bgFileInput');
  input.value = '';
  input.click();
}
document.getElementById('bgFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file || !bgTargetIframe || !bgTargetIframe.contentDocument) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    pushUndo(bgTargetIframe, snapshotIframe(bgTargetIframe));
    const body = bgTargetIframe.contentDocument.body;
    const slide = body.querySelector('.slide');
    const bgValue = `url(${ev.target.result}) center / cover no-repeat`;
    // Apply on BOTH body and .slide so the image shows regardless of which
    // element is acting as the slide's visual background.
    body.style.background = bgValue;
    if (slide) slide.style.background = bgValue;
  };
  reader.readAsDataURL(file);
});

// ─── Per-container BG image ───
document.getElementById('containerBgImageBtn').addEventListener('click', () => {
  if (selection.type !== 'container' || !selection.el) return;
  document.getElementById('containerBgInput').value = '';
  document.getElementById('containerBgInput').click();
});
document.getElementById('containerBgInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file || selection.type !== 'container' || !selection.el) return;
  const reader = new FileReader();
  const targetEl = selection.el;
  const targetIframe = selection.iframe;
  reader.onload = (ev) => {
    pushUndo(targetIframe, snapshotIframe(targetIframe));
    targetEl.style.backgroundImage = `url(${ev.target.result})`;
    targetEl.style.backgroundSize = 'cover';
    targetEl.style.backgroundPosition = 'center';
    targetEl.style.backgroundRepeat = 'no-repeat';
  };
  reader.readAsDataURL(file);
});
document.getElementById('containerBgClearBtn').addEventListener('click', () => {
  if (selection.type !== 'container' || !selection.el) return;
  pushUndo(selection.iframe, snapshotIframe(selection.iframe));
  selection.el.style.backgroundImage = '';
  selection.el.style.backgroundSize = '';
  selection.el.style.backgroundPosition = '';
  selection.el.style.backgroundRepeat = '';
});

// ─────────────────────────── Save flow + modal/toast/header UI ───────────────────────────

function openSaveModal(title, message) {
  saveModalTitle.textContent = title;
  saveModalMessage.textContent = message;
  saveModalDismissBtn.style.display = '';
  saveModalDismissBtn.textContent = 'סגור והמשך ברקע';
  bindModalDismiss();
  saveModal.hidden = false;
}
function setSaveModalProgress(title, message) {
  if (!saveModal.hidden) {
    saveModalTitle.textContent = title;
    saveModalMessage.textContent = message;
  }
}
function closeSaveModalToHeader() {
  saveModal.hidden = true;
  headerSpinner.hidden = false;
}
function dismissAllSaveUi() {
  saveModal.hidden = true;
  headerSpinner.hidden = true;
}
function showSuccessToast(text) {
  successToast.querySelector('span:last-child').textContent = text;
  successToast.hidden = false;
  clearTimeout(showSuccessToast._t);
  showSuccessToast._t = setTimeout(() => { successToast.hidden = true; }, 4000);
}
function showErrorModal(message) {
  saveModal.hidden = false;
  saveModalTitle.textContent = 'שגיאה';
  saveModalMessage.textContent = message;
  saveModalDismissBtn.textContent = 'סגור';
  saveModalDismissBtn.onclick = () => {
    saveModal.hidden = true;
    saveModalDismissBtn.onclick = null;
  };
  headerSpinner.hidden = true;
}
function bindModalDismiss() {
  saveModalDismissBtn.onclick = closeSaveModalToHeader;
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  openSaveModal('ממיר את העריכה לתמונות', 'מכין את 5 השקפים…');
  setStatus('');

  try {
    await document.fonts.ready;
    const slides = [];
    const iframes = document.querySelectorAll('iframe.slide-frame');

    for (const iframe of iframes) {
      const idx = parseInt(iframe.dataset.slideIndex, 10);
      const doc = iframe.contentDocument;
      if (!doc) continue;

      if (iframe.dataset.bgEdit === '1') exitBgEditState(iframe);

      doc.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
      doc.querySelectorAll('.__editor-draggable').forEach(el => el.classList.remove('__editor-draggable', '__editor-dragging'));
      doc.querySelectorAll('.__editor-selected').forEach(el => el.classList.remove('__editor-selected'));
      doc.querySelectorAll('[data-__passthrough]').forEach(el => { el.style.pointerEvents = ''; el.removeAttribute('data-__passthrough'); });
      doc.querySelectorAll('style[data-editor-affordance]').forEach(el => el.remove());

      setSaveModalProgress('ממיר את העריכה לתמונות', `שקף ${idx} מתוך ${iframes.length}…`);
      setStatus(`שקף ${idx}/${iframes.length}…`);

      // html-to-image renders via <foreignObject>, so the browser engine itself
      // paints the DOM — this honours backdrop-filter, modern CSS, web fonts,
      // and SVG that html2canvas was dropping.
      if (doc.fonts && doc.fonts.ready) await doc.fonts.ready;
      const pngBase64 = await htmlToImage.toPng(doc.body, {
        width: 1080,
        height: 1350,
        pixelRatio: 1,
        cacheBust: true
      });

      const cleanHtml = '<!doctype html>' + doc.documentElement.outerHTML;
      enableEditMode(iframe);

      slides.push({ index: idx, html: cleanHtml, png_base64: pngBase64 });
    }

    setSaveModalProgress('שולח ל-WhatsApp', 'מעלה ושולח את השקפים…');
    setStatus('שולח ל-WhatsApp…');

    const res = await fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carousel_id: carouselId, slides })
    });
    if (!res.ok) {
      let msg = 'save failed';
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    dismissAllSaveUi();
    setStatus('נשמר ✓');
    showSuccessToast('השקפים נשלחו ל-WhatsApp בהצלחה');
    undoStack.length = 0;
    updateUndoButton();
    clearSelection();
  } catch (err) {
    console.error(err);
    showErrorModal(err.message || 'משהו השתבש בשמירה');
    setStatus('שגיאה');
  } finally {
    btn.disabled = false;
  }
});

function setStatus(msg) {
  if (statusTextEl) statusTextEl.textContent = msg;
  else statusEl.textContent = msg;
}

loadCarousel();
