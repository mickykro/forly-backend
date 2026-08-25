# Nocturne Template Redesign Direction

## Candidate Directions

### 1. Noir Gallery
**Very Brief Intro:** A dark property editorial inspired by a private gallery opening: oversized imagery, disciplined typography, and a quiet gold line that guides the visitor through the listing.

**Probability:** 0.08

### 2. Midnight Ledger
**Very Brief Intro:** A financial-precision listing page that foregrounds the numbers, neighbourhood metrics, and provenance of the asset.

**Probability:** 0.03

### 3. Night Drive
**Very Brief Intro:** A cinematic scrolling experience with bolder motion and a more immersive film-treatment for the property tour.

**Probability:** 0.05

## Chosen Direction: Noir Gallery

### Design Movement
Noir Gallery treats the property as a carefully selected exhibit. It preserves the Nocturne template’s dark foundation while replacing the generic stacked sections with a composed visual sequence: arrival, proof, moments, place, and private viewing.

### Core Principles
1. **The listing media leads:** Hero video and gallery images should remain the primary visual evidence, while every text layer stays calm and deliberately narrow.
2. **Numbers feel collected, not tabular:** Price, rooms, size, and floor are elevated into an asymmetric proof strip that has clear hierarchy without a dashboard feel.
3. **Information becomes editorial rhythm:** The existing highlights, gallery, address, metrics, agent, and lead-form data hooks stay intact while their visual ordering gains more breathing room.
4. **A private-viewing CTA stays within reach:** A slim floating inquiry trigger, plus the existing contact form, makes conversion feel intentional rather than invasive.

### Color Philosophy
Noir uses **ink navy** `#080B12`, near-black **graphite** `#10151E`, vellum `#F5F0E6`, smoked pearl `#AAAEB6`, and subdued antique gold `#C4A46A`. The listing media brings the color; the interface supplies contrast and containment.

### Layout Paradigm
The desktop page is a **gallery promenade**: a wide, cinematic hero; a horizontally divided proof strip; editorial two-column storytelling; an asymmetric image mosaic; a quiet local-area panel; then a dark private-viewing room. On mobile it collapses to a deliberate single-column reading order.

### Signature Elements
1. A vertical **catalog index** beside the hero title, showing the listing’s deal type, neighbourhood, and price context.
2. A **proof strip** in which the requested price is visibly dominant and the key specifications sit as quiet supporting entries.
3. A **private viewing rail** that appears on scroll and jumps to the real existing lead form.

### Interaction Philosophy
Gallery cards maintain their current click-ready structure. The header shifts to a frosted state after scroll. Buttons use compact, confident microcopy. Hover states lift only with transform and opacity and respect reduced-motion preferences.

### Typography System
Frank Ruhl Libre remains the refined display voice for Hebrew titles; Heebo keeps metadata and form content highly legible. Large type is treated as architectural negative space, not decoration.

### Brand Essence
**A dark, collectible property page for listings that deserve a private viewing.**

## Local Validation

The template was previewed through the existing Forly demo runtime at `/tpl/nocturne.html`. Runtime listing data populated the redesigned hero, proof strip, amenities, highlights, gallery, neighbourhood content, agent block, and lead form. The private-viewing hero CTA correctly scrolled to the existing `#contact` lead form. The forly-backend server test suite passed after the template update.
