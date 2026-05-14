# Editable PPTX Export: HTML Hard Constraints + Sizing Decisions + Common Errors

This document covers the path of **using `scripts/html2pptx.js` + `pptxgenjs` to translate HTML element-by-element into truly editable PowerPoint text boxes**, which is the only path supported by `export_deck_pptx.mjs`.

> **Core prerequisite**: To follow this path, the HTML must be written from line one according to the 4 constraints below. **Not written first and then converted** — retrofitting will trigger 2-3 hours of rework (confirmed in the 2026-04-20 options board project).
>
> For scenarios where visual fidelity takes priority (animations / web components / CSS gradients / complex SVG), switch to the PDF path (`export_deck_pdf.mjs` / `export_deck_stage_pdf.mjs`). **Do not** expect the PPTX export to deliver both visual fidelity and editability — this is a physical constraint of the PPTX file format itself (see "Why the 4 constraints are not bugs but physical constraints" at the end).

---

## Canvas Size: Use 960x540pt (LAYOUT_WIDE)

PPTX units are **inches** (physical dimensions), not px. Decision principle: the body's computedStyle dimensions must **match the presentation layout's inch dimensions** (±0.1", enforced by `html2pptx.js`'s `validateDimensions`).

### Comparison of 3 candidate sizes

| HTML body | Physical size | Corresponding PPT layout | When to choose |
|---|---|---|---|
| **`960pt x 540pt`** | **13.333" x 7.5"** | **pptxgenjs `LAYOUT_WIDE`** | ✅ **Default recommendation** (modern PowerPoint 16:9 standard) |
| `720pt x 405pt` | 10" x 5.625" | Custom | Only when the user specifies a "legacy PowerPoint Widescreen" template |
| `1920px x 1080px` | 20" x 11.25" | Custom | ❌ Non-standard size; fonts appear abnormally small when projected |

**Do not think of HTML dimensions as resolution.** PPTX is a vector document; body dimensions determine **physical size**, not clarity. An oversized body (20"x11.25") will not make text crisper — it just makes the pt font size smaller relative to the canvas, which looks worse when projected or printed.

### Three equivalent body declarations (pick one)

```css
body { width: 960pt;  height: 540pt; }    /* Clearest — recommended */
body { width: 1280px; height: 720px; }    /* Equivalent, px convention */
body { width: 13.333in; height: 7.5in; }  /* Equivalent, inch intuition */
```

Matching pptxgenjs code:

```js
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';  // 13.333 x 7.5 inch, no custom definition needed
```

---

## 4 Hard Constraints (violations will throw errors directly)

`html2pptx.js` translates the HTML DOM element-by-element into PowerPoint objects. PowerPoint's format constraints projected onto HTML = the 4 rules below.

### Rule 1: Text inside a DIV must be wrapped in `<p>` or `<h1>`-`<h6>`

```html
<!-- ❌ Wrong: text directly inside div -->
<div class="title">Q3 Revenue Up 23%</div>

<!-- ✅ Correct: text inside <p> or <h1>-<h6> -->
<div class="title"><h1>Q3 Revenue Up 23%</h1></div>
<div class="body"><p>New users are the primary driver</p></div>
```

**Why**: PowerPoint text must live inside a text frame, and text frames correspond to HTML paragraph-level elements (p/h*/li). A bare `<div>` has no corresponding text container in PPTX.

**`<span>` cannot carry the main text either** — span is an inline element and cannot independently align into a text box. Spans can only be **nested inside p/h\*** for local styling (bold, color change).

### Rule 2: CSS gradients are not supported — use solid colors only

```css
/* ❌ Wrong */
background: linear-gradient(to right, #FF6B6B, #4ECDC4);

/* ✅ Correct: solid color */
background: #FF6B6B;

/* ✅ If multi-color stripes are required, use flex children each with a solid color */
.stripe-bar { display: flex; }
.stripe-bar div { flex: 1; }
.red   { background: #FF6B6B; }
.teal  { background: #4ECDC4; }
```

**Why**: PowerPoint shape fill supports only solid/gradient-fill, but pptxgenjs's `fill: { color: ... }` only maps to solid. Applying PowerPoint's native gradient requires a different structure that the current toolchain does not support.

### Rule 3: Background/border/shadow can only be on DIVs, not on text tags

```html
<!-- ❌ Wrong: <p> has a background color -->
<p style="background: #FFD700; border-radius: 4px;">Key content</p>

<!-- ✅ Correct: outer div carries the background/border; <p> handles text only -->
<div style="background: #FFD700; border-radius: 4px; padding: 8pt 12pt;">
  <p>Key content</p>
</div>
```

**Why**: In PowerPoint, a shape (rectangle/rounded rectangle) and a text frame are two separate objects. HTML's `<p>` only translates into a text frame; background/border/shadow belong to the shape and must be written on the **div wrapping the text**.

### Rule 4: DIVs cannot use `background-image` — use `<img>` tags

```html
<!-- ❌ Wrong -->
<div style="background-image: url('chart.png')"></div>

<!-- ✅ Correct -->
<img src="chart.png" style="position: absolute; left: 50%; top: 20%; width: 300pt; height: 200pt;" />
```

**Why**: `html2pptx.js` only extracts image paths from `<img>` elements; it does not parse CSS `background-image` URLs.

---

## Path A HTML Template Skeleton

Each slide is a separate HTML file with isolated scope (avoids CSS pollution from a single-file deck).

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 960pt; height: 540pt;           /* ⚠️ Must match LAYOUT_WIDE */
    font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
    background: #FEFEF9;                    /* Solid color — no gradients */
    overflow: hidden;
  }
  /* DIV handles layout/background/border */
  .card {
    position: absolute;
    background: #1A4A8A;                    /* Background on the DIV */
    border-radius: 4pt;
    padding: 12pt 16pt;
  }
  /* Text tags handle font styles only — no background/border */
  .card h2 { font-size: 24pt; color: #FFFFFF; font-weight: 700; }
  .card p  { font-size: 14pt; color: rgba(255,255,255,0.85); }
</style>
</head>
<body>

  <!-- Title area: outer div for positioning, inner text tags -->
  <div style="position: absolute; top: 40pt; left: 60pt; right: 60pt;">
    <h1 style="font-size: 36pt; color: #1A1A1A; font-weight: 700;">Use an assertion sentence for the title, not a topic keyword</h1>
    <p style="font-size: 16pt; color: #555555; margin-top: 10pt;">Subtitle provides supplementary detail</p>
  </div>

  <!-- Content card: div for background, h2/p for text -->
  <div class="card" style="top: 130pt; left: 60pt; width: 240pt; height: 160pt;">
    <h2>Key Point One</h2>
    <p>Brief explanatory text</p>
  </div>

  <!-- List: use ul/li, not manual bullet symbols -->
  <div style="position: absolute; top: 320pt; left: 60pt; width: 540pt;">
    <ul style="font-size: 16pt; color: #1A1A1A; padding-left: 24pt; list-style: disc;">
      <li>First bullet point</li>
      <li>Second bullet point</li>
      <li>Third bullet point</li>
    </ul>
  </div>

  <!-- Image: use <img> tag, not background-image -->
  <img src="illustration.png" style="position: absolute; right: 60pt; top: 110pt; width: 320pt; height: 240pt;" />

</body>
</html>
```

---

## Common Error Quick Reference

| Error message | Cause | Fix |
|---------|------|---------|
| `DIV element contains unwrapped text "XXX"` | Bare text inside a div | Wrap the text in `<p>` or `<h1>`-`<h6>` |
| `CSS gradients are not supported` | Used linear/radial-gradient | Switch to solid color, or use flex children for segments |
| `Text element <p> has background` | `<p>` tag has a background color | Wrap in `<div>` for background; `<p>` handles text only |
| `Background images on DIV elements are not supported` | div uses background-image | Switch to `<img>` tag |
| `HTML content overflows body by Xpt vertically` | Content exceeds 540pt | Reduce content or shrink font size, or use `overflow: hidden` to clip |
| `HTML dimensions don't match presentation layout` | body dimensions do not match the presentation layout | Use `960pt x 540pt` body with `LAYOUT_WIDE`; or use defineLayout for a custom size |
| `Text box "XXX" ends too close to bottom edge` | Large-font `<p>` is less than 0.5 inch from the body bottom edge | Move it up; leave adequate bottom margin — the bottom of a PPT slide is partly obscured anyway |

---

## Basic Workflow (3 steps to PPTX)

### Step 1: Write each page as a standalone HTML file following the constraints

```
MyDeck/
├── slides/
│   ├── 01-cover.html    # Each file is a complete 960x540pt HTML document
│   ├── 02-agenda.html
│   └── ...
└── illustration/        # All images referenced by <img> tags
    ├── chart1.png
    └── ...
```

### Step 2: Write build.js to call `html2pptx.js`

```js
const pptxgen = require('pptxgenjs');
const html2pptx = require('../scripts/html2pptx.js');  // This skill's script

(async () => {
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_WIDE';  // 13.333 x 7.5 inch, matches HTML's 960x540pt

  const slides = ['01-cover.html', '02-agenda.html', '03-content.html'];
  for (const file of slides) {
    await html2pptx(`./slides/${file}`, pres);
  }

  await pres.writeFile({ fileName: 'deck.pptx' });
})();
```

### Step 3: Open and verify

- Open the exported PPTX in PowerPoint/Keynote
- Double-clicking any text should allow direct editing (if it opens as an image, Rule 1 was violated)
- Verify overflow: each page should fit within the body bounds with no clipping

---

## This Path vs Other Options (when to choose what)

| Requirement | Choose |
|------|------|
| Colleagues will edit text in the PPTX / sending to non-technical people for further editing | **This path** (editable — HTML must be written from scratch following the 4 constraints) |
| Presentation only / archival, no further edits needed | `export_deck_pdf.mjs` (multi-file) or `export_deck_stage_pdf.mjs` (single-file deck-stage) — produces vector PDF |
| Visual fidelity is the priority (animations, web components, CSS gradients, complex SVG) and non-editability is acceptable | **PDF** (same as above) — PDF is both faithful and cross-platform, more appropriate than "image PPTX" |

**Never run html2pptx on visually free-form HTML and expect it to pass** — testing shows that visually-driven HTML has a pass rate of less than 30%; the remaining per-page rework is slower than rewriting from scratch. These cases should produce PDF, not forced PPTX.

---

## Fallback: Existing Visual Draft but User Insists on Editable PPTX

This scenario comes up occasionally: you or the user has already written a visually-driven HTML (gradients, web components, complex SVG all used), PDF would be the right output, but the user explicitly says "no, it must be editable PPTX".

**Do not run `html2pptx` and hope it passes** — visually-driven HTML has a pass rate under 30% on html2pptx; the other 70% will error out or look wrong. The correct fallback is:

### Step 1 · Communicate the limitations upfront (transparent communication)

In one sentence, make three things clear to the user:

> "Your current HTML uses [list specifically: gradients / web components / complex SVG / ...], so a direct conversion to editable PPTX will fail. I have two options:
> - A. **Export as PDF** (recommended) — 100% visual fidelity preserved; recipients can view and print but cannot edit text
> - B. **Rewrite a version based on your visual draft** (preserving the design decisions for color/layout/copy, but restructuring the HTML to comply with the 4 hard constraints — **sacrificing** gradients, web components, complex SVG and similar visual capabilities) → then export as editable PPTX
>
> Which do you prefer?"

Do not downplay option B — be clear about **what will be lost**. Let the user make the trade-off.

### Step 2 · If the user chooses B: rewrite it yourself, do not ask the user to rewrite it

The doctrine here is: **the user provides design intent; you are responsible for translating it into a compliant implementation**. You are not asking the user to learn the 4 hard constraints and rewrite it themselves.

Principles for the rewrite:
- **Preserve**: color system (primary/secondary/neutral), information hierarchy (title/subtitle/body/annotation), core copy, layout skeleton (top-middle-bottom / left-right columns / grid), page rhythm
- **Downgrade**: CSS gradients → solid color or flex segments; web components → paragraph-level HTML; complex SVG → simplified `<img>` or solid-color geometry; shadows → remove or reduce to very subtle; custom fonts → approximate with system fonts
- **Rewrite**: bare text → wrap in `<p>` / `<h*>`; `background-image` → `<img>` tag; background/border on `<p>` → move to outer div

### Step 3 · Produce a comparison checklist (transparent delivery)

After the rewrite, give the user a before/after comparison so they know which visual details were simplified:

```
Original design → editable version adjustments
- Header area purple gradient → primary color #5B3DE8 solid background
- Data card shadows → removed (replaced with 2pt stroke for separation)
- Complex SVG line chart → simplified to <img> PNG (screenshot from HTML)
- Hero web component animation → static first frame (web components cannot be translated)
```

### Step 4 · Export & dual-format delivery

- `editable` HTML → run `scripts/export_deck_pptx.mjs` to produce editable PPTX
- **Recommended: also keep** the original visual draft → run `scripts/export_deck_pdf.mjs` to produce high-fidelity PDF
- Deliver both formats to the user: the visual PDF + the editable PPTX, each serving its purpose

### When to refuse option B outright

In some cases the rewrite cost is too high; advise the user to abandon editable PPTX:
- The HTML's core value is animation or interactivity (after rewriting only a static first frame remains, losing 50%+ of the information)
- Page count > 30, rewrite cost exceeds 2 hours
- Visual design depends heavily on precise SVG / custom filters (the rewrite bears almost no resemblance to the original)

In these cases, tell the user: "The rewrite cost for this deck is too high — recommend exporting as PDF instead of PPTX. If the recipient specifically needs .pptx format, accept that the visuals will be significantly plainer — would you like to switch to PDF?"

---

## Why the 4 Constraints Are Not Bugs but Physical Constraints

These 4 constraints are not the `html2pptx.js` author being lazy — they are the result of **PowerPoint's file format (OOXML) constraints** projected onto HTML:

- Text in PPTX must be inside a text frame (`<a:txBody>`), which corresponds to paragraph-level HTML elements
- In PPTX, a shape and a text frame are two separate objects; you cannot simultaneously draw a background and write text on the same element
- PPTX shape fill has limited gradient support (only certain preset gradients; arbitrary CSS angle gradients are not supported)
- PPTX picture objects must reference real image files, not CSS properties

Once you understand this, **do not expect the tooling to become smarter** — it is the HTML authoring that must adapt to the PPTX format, not the other way around.
