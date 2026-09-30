# Passage & Soleil — video-story templates

Two new property landing templates that tell the apartment's story over a full-screen video. They share one scroll engine and differ in shapes, colors and type. Approved prototypes: `docs/template-redesign/passage.html` and `docs/template-redesign/soleil.html` (open locally; they use `docs/template-redesign/assets/`).

## Shared guidelines (both templates)

- **The video is a fixed background layer** for the whole page (`<video data-video muted loop playsinline>` plus a poster). It autoplays muted and loops, and the page scrolls over it. It does not scrub with scroll.
- **Gaps between sections** let the video show through.
- **At most 4 colors per template.** Alpha variants of those colors are allowed.
- **No chapter labels.** The property headlines (`texts.why_title` etc.) stay.
- **Six chapters:**

| # | Chapter | Content | Background |
|---|---|---|---|
| 1+2 | Arrival → Reveal | One sticky pin, `165vh` tall. It opens on `hero.phrase` with a scroll cue. As you scroll, the phrase fades and the data appears in stages **at the bottom of the video**: deal type → title → address → **line 1: full price** → **line 2: specs** (m² · rooms · floor · parking, wrapping on mobile). The video dims slightly as the data lands. | video |
| 3 | Living here | Headline, `why_sub`, amenity chips, and an **interactive highlights block** (`carousel.slides`). | panel, plain scroll-over (no edge) |
| 4 | Inside | Gallery: **one big image plus a row of clickable thumbnails**. It **auto-swipes left every 2.5 s** while on screen, supports swipe gestures, and a thumbnail click swaps the image and restarts the timer. | panel |
| 5 | Around | A **thin glass panel over the video**: headline, blurb, then `area.stops` and `area.stats` in **one aligned row style** (label on the start side, value on the end side, a hairline under each row). Two columns on desktop, one on mobile. | video + translucent panel |
| 6 | Invitation | Headline, CTA text, agent, lead form. | panel |

- **Auto-cycles:** the highlights and the gallery both open their first item immediately, then advance **every 2.5 s only while at least 30% of the block is visible**. Picking an item restarts the timer. The progress bar lasts 2.5 s.
- **The top bar** is transparent over the video. It gets a solid background once the pin has scrolled past, because a white brand name is invisible on cream and white panels.
- **Reduced motion:** all reveal items show at once, edges are flat, auto-cycles are off (manual picking still works), and the video still plays (it is content).

## Edge catalog

Each section gets `data-edge="<id>"`. The shape is driven by `--p` (0 while entering → 1 when landed), so swapping an edge later is a one-word change. Edge CSS lives in each template's own `<style>`; a template only carries the ids it uses.

| ID | Name | Used by |
|---|---|---|
| E-A | Stepped notch (the Classic/Nocturne step, animated) | — |
| E-B | Arch doorway (widens to full bleed) | Passage 3→4 |
| E-C | Iris window (a circle that grows) | — |
| E-D | Leveling slant | Passage 5→6 |
| E-E | Dome | — |
| E-F | Terraces (4 steps that flatten; `data-flip` mirrors it) | Soleil 3→4, Soleil 5→6 (flipped) |
| E-G | Sawtooth | — |

Masks inside sections (M-A shaped windows, M-B type knockout, M-C feathered rise, M-D iris close) were explored and **not used**.

## Passage

- **Colors:** cream `#F3EDE2` · white `#FFFFFF` · gold `#B8935A` · ink `#1E1C19`.
- **Type:** Frank Ruhl Libre (display) and Heebo (body).
- **Reveal:** gold price, and a gold `·` between specs.
- **Sections:** 3 cream · 4 ink with E-B · 5 ink glass with a gold hairline border and blur · 6 white with E-D, gold submit button.
- **Highlights:** a horizontal **photo accordion**. The open panel grows (`flex 1 → 4.2`) to show its body and tag, and the others collapse to strips with a vertical title. **On mobile** the panels stack, the open one is `min(340px, 52svh)` tall and pushes the next ones down, and the others are `68px`. Panels open on click/tap only, never on hover: hover made the panels shift under the cursor.
- **Gallery:** 16:9 stage (4:5 on mobile), gold border on the active thumbnail, a `n / N` counter on the stage.

## Soleil

- **Colors:** warm white `#FAF7F2` · olive `#5E6B4E` · terracotta `#C4673F` · charcoal `#2F2C28`.
- **Type:** Suez One (display) and Assistant (body).
- **Arch motif:** used **only** on the deal-type tag in the reveal, the Living arch window and its tag chip, the specs separators, and the Around glass panel's top. Everything else is plain square: the top-bar "תיאום ביקור" button, the gallery stage and thumbnails, the lead form card, the submit button and the agent avatar.
- **Reveal:** an arch-shaped terracotta deal tag, the price on a terracotta underline, and small terracotta arches as spec separators.
- **Amenity chips:** bold, no tinted fill, raised with a soft shadow on the page's warm white, square corners.
- **Highlights:** an **arch window plus a numbered list**. The active item's text opens (`grid-template-rows 0fr → 1fr`), the arch crossfades to that highlight's photo, and a tag chip on the arch shows its `tag`. On mobile the arch sits above the list, and opening an item pushes the items below it down.
- **Sections:** 3 warm white · 4 charcoal with E-F · 5 olive glass with an arched top · 6 olive with E-F flipped and the form on a warm-white square card.
- **Gallery:** a square-cornered 16:9 stage (4:5 on mobile), square 1:1 thumbnails where the active one lifts with a terracotta underline, and the caption plus `n / N` below the stage.

## Architecture

### New files
- `public-nadlan/templates/story.js` is the **shared engine** (target under 200 lines, vanilla JS, no dependencies). It is loaded after `runtime.js`. It handles:
  - **Scroll loop:** one passive `scroll` listener feeding `requestAnimationFrame`. It sets the reveal progress (it toggles `.on` on `[data-at]` items and sets `--dim` on `:root`), sets `--p` on every `[data-edge]` section, adds a solid class to the top bar after the pin, and **pauses the video while an opaque panel fully covers the viewport** (to save battery), resuming otherwise. It also calls `play()` again if the video was paused by the browser.
  - **`.in-view` fade-ins** through a single IntersectionObserver.
  - **`cycle(el, n, show)`:** the 2.5 s auto-advance helper, visibility-gated, returning `{pick, step}`.
  - **Highlights:** driven by `[data-story-highlights]`, which reuses whatever markup `data-list="carousel.slides"` rendered. The accordion (Passage) and the list plus window (Soleil) differ only in CSS and in which elements get `.on`, which the template selects with `data-story-mode="accordion|window"`.
  - **Gallery:** reads the tiles `runtime.js` already builds in `[data-gallery]` (these become the thumbnails) and mirrors each tile's `<img>` (or the demo's `<canvas>` frame, copied with `drawImage`) into the stage track. Tiles fill in asynchronously, so a MutationObserver watches for `.loaded`. Thumbnail clicks are intercepted in the capture phase so they swap the stage instead of opening the lightbox. **A click on the stage opens the runtime lightbox** at the current index.
  - **Highlight photos:** each highlight uses the gallery photo `(k + 1) % n` taken from the same tiles, so real listings and the demo preview both work.
- `public-nadlan/templates/passage.html` and `soleil.html`: self-contained markup and CSS like the existing templates, using only the documented `runtime.js` bindings (`data-bind`, `data-fmt`, `data-deal`, `data-price-label`, `data-show`, `data-video`, `data-list`, `data-gallery`, `data-amenities`, `data-avatar`, `data-logo`, `data-lead-form`, `data-i18n`). Each file stays under 500 lines.

`templates/vendor/` already ships GSAP, ScrollTrigger and Lenis. They are deliberately **not** used: the engine needs `--p` values and one sticky pin, not a timeline library.

### Registration (same places as `orbite`)
- `server/utils.js` `TEMPLATES`, `server/routes/pages.js` `SERVER_TEMPLATES`, `public-nadlan/p/page.js` `TEMPLATES`: add `passage` and `soleil`.
- `server/property-draft.js` aliases: `passage: ["פסאז׳", "פסאז", "passage"]`, `soleil: ["סוליי", "soleil"]`. Update the key order in `server/property-draft.test.js` to match the picker.
- `public-agent/create.html`: two picker cards (iframe `/tpl/passage.html`, `/tpl/soleil.html`). `public-agent/edit.html`: two `data-tpl` buttons.
- `public-agent/form-i18n.js`: `tpl_passage` and `tpl_soleil` labels in all six languages.

### Data rules and edge cases
- **Missing fields:** each spec item uses `data-show`, so a missing floor or parking value drops that item and its separator (the separator is CSS `span + span`).
- **Rentals:** `data-fmt="price"` adds "/ month", and `data-price-label` switches the label.
- **No `hero.video_url`:** the poster, or else the first gallery photo, becomes the fixed background (`background-image` on `.bg`).
- **Autoplay blocked** (e.g. iOS Low Power Mode): the poster shows, and the engine tries `play()` again on the next scroll.
- **Fewer than 2 photos:** the gallery hides its thumbnails and auto-cycle. With 0 photos the demo canvas fallback from `runtime.js` applies.
- **LTR languages** (en/ru/fr/es): the layout uses logical properties. The gallery track is forced to `direction: ltr` so "swipe left" is always the next photo.
- The lead form, lightbox, beacons and `#edit=` redirect all come from `runtime.js` unchanged.

## Testing
- `node --test server/` stays green, including the updated `property-draft.test.js` key order and aliases.
- **Browser check, each template at 390px and 1440px, in both the demo preview (`/tpl/<name>.html`) and a real page:**
  - The reveal completes within about 0.65 viewport of scrolling.
  - The data sits at the bottom of the video.
  - The price and specs fit on two lines.
  - The edges animate and land flat.
  - The highlights and gallery auto-advance every 2.5 s and respond to taps.
  - The stage opens the lightbox.
  - The top bar becomes solid after the reveal.
  - The Around rows line up.
  - The form submits.
- Reduced motion, a rental listing, a listing with no floor or parking, and an English-language page.

## Out of scope
- Scroll-scrubbed video, which would need server-side keyframe re-encoding.
- The in-section video masks M-A to M-D.
- The unused edges E-A, E-C, E-E and E-G. They are listed for future templates but get no CSS now.
