# FORLY Server-Page Redesign Plan

## Selected Direction: Property Atelier

The redesigned application will use **Property Atelier**, the warm editorial direction established in the restored property-creation experience. It combines soft ivory surfaces, near-black ink, restrained antique-gold accents, architectural hairlines, and large Hebrew serif headings. The aesthetic will remain distinct from the public property templates: internal and demo flows should feel calm, productive, and premium rather than decorative.

## Shared System

| Layer | Decision | Purpose |
|---|---|---|
| Layout | A compact black utility bar above an ivory workspace, with a slim context rail and responsive content grid | Establishes orientation across account, demo, creation, and edit pages. |
| Typography | Frank Ruhl Libre for editorial headings and Heebo for controls, data, and body copy | Keeps Hebrew content expressive without compromising clarity. |
| Surfaces | Cream background, off-white cards, subtle brass borders, quiet shadows, and numerical micro-labels | Creates hierarchy without dashboard heaviness. |
| Interaction | Gold primary actions, transparent secondary actions, visible focus rings, 160–220ms transitions, and non-blocking status chips | Preserves the existing flows while making state changes legible. |
| RTL and mobile | RTL-first spacing, wrap-safe utility controls, single-column forms below 760px, and sticky action bars that remain reachable | Retains the existing Hebrew-first behavior on small screens. |

## Page Scope

| Page | Redesign treatment | Existing behavior retained |
|---|---|---|
| `public-agent/index.html` | Split authentication card, refined agent dashboard header, cleaner property cards, and a dedicated demo-mode notice | OTP login, property load, archive/extend actions, demo record polling. |
| `public-agent/signup.html` | Three-stage onboarding with an editorial progress marker and a clearer identity/logo area | Signup, optional logo upload, OTP verification, and completion links. |
| `public-agent/create.html` | Property Atelier form shell, stage rail, media atelier, template selection cards, and a more deliberate build-status panel | Authenticated creation, demo creation via `?key=`, autosave, uploads, templates, multilingual form controls, and polling. |
| `public-agent/edit.html` | Side-by-side studio layout with a persistent preview and more scannable content groups | Existing page update and preview behavior. |
| `public-agent/admin.html` | Operational review surface using the shared cards, tables, chips, and controls | Existing administration actions and data loading. |
| Agent and Nadlan legal pages | Minimal branded document frame and readable legal measure | Existing legal text and paths. |
| `public-nadlan/p/index.html` | Light-touch compatibility styling for preview/edit mode and shared brand framing | Existing public listing bindings and editor hooks. |

## Deliberate Exclusions

The public listing templates remain distinct design products. The Nocturne work already completed on this branch will be preserved; Galerie and Reel will retain their own visual character. No API contracts, route paths, storage keys, DOM IDs, or `data-*` hooks used by server/client scripts will be renamed.
