# Slide Decks: HTML Slide Production Standards

Slides are a high-frequency design task. This document explains how to produce good HTML slides — from architecture choices and single-page design, through to the full PDF/PPTX export path.

**Capabilities covered by this skill**:
- **HTML presentation version (the base deliverable — always required by default)** → each page as an independent HTML file + `assets/deck_index.html` assembler, keyboard navigation and fullscreen presentation in the browser
- HTML → PDF export → `scripts/export_deck_pdf.mjs` / `scripts/export_deck_stage_pdf.mjs`
- HTML → editable PPTX export → `references/editable-pptx.md` + `scripts/html2pptx.js` + `scripts/export_deck_pptx.mjs` (requires HTML written to 4 hard constraints)

> **HTML is the foundation; PDF/PPTX are derivatives.** Regardless of the final delivery format, you **must** first build the HTML assembled presentation (`index.html` + `slides/*.html`) — it is the "source" of the slide work. PDF/PPTX are snapshots exported from HTML with a single command.
>
> **Why HTML-first**:
> - Best to use at a live presentation (projector / screen share goes full-screen directly, keyboard navigation, no dependency on Keynote/PPT software)
> - During development, each page can be double-clicked open and verified independently — no need to re-run exports each time
> - The only upstream source for PDF/PPTX export (avoids the dead loop of "discovered a change is needed after export, have to regenerate")
> - Deliverable can be "HTML + PDF" or "HTML + PPTX" as a pair — recipient uses whichever they prefer
>
> 2026-04-22 moxt brochure real-world test: after completing 13 HTML pages + index.html assembly, `export_deck_pdf.mjs` exported the PDF in one line, zero changes. The HTML version itself is a deliverable that can be presented directly in a browser.

---

## Confirm Delivery Format Before Starting (Hardest Checkpoint)

**This decision comes before "single-file vs multi-file".** 2026-04-20 real-world test on the equity private board project: **not confirming delivery format before starting = 2–3 hours of rework.**

### Decision Tree (HTML-first architecture)

All deliverables start from the same HTML assembled page (`index.html` + `slides/*.html`). Delivery format only determines **the writing constraints on the HTML** and **the export command**:

```
[Always required by default] HTML assembled presentation (index.html + slides/*.html)
   │
   ├── Browser presentation only / local HTML archive   → Done here. HTML has maximum visual freedom
   │
   ├── Also need PDF (printing / sharing / archiving)    → Run export_deck_pdf.mjs, one command
   │                                                        HTML writing is unconstrained, no visual restrictions
   │
   └── Also need editable PPTX (colleagues want to edit text) → Write HTML from line one under 4 hard constraints
                                                                  Run export_deck_pptx.mjs, one command
                                                                  Sacrifices gradients / web components / complex SVG
```

### Conversation Script (copy and use)

> Regardless of whether the final delivery is HTML, PDF, or PPTX, I will always start by building an HTML assembled version that can be navigated and presented in a browser (`index.html` with keyboard navigation) — that is always the default base deliverable. On top of that I will ask whether you also need a PDF / PPTX snapshot.
>
> Which export format do you need?
> - **HTML only** (presentation/archive) → visually completely free
> - **Also PDF** → same as above, plus one export command
> - **Also editable PPTX** (colleagues will edit text in PPT) → I must write from the first line of HTML under 4 hard constraints, which sacrifices some visual capability (no gradients, no web components, no complex SVG).

### Why "wanting PPTX means following 4 hard constraints from the start"

The precondition for an editable PPTX is that `html2pptx.js` can translate DOM elements one by one into PowerPoint objects. This requires **4 hard constraints**:

1. body fixed at 960pt × 540pt (matching `LAYOUT_WIDE`, 13.333″ × 7.5″ — not 1920×1080px)
2. All text wrapped in `<p>`/`<h1>`-`<h6>` (no bare text in divs, no `<span>` carrying primary text)
3. `<p>`/`<h*>` tags themselves cannot have background/border/shadow (put those on outer divs)
4. `<div>` cannot use `background-image` (use `<img>` tags)
5. No CSS gradients, no web components, no complex SVG decoration

**This skill's default HTML has high visual freedom** — heavy use of span, nested flex, complex SVG, web components (like `<deck-stage>`), CSS gradients — **almost none of it passes html2pptx constraints natively** (real-world test: visually-driven HTML passed directly through html2pptx had a pass rate < 30%).

### Cost comparison: two real paths (real incident, 2026-04-20)

| Path | Approach | Result | Cost |
|------|----------|--------|------|
| Write HTML freely first, patch PPTX afterwards | Single-file deck-stage + heavy SVG/span decoration | When editable PPTX is needed, only two options remain:<br>A. Handwrite pptxgenjs with hundreds of lines of hardcoded coordinates<br>B. Rewrite all 17 pages of HTML to Path A format | 2–3 hours of rework, and the handwritten version carries **ongoing maintenance debt** (change one word in HTML, PPTX must be manually synced again) |
| Write from step one under Path A constraints | Per-page independent HTML + 4 hard constraints + 960×540pt | One command exports 100% editable PPTX, and the HTML also plays full-screen in the browser (Path A HTML is standard browser-playable HTML) | Spend 5 extra minutes thinking "how do I wrap this text in `<p>`" when writing HTML — zero rework |

### Handling mixed delivery

User says "I want HTML presentation **and** editable PPTX" — **this is not mixed**, PPTX requirement covers HTML requirement. HTML written to Path A constraints can already play full-screen in the browser (just add a `deck_index.html` assembler). **No extra cost.**

User says "I want PPTX **and** animations / web components" — **this is a genuine conflict**. Tell the user: wanting editable PPTX means sacrificing those visual capabilities. Let them make the trade-off — don't quietly go down the handwritten pptxgenjs route (that becomes perpetual maintenance debt).

### What to do if PPTX is needed after the fact (emergency fallback)

Rare case: HTML is already written when PPTX requirement surfaces. Recommended **fallback flow** (full explanation in `references/editable-pptx.md` at the end under "Fallback: already have a visual comp but user insists on editable PPTX"):

1. **First preference: produce PDF** (100% visual fidelity, cross-platform, recipient can view and print) — if the recipient's actual need is "presentation/archive", PDF is the best deliverable
2. **Second preference: AI rewrites an editable HTML version using the visual comp as reference** → export editable PPTX — preserves design decisions on colour/layout/copy, sacrifices gradients, web components, complex SVG
3. **Not recommended: handwrite pptxgenjs to reconstruct** — positions, fonts, alignment all need manual tuning, high maintenance cost, and every subsequent HTML change requires another manual sync

Always give the user the options and let them decide. **Never make "start handwriting pptxgenjs" your first instinct** — that is the last-resort fallback.

---

## Build a 2-Page Showcase First to Lock the Grammar (Before Batch Production)

**For any deck of 5+ pages, never write from page 1 straight through to the end.** Correct order validated in the 2026-04-22 moxt brochure real-world build:

1. Pick **2 page types with the greatest visual contrast** and do the showcase first (e.g. "cover" + "mood/quote page", or "cover" + "product showcase page")
2. Screenshot and ask the user to confirm the grammar (masthead / fonts / colour / spacing / structure / bilingual proportion)
3. Once the direction is approved, batch out the remaining N-2 pages, each reusing the established grammar
4. When all pages are done, assemble the HTML collection + PDF / PPTX derivatives together

**Why**: Writing all 13 pages straight through → user says "direction is wrong" = 13 rewrites. Building 2-page showcase first → direction is wrong = 2 rewrites. Once visual grammar is established, the decision space for subsequent N pages shrinks dramatically — it becomes only "how to fit the content in".

**Showcase page selection principle**: pick the two pages with the most structurally different layouts. If those two pass, everything in between will pass.

| Deck type | Recommended showcase page pair |
|-----------|--------------------------------|
| B2B brochure / product launch | Cover + content page (concept/emotional page) |
| Brand launch | Cover + product feature page |
| Data report | Large data visual page + analysis conclusion page |
| Tutorial / courseware | Chapter cover page + specific knowledge point page |

---

## Publication Grammar Template (Validated on moxt, Reusable)

Suited for B2B brochures / product launches / long report decks. Reuse this structure on every page = 13 pages visually consistent, zero rework.

### Per-page skeleton

```
┌─ masthead (top strip + horizontal rule) ─────────────┐
│  [logo 22-28px] · A Product Brochure          Issue · Date · URL │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ── kicker (green rule + uppercase label)            │
│  CHAPTER XX · SECTION NAME                           │
│                                                      │
│  H1 (Noto Serif SC 900)                              │
│  Key words in brand primary colour                   │
│                                                      │
│  English subtitle (Lora italic, subheading)          │
│  ─────────────── separator ──────────────            │
│                                                      │
│  [Specific content: two-col 60/40 / 2×2 grid / list] │
│                                                      │
├──────────────────────────────────────────────────────┤
│ section name                              XX / total │
└──────────────────────────────────────────────────────┘
```

### Style conventions (copy directly)

- **H1**: Noto Serif SC 900, font size 80–140px depending on content volume, key words in brand primary colour only (don't colour the whole line)
- **English subtitle**: Lora italic 26–46px, brand signature words (e.g. "AI team") bold + primary colour italic
- **Body text**: Noto Serif SC 17–21px, line-height 1.75–1.85
- **Accent highlights**: use primary colour bold to mark key words in body text, max 3 per page (any more and they lose their anchoring function)
- **Background**: warm off-white #FAFAFA + very faint radial-gradient noise (`rgba(33,33,33,0.015)`) to add a paper feel

### Visual hero must vary

If all 13 pages are "text + one screenshot" it will be monotonous. **Rotate the type of visual hero each page**:

| Visual type | Suitable section |
|------------|-----------------|
| Cover typography (large type + masthead + pillar) | First page / chapter cover |
| Single-character portrait (oversized single momo etc.) | Introducing a single concept / character |
| Group photo / avatar card row | Team / user case studies |
| Timeline card progression | Showing "long-term relationship" or "evolution" |
| Knowledge graph / connection node diagram | Showing "collaboration" or "flow" |
| Before/After comparison cards + central arrow | Showing "change" or "difference" |
| Product UI screenshot + outlined device frame | Specific feature showcase |
| Large-quote big-quote (half-page large type) | Mood page / question page / quotation page |
| Real headshot + quote card (2×2 or 1×4) | User testimonials / usage scenarios |
| Large-type back cover + URL oval button | CTA / closing |

---

## Common Pitfalls (moxt Real-World Summary)

### 1. Emoji do not render in Chromium / Playwright exports

Chromium does not bundle a colour emoji font by default. `page.pdf()` or `page.screenshot()` renders emoji as empty boxes.

**Fix**: use Unicode text symbols (`✦` `✓` `✕` `→` `·` `—`) instead, or replace with plain text ("Email · 23" rather than "📧 23 emails").

### 2. `export_deck_pdf.mjs` errors with `Cannot find package 'playwright'`

Cause: ESM module resolution searches for `node_modules` upward from the script's location. The script lives at `~/.claude/skills/huashu-design/scripts/` where there are no dependencies.

**Fix**: copy the script to the deck project directory (e.g. `brochure/build-pdf.mjs`), run `npm install playwright pdf-lib` in the project root, then `node build-pdf.mjs --slides slides --out output/deck.pdf`.

### 3. Google Fonts not fully loaded before screenshot → Chinese text falls back to system default sans-serif

Add at least `wait-for-timeout=3500` before Playwright screenshot/PDF to allow webfont download and paint. Alternatively self-host fonts in `shared/fonts/` to reduce network dependency.

### 4. Information density imbalance: content pages overstuffed

The moxt philosophy page in its first version used 2×2 = 4 paragraphs + 3 bottom tenets = 7 blocks of content, cramped and repetitive. Switching to 1×3 = 3 paragraphs immediately restored breathing room.

**Fix**: keep each page to "1 core message + 3–4 supporting points + 1 visual hero". If it exceeds that, split to a new page. **Less is more** — audiences spend 10 seconds per page. Giving them 1 thing to remember is easier than giving them 4.

---

## Choose Architecture First: Single-File or Multi-File?

**This choice is the first step in making slides. Getting it wrong means repeated pitfalls. Read this section fully before starting.**

### Comparison of two architectures

| Dimension | Single-file + `deck_stage.js` | **Multi-file + `deck_index.html` assembler** |
|-----------|-------------------------------|----------------------------------------------|
| Code structure | One HTML, all slides are `<section>` elements | Each page is independent HTML, `index.html` assembles via iframe |
| CSS scope | Styles from one page can affect all pages | Naturally isolated, each iframe is its own world |
| Verification granularity | Need JS goTo to navigate to a specific page | Double-click a single-page file to view it in the browser |
| Parallel development | One file — multiple agents editing will conflict | Multiple agents can work on different pages simultaneously, zero-conflict merge |
| Debugging difficulty | One CSS error crashes the whole deck | One page error only affects itself |
| Embedded interaction | Cross-page shared state is easy | postMessage required between iframes |
| Print PDF | Built-in | Assembler iterates iframes before print |
| Keyboard navigation | Built-in | Built into the assembler |

### Which to choose? (Decision tree)

```
│ Question: how many pages is the deck expected to be?
├── ≤10 pages, needs in-deck animation or cross-page interaction, pitch deck → single-file
└── ≥10 pages, academic lecture, courseware, long deck, multi-agent parallel → multi-file (recommended)
```

**Default to multi-file**. It's not "the alternative" — it's the **main path for long decks and team collaboration**. Every advantage of single-file architecture (keyboard navigation, printing, scaling) is also available in multi-file, while multi-file's CSS scope isolation and individual verifiability cannot be recovered in single-file.

### Why is this rule so hard? (Real incident record)

Single-file architecture hit four cascading pitfalls during the AI Psychology Lecture deck production:

1. **CSS specificity override**: `.emotion-slide { display: grid }` (specificity 10) overrode `deck-stage > section { display: none }` (specificity 2), causing all pages to render stacked simultaneously.
2. **Shadow DOM slot rules suppressed by outer CSS**: `::slotted(section) { display: none }` couldn't hold against outer rule override, sections refused to hide.
3. **localStorage + hash navigation race condition**: after refresh, jumped to the position recorded in localStorage rather than the hash position.
4. **High validation cost**: had to `page.evaluate(d => d.goTo(n))` to screenshot a specific page, twice as slow as directly `goto(file://.../slides/05-X.html)` and frequently errored.

All root causes trace to **a single global namespace** — multi-file architecture eliminates all of these at the physical level.

---

## Path A (Default): Multi-File Architecture

### Directory structure

```
MyDeck/
├── index.html              # Copied from assets/deck_index.html, edit MANIFEST
├── shared/
│   ├── tokens.css          # Shared design tokens (colour palette / font scale / common chrome)
│   └── fonts.html          # <link> to Google Fonts (included by each page)
└── slides/
    ├── 01-cover.html       # Each file is a complete 1920×1080 HTML
    ├── 02-agenda.html
    ├── 03-problem.html
    └── ...
```

### Template skeleton for each slide

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>P05 · Chapter Title</title>
<link href="https://fonts.googleapis.com/css2?family=..." rel="stylesheet">
<link rel="stylesheet" href="../shared/tokens.css">
<style>
  /* Styles unique to this page. Any class name here won't pollute other pages. */
  body { padding: 120px; }
  .my-thing { ... }
</style>
</head>
<body>
  <!-- 1920×1080 content (width/height locked in tokens.css on body) -->
  <div class="page-header">...</div>
  <div>...</div>
  <div class="page-footer">...</div>
</body>
</html>
```

**Key constraints**:
- `<body>` is the canvas — lay out directly on it. Do not wrap in `<section>` or other wrappers.
- `width: 1920px; height: 1080px` is locked by the `body` rule in `shared/tokens.css`.
- Import `shared/tokens.css` for shared design tokens (colour palette, font scale, page-header/footer, etc.).
- Font `<link>` is written per page (importing fonts per page is cheap and ensures each page is independently openable).

### Assembler: `deck_index.html`

**Copy directly from `assets/deck_index.html`**. The only thing you need to change is the `window.DECK_MANIFEST` array — list all slide filenames and human-readable labels in order:

```js
window.DECK_MANIFEST = [
  { file: "slides/01-cover.html",    label: "Cover" },
  { file: "slides/02-agenda.html",   label: "Agenda" },
  { file: "slides/03-problem.html",  label: "Problem Statement" },
  // ...
];
```

The assembler has built-in: keyboard navigation (←/→/Home/End/number keys/P to print), scale + letterbox, bottom-right counter, localStorage memory, hash jump, print mode (iterates iframes for per-page PDF output).

### Per-page verification (killer advantage of multi-file architecture)

Each slide is an independent HTML file. **After finishing a page, double-click it in the browser to check**:

```bash
open slides/05-personas.html
```

Playwright screenshots also go directly to `goto(file://.../slides/05-personas.html)` — no JS navigation needed, no risk of another page's CSS interfering. This brings the cost of "change a little, verify a little" close to zero.

### Parallel development

Break each slide's task out to different agents running simultaneously — HTML files are independent of each other, no conflicts on merge. On long decks, this parallel approach can compress production time to 1/N.

### What belongs in `shared/tokens.css`

Only things **truly shared across pages**:

- CSS variables (colour palette, font scale, spacing scale)
- Canvas lock rules like `body { width: 1920px; height: 1080px; }`
- Chrome that every page uses identically, like `.page-header` / `.page-footer`

**Do not** put single-page layout classes in here — that degrades back to the global pollution problem of single-file architecture.

---

## Path B (Small Decks): Single-File + `deck_stage.js`

Suitable for decks of ≤10 pages, that need cross-page shared state (e.g. a React tweaks panel controlling all pages), or extremely compact pitch deck demos.

### Basic usage

1. Read `assets/deck_stage.js` content and embed in the HTML `<script>` (or `<script src="deck_stage.js">`)
2. Wrap slides in `<deck-stage>` in the body
3. **Script tag must come after `</deck-stage>`** (see hard constraint below)

```html
<body>

  <deck-stage>
    <section>
      <h1>Slide 1</h1>
    </section>
    <section>
      <h1>Slide 2</h1>
    </section>
  </deck-stage>

  <!-- Correct: script after deck-stage -->
  <script src="deck_stage.js"></script>

</body>
```

### Script placement hard constraint (real incident, 2026-04-20)

**Do not put `<script src="deck_stage.js">` in `<head>`.** Even though it can define `customElements` from `<head>`, the parser triggers `connectedCallback` when it reaches the `<deck-stage>` opening tag — at this point child `<section>` elements haven't been parsed yet, `_collectSlides()` gets an empty array, the counter shows `1 / 0`, and all pages render stacked simultaneously.

**Three compliant approaches** (pick any one):

```html
<!-- Most recommended: script after </deck-stage> -->
</deck-stage>
<script src="deck_stage.js"></script>

<!-- Also fine: script in head with defer -->
<head><script src="deck_stage.js" defer></script></head>

<!-- Also fine: module scripts are naturally deferred -->
<head><script src="deck_stage.js" type="module"></script></head>
```

`deck_stage.js` already has a `DOMContentLoaded` deferred collection defence built in, so placing the script in head won't completely blow up — but `defer` or placing it at the bottom of body is still a cleaner approach, avoiding reliance on the defensive fallback branch.

### CSS traps in single-file architecture (must read)

The most common pitfall in single-file architecture — **`display` property gets hijacked by per-page styles**.

Common mistake 1 (writing display: flex directly on section):

```css
/* Outer CSS specificity 2, overrides shadow DOM's ::slotted(section){display:none} (also 2) */
deck-stage > section {
  display: flex;            /* All pages will render stacked! */
  flex-direction: column;
  padding: 80px;
  ...
}
```

Common mistake 2 (section has a class with higher specificity):

```css
.emotion-slide { display: grid; }   /* specificity: 10, even worse */
```

Both will cause **all slides to render stacked simultaneously** — the counter may show `1 / 10` as if normal, but visually page one is buried under page two buried under page three.

### Starter CSS (copy at the start — no pitfalls)

**section itself** only controls "visible/not visible"; **layout (flex/grid etc.) goes on `.active`**:

```css
/* section only defines non-display generic styles */
deck-stage > section {
  background: var(--paper);
  padding: 80px 120px;
  overflow: hidden;
  position: relative;
  /* Do not write display here! */
}

/* Lock "inactive means hidden" — specificity + weight double insurance */
deck-stage > section:not(.active) {
  display: none !important;
}

/* Active page gets the display + layout it needs */
deck-stage > section.active {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* Print mode: all pages must show, overrides :not(.active) */
@media print {
  deck-stage > section { display: flex !important; }
  deck-stage > section:not(.active) { display: flex !important; }
}
```

Alternative: **write per-page flex/grid on an inner wrapper `<div>`**, so section itself is always just a display: block/none toggle. This is the cleanest approach:

```html
<deck-stage>
  <section>
    <div class="slide-content flex-layout">...</div>
  </section>
</deck-stage>
```

### Custom dimensions

```html
<deck-stage width="1080" height="1920">
  <!-- 9:16 portrait -->
</deck-stage>
```

---

## Slide Labels

Both deck_stage and deck_index label each page (shown in the counter). Give them **more meaningful** labels:

**Multi-file**: write `{ file, label: "04 Problem Statement" }` in the `MANIFEST`
**Single-file**: add `<section data-screen-label="04 Problem Statement">` on the section element

**Key point: slide numbers start at 1, not 0.**

When a user says "slide 5", they mean the 5th slide — never array position `[4]`. Humans don't use 0-indexed counting.

---

## Speaker Notes

**Off by default** — only add when the user explicitly requests them.

Adding speaker notes lets you reduce the text on slides to a minimum and focus on impactful visuals — the notes carry the full script.

### Format

**Multi-file**: write in `<head>` of `index.html`:

```html
<script type="application/json" id="speaker-notes">
[
  "Script for slide 1...",
  "Script for slide 2...",
  "..."
]
</script>
```

**Single-file**: same location.

### Notes writing guidelines

- **Complete**: not an outline — these are the actual words you will say
- **Conversational**: sounds like natural speech, not written prose
- **Aligned**: array element N corresponds to slide N
- **Length**: 200–400 words is ideal
- **Emotional arc**: mark emphasis, pauses, stress points

---

## Slide Design Patterns

### 1. Establish a system (required)

After exploring the design context, **verbally state the system you intend to use** first:

```markdown
Deck system:
- Background colours: max 2 (90% white + 10% dark section dividers)
- Typeface: display uses Instrument Serif, body uses Geist Sans
- Rhythm: section dividers use full-bleed colour + white text; regular slides use white background
- Images: hero slides use full-bleed photography, data slides use charts

I'll build to this system — tell me if you want changes.
```

Get user confirmation before proceeding.

### 2. Common slide layouts

- **Title slide**: solid background + oversized title + subtitle + author/date
- **Section divider**: coloured background + chapter number + chapter title
- **Content slide**: white background + title + 1–3 bullet points
- **Data slide**: title + large chart/number + brief caption
- **Image slide**: full-bleed photo + small caption at bottom
- **Quote slide**: lots of white space + oversized quote + attribution
- **Two-column**: left/right comparison (vs / before-after / problem-solution)

Use a maximum of 4–5 layouts within one deck.

### 3. Scale (emphasis)

- Body text minimum **24px**, ideally 28–36px
- Headings **60–120px**
- Hero type **180–240px**
- Slides are viewed from 10 metres away — type must be large enough

### 4. Visual rhythm

Decks need **intentional variety**:

- Colour rhythm: mostly white background + occasional coloured section dividers + occasional dark segments
- Density rhythm: a few text-heavy pages + a few image-heavy pages + a few quote/breathing-room pages
- Font size rhythm: normal headings + occasional giant hero text

**Don't make every slide look the same** — that's a PPT template, not design.

### 5. Breathing room (required reading for data-dense pages)

**The most common trap for beginners**: cramming every piece of available information onto one page.

Information density does not equal effective information delivery. Academic and lecture decks especially require restraint:

- List/matrix pages: don't draw all N elements at the same size. Use **primary/secondary hierarchy** — enlarge the 5 you're discussing today as the heroes, shrink the other 16 as background hints.
- Large number pages: the number itself is the visual hero. The surrounding caption should not exceed 3 lines — otherwise the audience's eyes keep jumping.
- Quote pages: leave whitespace between the quote and attribution — don't press them together.

Check yourself against "is the data the hero" and "is the text crowded together" — revise until the whitespace makes you slightly uneasy.

---

## Print to PDF

**Multi-file**: `deck_index.html` already handles the `beforeprint` event and outputs one page per PDF page.

**Single-file**: `deck_stage.js` handles the same.

Print styles are already written — no additional `@media print` CSS needed.

---

## Export to PPTX / PDF (Self-Service Scripts)

HTML-first is the primary deliverable. But users frequently need PPTX/PDF. Two general-purpose scripts are provided — **usable with any multi-file deck** — located under `scripts/`:

### `export_deck_pdf.mjs` — Export vector PDF (multi-file architecture)

```bash
node scripts/export_deck_pdf.mjs --slides <slides-dir> --out deck.pdf
```

**Features**:
- Text **remains vector** (copyable, searchable)
- 100% visual fidelity (Playwright's embedded Chromium renders then prints)
- **No changes to HTML required**
- Each slide gets its own `page.pdf()`, merged with `pdf-lib`

**Dependencies**: `npm install playwright pdf-lib`

**Limitation**: PDF text is not editable — changes go back to the HTML source.

### `export_deck_stage_pdf.mjs` — Single-file deck-stage architecture only

**When to use**: deck is a single HTML file with `<deck-stage>` web component wrapping N `<section>` elements (Path B architecture). The multi-page approach of `export_deck_pdf.mjs` ("one `page.pdf()` per HTML file") doesn't apply here — use this dedicated script instead.

```bash
node scripts/export_deck_stage_pdf.mjs --html deck.html --out deck.pdf
```

**Why `export_deck_pdf.mjs` cannot be reused** (real incident record, 2026-04-20):

1. **Shadow DOM wins over `!important`**: deck-stage's shadow CSS has `::slotted(section) { display: none }` (only the active slide gets `display: block`). Even using `@media print { deck-stage > section { display: block !important } }` in light DOM can't override it — after `page.pdf()` triggers print media, Chromium's final render only shows the active slide, resulting in **the entire PDF being 1 page** (the current active slide, repeated).

2. **Looping goto each page still only produces 1 page**: the intuitive fix of "navigate to `#slide-N` once then `page.pdf({pageRanges:'1'})`" also fails — because the print CSS outside shadow DOM has a `deck-stage > section { display: block }` rule that gets overridden, and the final render is always the first element in the section list (not the one you navigated to). Result: 17 iterations all produce P01 cover.

3. **Absolutely positioned children overflow to next page**: even if all sections render successfully, if section itself has `position: static`, its absolutely positioned `cover-footer`/`slide-footer` children position relative to the initial containing block — when section is forced to 1080px height for print, the absolute footer may get pushed to the next page (manifests as the PDF having one more page than the section count, with the extra page containing only the orphaned footer).

**Fix strategy** (already implemented in the script):

```js
// After opening the HTML, use page.evaluate to extract sections from the deck-stage slot,
// attach them directly to a regular div under body, and inline style to ensure position:relative + fixed dimensions
await page.evaluate(() => {
  const stage = document.querySelector('deck-stage');
  const sections = Array.from(stage.querySelectorAll(':scope > section'));
  document.head.appendChild(Object.assign(document.createElement('style'), {
    textContent: `
      @page { size: 1920px 1080px; margin: 0; }
      html, body { margin: 0 !important; padding: 0 !important; }
      deck-stage { display: none !important; }
    `,
  }));
  const container = document.createElement('div');
  sections.forEach(s => {
    s.style.cssText = 'width:1920px!important;height:1080px!important;display:block!important;position:relative!important;overflow:hidden!important;page-break-after:always!important;break-after:page!important;background:#F7F4EF;margin:0!important;padding:0!important;';
    container.appendChild(s);
  });
  // Disable page break on last page to avoid trailing blank page
  sections[sections.length - 1].style.pageBreakAfter = 'auto';
  sections[sections.length - 1].style.breakAfter = 'auto';
  document.body.appendChild(container);
});

await page.pdf({ width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true });
```

**Why this works**:
- Moving sections from shadow DOM slot to a regular div in light DOM — completely bypasses the `::slotted(section) { display: none }` rule
- Inlining `position: relative` makes absolutely positioned children position relative to section, preventing overflow
- `page-break-after: always` tells the browser to put each section on its own page in print mode
- No page break on the last child prevents a trailing blank page

**Note when verifying with `mdls -name kMDItemNumberOfPages`**: macOS Spotlight metadata has a cache. After overwriting a PDF, run `mdimport file.pdf` to force a refresh — otherwise it shows the old page count. Use `pdfinfo` or `pdftoppm` to count pages accurately.

---

### `export_deck_pptx.mjs` — Export editable PPTX

```bash
# Only mode: text boxes natively editable (fonts fall back to system fonts)
node scripts/export_deck_pptx.mjs --slides <dir> --out deck.pptx
```

How it works: `html2pptx` reads computedStyle element by element and translates the DOM into PowerPoint objects (text frame / shape / picture). Text becomes real text boxes — double-click to edit directly in PPT.

**Hard constraints** (HTML must satisfy these, otherwise the page is skipped — full explanation in `references/editable-pptx.md`):
- All text must be in `<p>`/`<h1>`-`<h6>`/`<ul>`/`<ol>` (no bare text in divs)
- `<p>`/`<h*>` tags themselves cannot have background/border/shadow (put those on outer divs)
- Do not use `::before`/`::after` to insert decorative text (pseudo-elements can't be extracted)
- Inline elements (span/em/strong) cannot have margin
- No CSS gradients (cannot be rendered)
- No `background-image` on divs (use `<img>`)

The script already has a **built-in auto-preprocessor** that wraps "bare text inside leaf divs" into `<p>` automatically (preserving the class). This solves the most common violation (bare text). But other violations (border on p, margin on span, etc.) still require compliant HTML at the source.

**Font fallback caveat**:
- Playwright uses webfonts to measure text-box dimensions; PowerPoint/Keynote renders with local fonts
- When the two differ there will be **overflow or misalignment** — check every page visually
- Recommended: have the target machine install the fonts used in the HTML, or fall back to `system-ui`

**Don't use this path for visually-driven work** → use `export_deck_pdf.mjs` for PDF instead. PDF is 100% visually faithful, vector, cross-platform, text searchable — it's the true destination for visually-driven decks, not "a compromise because text isn't editable".

### Make HTML export-friendly from the start

For the most stable deck performance: **write HTML from the beginning following the 4 editable hard constraints**. This way `export_deck_pptx.mjs` will pass all pages directly. The extra cost is small:

```html
<!-- Bad -->
<div class="title">Key Finding</div>

<!-- Good (p wraps, class is preserved) -->
<p class="title">Key Finding</p>

<!-- Bad (border on p) -->
<p class="stat" style="border-left: 3px solid red;">41%</p>

<!-- Good (border on outer div) -->
<div class="stat-wrap" style="border-left: 3px solid red;">
  <p class="stat">41%</p>
</div>
```

### When to choose which

| Scenario | Recommended |
|----------|-------------|
| Delivering to organisers / archiving | **PDF** (universal, high fidelity, text searchable) |
| Sending to collaborators who need to tweak text | **PPTX editable** (accept font fallback) |
| Live presentation, no content changes | **PDF** (vector fidelity, cross-platform) |
| HTML is the primary presentation medium | Play directly in browser, export only as backup |

## Deep Export-to-Editable-PPTX Path (Long-term projects only)

If your deck will be maintained long-term, revised repeatedly, and worked on by a team — it is worth **writing HTML from the start following html2pptx constraints**, so that `export_deck_pptx.mjs` can pass all pages directly. See `references/editable-pptx.md` for the full details (4 hard constraints + HTML template + common error quick-reference + fallback flow for when you already have a visual comp).

---

## FAQ

**Multi-file: iframe page doesn't open / blank white screen**
→ Check that the `file` path in `MANIFEST` is correct relative to `index.html`. Use browser DevTools to verify the iframe `src` is directly accessible.

**Multi-file: one page's styles seem to conflict with another page**
→ Impossible (iframe isolation). If it looks like a conflict, it's a cache issue — Cmd+Shift+R to hard refresh.

**Single-file: multiple slides rendering stacked**
→ CSS specificity issue. See the "CSS traps in single-file architecture" section above.

**Single-file: scaling looks wrong**
→ Check that all slides are direct `<section>` children of `<deck-stage>`. No intermediate `<div>` wrapper is allowed.

**Single-file: want to jump to a specific slide**
→ Add a hash to the URL: `index.html#slide-5` jumps to the 5th slide.

**Both architectures: text positioning inconsistent across screens**
→ Use fixed dimensions (1920×1080) and `px` units. Do not use `vw`/`vh` or `%`. Scaling is handled uniformly.

---

## Verification Checklist (Required Before Calling a Deck Done)

1. [ ] Open `index.html` (or main HTML) directly in the browser — check first page has no broken images and fonts have loaded
2. [ ] Press → to navigate through every page — no blank pages, no layout breaks
3. [ ] Press P for print preview — each page is exactly one A4 (or 1920×1080) with no clipping
4. [ ] Randomly pick 3 pages, Cmd+Shift+R hard refresh — localStorage memory works correctly
5. [ ] Playwright batch screenshot (multi-file: iterate `slides/*.html`; single-file: use goTo to switch) — visual review of every page
6. [ ] Search for residual `TODO` / `placeholder` — confirm all are cleaned up
