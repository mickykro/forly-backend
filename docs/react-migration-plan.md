# Plan: Migrating the forly-backend frontend to React

Scope assumption: "the frontend" = the live **app** hosting target — the carousel
editor (`/c/{id}`) and the signup wizard (`/signup`). The nadlan property landing
pages (`public-nadlan/`) are deliberately **excluded** (SEO-facing; see Phase 4).
`public-agent/` is dead code (not referenced by `firebase.json`) and should be
deleted, not migrated.

## Current state

| Surface | Location | Size | Notes |
|---|---|---|---|
| Carousel editor | `public/c/` | ~1,270 lines (`editor.js` 1,000) | iframe-per-slide editing, contenteditable, pointer drag, undo stack, `html-to-image` from CDN, save → WhatsApp |
| Signup wizard | `public/signup/index.html` | 562 lines, inline JS | calls `/api/signup-save`, `-upload`, `-get`, `-complete` |
| Slide design sample | `public/preview-slide.html` | 157 lines | static 1080×1350 artifact — keep verbatim, do not convert |
| Root page | `public/index.html` | 89 lines | Firebase boilerplate placeholder |
| Nadlan pages | `public-nadlan/` | ~1,780 lines | separate hosting target, SEO-facing — out of scope |
| Agent portal | `public-agent/` | ~2,000 lines | **not deployed** — delete instead of migrating |

Everything is vanilla JS with no build step. All backend calls go through
same-origin Firebase Hosting rewrites to Cloud Functions — the migration touches
**zero backend code**.

## Recommended stack

- **Vite + React 19 + TypeScript**, configured as a multi-page app (one entry per
  page: `editor`, `signup`). No SSR — Firebase Hosting stays static.
- **No router** — pages remain separate HTML entries; the carousel id keeps being
  read from `location.pathname` exactly as today.
- **State**: React state + a small store (Zustand, ~1 KB) for editor
  selection/undo/carousel data. No Redux.
- **CSS**: keep the existing stylesheets as-is initially (RTL, Heebo fonts
  untouched); modernize opportunistically later.
- **`html-to-image`**: move from the jsdelivr CDN `<script>` to a pinned npm
  dependency (same version 1.11.13) so it's bundled and version-locked.

New layout: a `web/` directory at the repo root (`web/src`, `web/vite.config.ts`)
building into `web/dist`. `firebase.json` app target changes `"public": "public"`
→ `"public": "web/dist"` plus a predeploy `npm --prefix web run build`. Files
that must stay byte-identical (`preview-slide.html`) are passed through via Vite's
`publicDir`. Rewrites, headers, and function bindings stay unchanged.

## How long will it take

Estimates for one developer, including testing:

| Phase | Work | Duration |
|---|---|---|
| 0 | Scaffold `web/` (Vite MPA, TS, ESLint), wire `firebase.json` + emulator + CI build check | 1–2 days |
| 1 | Signup wizard → React (lowest risk, proves the pipeline) | 2–4 days |
| 2 | Carousel editor → React (the bulk and the risk) | 1.5–2.5 weeks |
| 3 | Parity QA, preview-channel bake, cutover, delete dead code | 3–5 days |
| **Total** | | **~3–4.5 weeks** |

With Claude Code doing the implementation, the code-conversion phases compress to
roughly 3–5 working sessions (a few days). What does **not** compress is the
verification tail: pixel-diffing exported slides against production output and
testing the editor on real phones (users arrive from WhatsApp on mobile). Realistic
AI-assisted calendar time: **1–2 weeks including bake time**, of which hands-on
implementation is a few days.

Optional Phase 4 (nadlan pages) would add ~1 week and is recommended **against**
as client-side React — those pages are SEO-facing landing pages, and moving them
to client-rendered React would hurt LCP and indexing. If they ever move, they
should be prerendered/SSR (e.g. folded into the Astro-based creator website).

## How it affects the website

**URLs and behavior**: no changes. `/c/{id}` and `/signup` keep working, hosting
rewrites and `/api/*` endpoints are untouched, Hebrew RTL and fonts unchanged.
Target is pixel parity. The #1 parity requirement: the html-to-image → WhatsApp
export must produce identical images.

**Slide HTML documents** (loaded from `slide.html_url` into iframes) are generated
content, not code being migrated — the React editor must keep rendering them
exactly as today.

## How it affects speed

- **First load**: React + ReactDOM add ~45 KB gzipped. Offsetting wins: the app
  code finally gets minified (it ships unminified today), and the separate
  jsdelivr CDN request for html-to-image (extra DNS/TLS handshake) disappears into
  the bundle. Net effect on the editor page: roughly **+30–50 KB gzipped**, i.e.
  a few hundred ms on slow 3G, negligible on 4G/WiFi.
- **Repeat loads get faster**: Vite emits content-hashed filenames, so JS/CSS can
  ship `Cache-Control: public, max-age=31536000, immutable` (today the app target
  sets no explicit JS/CSS caching). HTML stays `no-cache` as now.
- **Runtime**: editing interactions (drag, contenteditable) live inside the slide
  iframes and must stay imperative DOM code. Done right — refs and imperative
  pointer handlers, React state updated only on commit — runtime feel is
  unchanged. Done naively (React state per `pointermove`), the editor gets
  visibly worse. The porting rule below exists to prevent that.
- **SEO/LCP**: zero risk, because the SEO-facing nadlan pages are out of scope.

## How it affects packages and maintenance

- **New runtime deps**: `react`, `react-dom`, `html-to-image` (moved from CDN),
  optionally `zustand`.
- **New dev deps**: `vite`, `@vitejs/plugin-react`, `typescript`, `eslint`,
  `vitest` + `@testing-library/react`, optionally Playwright for e2e.
- **Ongoing cost**: a dependency tree to update/audit where today there is none,
  and a mandatory build step — each hosting deploy takes ~30–60 s longer via the
  predeploy hook. Local dev improves: `vite dev` with hot reload, proxying
  `/api/*` to the Firebase emulator.
- CLAUDE.md deploy rules unchanged — every deploy still requires explicit
  approval.

## Phase 2 in detail (the editor)

Split `editor.js` (1,000 lines) into:

- `api.ts` — get/save draft calls (ported verbatim).
- `slideFrame.ts` — iframe mounting + all inner-document editing (drag,
  contenteditable, background editing) as plain imperative TS, **ported, not
  rewritten**. React never reaches inside the iframes.
- `store.ts` — selection, undo stack (max 30, same semantics), carousel data.
- React components — `Toolbar`, `ContextPanel`, `SaveModal`, `SuccessToast`,
  `SlideList`. This is where React genuinely pays off: the current code wires
  ~30 `getElementById`/`addEventListener` pairs by hand.

Port order: load & render slides → selection + context panel → drag → undo →
save/export. Each step verified against production behavior before the next.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Mobile drag/contenteditable regressions (users edit on phones from WhatsApp) | Port the pointer/inner-doc code verbatim as imperative TS; test on real devices before cutover |
| html-to-image output drift (fonts, RTL, image CORS) | Pin the exact current version; pixel-diff exports of a fixed set of drafts against production output |
| Undo behavior changes | Port stack semantics as-is into the store; unit-test snapshots |
| Rollout breakage | Deploy to a Firebase Hosting preview channel first; bake; then release. Rollback = redeploy the old `public/` (kept in git until the React version is stable) |

## Rollout

1. Ship Phase 1 (signup) first — small blast radius, proves build + deploy.
2. Editor goes to a preview channel; QA there (desktop + real phones + export
   pixel-diff), then release to live.
3. Keep the legacy `public/` in git for instant rollback; delete it plus
   `public-agent/` once the React version has been stable for a week or two.

Every deploy in this rollout follows the repo rule: state the exact command,
wait for explicit approval.
