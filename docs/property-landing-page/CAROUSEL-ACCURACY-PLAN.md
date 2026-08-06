# Plan — increase accuracy of the landing-page carousel

## What "the carousel" is here
The `"למה דווקא כאן"` cards on the property page: `carousel.slides[] =
{num, title, body, tag}` (see `pages.ts`, rendered in `p/page.js` and the
`nocturne/galerie/reel` templates). They are **not** the social carousel editor
(`public/c/`, `createCarouselDraft`).

## Where the content comes from
The n8n **Property Page Builder** workflow (DESIGN.md §"n8n Property Page
Builder") produces `hero_phrase`, `carousel_slides` and `cta` via **one Claude
structured call**, from:
- the listing's structured fields (`address, neighborhood, city, price, rooms,
  size_sqm, floor, parking, description`), and
- the Area Intelligence research (neighborhood profile + stats).

It then `POST`s them to `createPropertyPage`, which stores them verbatim
(`carousel.slides = body.carousel_slides.slice(0,6)`). **No grounding or
fact-check happens today** — whatever the model writes ships.

## Why the cards come out inaccurate — root causes
1. **Thin input → the model fills gaps.** Agents often submit a short or empty
   `description`. With little to say, the model invents specifics: a view, a
   renovation year, "מרפסת שמש", "נדיר באזור", "פעם בעשור".
2. **No fact allowlist.** Nothing constrains claims to what's actually known
   about *this unit*, so plausible-but-false details appear.
3. **Neighborhood → unit bleed.** Area-research facts (schools, price/sqm trend,
   "+42% בחמש שנים") get re-attributed to the specific apartment.
4. **The anti-hallucination rule only covers area stats.** DESIGN.md §4's
   source-or-drop rule applies to `area.stats`, **not** to the carousel copy.
5. **Photo evidence is unused for copy.** The pipeline runs a Vision Tagger
   before WW1, but its tags don't ground the carousel — so real, photo-visible
   features aren't preferred over invented ones.
6. **Agent review is optional and skipped.** Pages build INACTIVE and the edit
   form can fix card text, but there's no step that asks the agent to *verify
   claims*, so errors go live.

## The plan (ordered by impact/effort)

### 1. Ground generation in an explicit FACT SHEET (biggest win)
In the builder, assemble a `FACTS` object and make it the **only** admissible
source of concrete property claims:
- structured fields (deal type, price, rooms, sqm, floor, parking, address,
  neighborhood, city),
- the agent `description` (verbatim), and
- Vision-Tagger tags (step 3).

Prompt rule: *"Every concrete claim in `title`/`body`/`tag` must be supported by
an item in FACTS or paraphrase the agent DESCRIPTION. Do NOT introduce
features, conditions, renovation years, views, orientations, counts, or
superlatives that are not in FACTS. Language may be evocative; facts may not be
invented."* Keep a **banned-without-evidence** list: renovation year, specific
view/orientation, "ממ״ד", balcony, parking count, floor, "נדיר/פעם בעשור",
school quality tied to the unit.

### 2. Extend source-or-drop to the carousel
A card that can only be written by asserting an unsupported fact is **dropped**,
not softened into a vaguer invention. Floor is `min 2, max 6` cards. Fewer true
cards beat more embellished ones — same philosophy already applied to
`area.stats`.

### 3. Feed Vision-Tagger output into FACTS
Persist the Vision Tagger tags on the `listings/{id}` doc and pass them to the
builder. Photo-derived tags ("sea view", "renovated kitchen", "balcony") are
grounded in the actual unit, so the model prefers them over guesses. This also
lets area/neighborhood facts stay clearly separated from unit facts.

### 4. Add a cheap fact-check pass before publish
After the copy call, a second **low-temperature** Claude call (or structured
self-check) gets `FACTS + generated slides` and returns, per slide, `supported:
bool` + the offending claim. Drop unsupported slides (respecting the min-2
floor) or regenerate once. Deterministic pre-filter first: regex out slides that
state a **number** (year, `%`, `מ״ר`, floor, room count, price) that
contradicts `property.*`.

### 5. Turn the tone down where it matters
Lower `temperature` on the copy call; reserve creativity for phrasing only.
Require the `tag` to be a short factual label (e.g. "3 חניות בטאבו") rather than
a marketing superlative.

### 6. Make agent verification a first-class step
Since pages already build INACTIVE, the approval/edit screen (`public-agent/
edit.html`, `updatePropertyPage`) should surface the carousel with a
"בדקו שהפרטים נכונים" nudge and one-tap remove per card. The edit path already
supports per-card `title/body/tag` edits — we're only elevating the review.

### 7. Repo-side guardrail + auditability (implementable in this repo)
- In `createPropertyPage`, store the `FACTS` snapshot and `sources[]` alongside
  the page for auditability (mirrors area `sources[]`).
- Add a small, **deterministic** server-side filter that drops any slide whose
  body/title states `rooms/sqm/floor/price/parking` numbers contradicting
  `property.*`. Keep it conservative — no semantic judgement server-side.

## How we measure
- Human-rate claim accuracy on a sample of ~30 generated pages, before vs after.
- Track **agent edit rate on carousel cards** (via `edit_count` + a field-level
  flag) as a live proxy for inaccuracy — it should fall.

## Suggested rollout order
1. FACTS grounding + banned-claims + source-or-drop in the builder prompt (§1–2).
2. Vision-Tagger tags into FACTS (§3).
3. Fact-check pass (§4) + tone (§5).
4. Elevate agent review (§6) and add the repo-side audit/guardrail (§7).

Steps 1 and 4 (grounding + fact-check) deliver most of the accuracy gain and can
ship first, entirely inside the n8n prompt with no page-schema change.
