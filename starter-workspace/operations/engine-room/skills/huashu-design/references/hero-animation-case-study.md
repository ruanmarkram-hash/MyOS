# Gallery Ripple + Multi-Focus · Scene Choreography Philosophy

> A **reusable visual choreography structure** distilled from the huashu-design hero animation v9 (25 seconds, 8 scenes).
> This is not an animation production pipeline — it is about **when this choreography is the "right" choice for a given scene**.
> Practical reference: [demos/hero-animation-v9.mp4](../demos/hero-animation-v9.mp4) · [https://www.huasheng.ai/huashu-design-hero/](https://www.huasheng.ai/huashu-design-hero/)

## One-Line Summary

> **When you have 20+ visually homogeneous assets and the scene needs to "express scale and depth", reach for Gallery Ripple + Multi-Focus instead of piling on typography.**

General SaaS feature animations, product launches, skill promotions, and series portfolio showcases — as long as asset count is sufficient and the style is consistent, this structure nearly always delivers.

---

## What This Technique Actually Communicates

Not "showing off assets" — it tells a narrative through **two rhythm changes**:

**First beat · Ripple expand (~1.5s)**: 48 cards spread outward from the center; the audience is hit by the sheer **volume** — "Oh, this thing has produced this much."

**Second beat · Multi-Focus (~8s, 4 cycles)**: While the camera slowly pans, it dims + desaturates the background 4 times to isolate a single card and enlarge it to the center of the screen — the audience switches from "impact of quantity" to "quality contemplation," each cycle running at a steady 1.7s rhythm.

**Core narrative structure**: **Scale (Ripple) → Focus (Focus x 4) → Fade (Walloff)**. These three beats together express "Breadth x Depth" — not just the ability to produce a lot, but that each individual piece is worth stopping to examine.

Contrast with the anti-examples:

| Approach | Audience perception |
|------|---------|
| 48 cards in a static grid (no Ripple) | Beautiful but no narrative — feels like a grid screenshot |
| Fast cuts card by card (no Gallery context) | Feels like a slideshow; loses the sense of scale |
| Ripple only, no Focus | Impressed by volume but doesn't remember any individual card |
| **Ripple + Focus x 4 (this recipe)** | **Overwhelmed by quantity, then absorbed in quality, then calmly fades out — a complete emotional arc** |

---

## Prerequisites (All Four Must Be Met)

This choreography **is not a universal solution**. All 4 conditions below are required:

1. **Asset count >= 20, ideally 30+**
   Fewer than 20 makes the Ripple feel "sparse" — density only works when every one of the 48 slots is in motion. v9 used 48 slots x 32 images (looped to fill).

2. **Consistent visual style across assets**
   All 16:9 slide previews / all app screenshots / all cover designs — the aspect ratio, color tone, and layout must look like "a set." Mixing styles makes the Gallery look like a clipboard.

3. **Assets are still readable when enlarged individually**
   Focus enlarges a selected card to 960px wide. If the original image is blurry at that size or informationally thin, the Focus beat fails. Reverse test: can you pick 4 cards from the 48 as "most representative"? If you can't, the asset quality is uneven.

4. **Scene is landscape or square, not portrait**
   The Gallery's 3D tilt (`rotateX(14deg) rotateY(-10deg)`) requires horizontal extension; portrait orientation makes the tilt look narrow and awkward.

**Fallback paths when prerequisites are missing**:

| Missing what | Degrade to |
|-------|-----------|
| Asset count < 20 | "3-5 side-by-side static display + individual focus" |
| Inconsistent style | "Cover + 3 chapter hero images" keynote-style |
| Informationally thin assets | "Data-driven dashboard" or "key quote + large type" |
| Portrait scene | "Vertical scroll + sticky cards" |

---

## Technical Recipe (v9 Live Parameters)

### 4-Layer Structure

```
viewport (1920x1080, perspective: 2400px)
  └─ canvas (4320x2520, oversized overflow) → 3D tilt + pan
      └─ 8x6 grid = 48 cards (gap 40px, padding 60px)
          └─ img (16:9, border-radius 9px)
      └─ focus-overlay (absolute center, z-index 40)
          └─ img (matches selected slide)
```

**Key**: canvas is 2.25x larger than the viewport, which gives the pan that "peering into a larger world" quality.

### Ripple Expand (Distance-Delay Algorithm)

```js
// Each card's entry time = distance from center x 0.8s delay
const col = i % 8, row = Math.floor(i / 8);
const dc = col - 3.5, dr = row - 2.5;       // offset to center
const dist = Math.hypot(dc, dr);
const maxDist = Math.hypot(3.5, 2.5);
const delay = (dist / maxDist) * 0.8;       // 0 → 0.8s
const localT = Math.max(0, (t - rippleStart - delay) / 0.7);
const opacity = expoOut(Math.min(1, localT));
```

**Core parameters**:
- Total duration 1.7s (`T.s3_ripple: [8.3, 10.0]`)
- Maximum delay 0.8s (center exits first, corners last)
- Each card entry duration 0.7s
- Easing: `expoOut` (explosive — not smooth)

**Happening simultaneously**: canvas scale 1.25 → 0.94 (zoom out to reveal) — a synchronized pull-back that accompanies the appearance.

### Multi-Focus (4 Rhythm Cycles)

```js
T.focuses = [
  { start: 11.0, end: 12.7, idx: 2  },  // 1.7s
  { start: 13.3, end: 15.0, idx: 3  },  // 1.7s
  { start: 15.6, end: 17.3, idx: 10 },  // 1.7s
  { start: 17.9, end: 19.6, idx: 16 },  // 1.7s
];
```

**Rhythm pattern**: each focus 1.7s, 0.6s breathing gap between. Total 8s (11.0–19.6s).

**Inside each focus**:
- In ramp: 0.4s (`expoOut`)
- Hold: middle 0.9s (`focusIntensity = 1`)
- Out ramp: 0.4s (`easeOut`)

**Background changes (this is the key)**:

```js
if (focusIntensity > 0) {
  const dimOp = entryOp * (1 - 0.6 * focusIntensity);  // dim to 40%
  const brt = 1 - 0.32 * focusIntensity;                // brightness 68%
  const sat = 1 - 0.35 * focusIntensity;                // saturate 65%
  card.style.filter = `brightness(${brt}) saturate(${sat})`;
}
```

**Not just opacity — simultaneously desaturate + darken**. This makes the foreground overlay's color "pop out" rather than just "get a bit brighter."

**Focus overlay size animation**:
- From 400x225 (entry) → 960x540 (hold state)
- Outer ring has 3 shadow layers + 3px accent color outline ring, producing a "framed" feel

### Pan (Keeps Static Moments from Getting Boring)

```js
const panT = Math.max(0, t - 8.6);
const panX = Math.sin(panT * 0.12) * 220 - panT * 8;
const panY = Math.cos(panT * 0.09) * 120 - panT * 5;
```

- Sine wave + linear drift as dual motion layers — not a pure loop; every moment has a unique position
- Different X/Y frequencies (0.12 vs 0.09) prevent the audience from perceiving a "regular cycle"
- Clamped within ±900/500px to prevent drifting out of bounds

**Why not pure linear pan**: pure linear motion lets the audience "predict" the next second; sine + drift makes every second feel new, and the 3D tilt creates a mild "slight sea-sway" (the good kind) that holds attention.

---

## 5 Reusable Patterns (Distilled from v6 → v9 Iterations)

### 1. **expoOut as the primary easing, not cubicOut**

`easeOut = 1 - (1-t)³` (smooth) vs `expoOut = 1 - 2^(-10t)` (explosive then rapid convergence).

**Why**: expoOut reaches 90% very quickly in the first 30%, more like physical damping — it fits the intuition of "a heavy object landing." Particularly suited for:
- Card entry (sense of weight)
- Ripple expansion (shockwave)
- Brand float-in (settling sensation)

**When to still use cubicOut**: focus out ramp, symmetric micro-animations.

### 2. **Paper-tone background + terracotta accent (Anthropic lineage)**

```css
--bg: #F7F4EE;        /* warm paper */
--ink: #1D1D1F;       /* near-black */
--accent: #D97757;    /* terracotta orange */
--hairline: #E4DED2;  /* warm rule line */
```

**Why**: Warm background retains a "breathing quality" after GIF compression, unlike pure white which reads as "screen glare." Terracotta as the sole accent runs through the terminal prompt, selected dir-card, cursor, brand hyphen, and focus ring — all visual anchor points are threaded by this single color.

**v5 lesson**: added a noise overlay to simulate "paper grain"; the GIF frame compression destroyed it (every frame was different). v6 switched to "background color + warm shadow only"; paper feel retained at 90%, GIF file size reduced by 60%.

### 3. **Two-tier shadow to simulate depth, no real 3D**

```css
.gallery-card.depth-near { box-shadow: 0 32px 80px -22px rgba(60,40,20,0.22), ... }
.gallery-card.depth-far  { box-shadow: 0 14px 40px -16px rgba(60,40,20,0.10), ... }
```

Using `sin(i x 1.7) + cos(i x 0.73)` as a deterministic algorithm to assign near/mid/far shadow tiers to each card — **visually produces a "three-dimensional stacked" feel, but every frame's transform is unchanged; zero GPU cost**.

**Cost of real 3D**: each card individually `translateZ`, GPU recalculates 48 transforms + shadow blur every frame. v4 tried it; Playwright struggled to record at 25fps. v6's two-tier shadow looks less than 5% different to the naked eye, but costs 10x less.

### 4. **Font weight variation (font-variation-settings) is more cinematic than font size variation**

```js
const wght = 100 + (700 - 100) * morphP;  // 100 → 700 over 0.9s
wordmark.style.fontVariationSettings = `"wght" ${wght.toFixed(0)}`;
```

Brand wordmark morphs from Thin → Bold over 0.9s, paired with subtle letter-spacing adjustment (-0.045 → -0.048em).

**Why it beats scaling**:
- Scaling is something audiences have seen too many times; expectations are fixed
- Weight change is "inner fullness" — like a balloon being inflated — rather than "being pushed closer"
- Variable fonts are a post-2020 mainstream feature; audiences subconsciously register "modern"

**Limitation**: requires a variable font (Inter/Roboto Flex/Recursive, etc.). Static fonts can only simulate this (switching between a few fixed weights produces visible jumps).

### 5. **Corner Brand as a low-intensity persistent signature**

During the Gallery phase, the top-left corner displays a small `HUASHU · DESIGN` mark at 16% opacity, 12px font size, and wide letter spacing.

**Why it's there**:
- After the Ripple explosion, audiences easily "lose focus" and forget what they're watching; the corner mark helps anchor them
- More sophisticated than a full-screen large logo — people who work in branding know the brand signature doesn't need to shout
- Still leaves an attribution signal when the GIF is screenshotted and shared

**Rule**: only visible during the middle section (when the frame is busy); hidden at the opening (don't obscure the terminal) and at the end (brand reveal is the main event).

---

## Anti-Examples: When Not to Use This Choreography

**❌ Product demos (for showing features)**: Gallery makes every card flash past; the audience retains no specific feature. Use "single-screen focus + tooltip annotations" instead.

**❌ Data-driven content**: the audience needs to read numbers; the Gallery's fast pace doesn't allow time to read. Use "data charts + item-by-item reveal" instead.

**❌ Story narrative**: Gallery is a "parallel" structure; stories require "cause and effect." Use keynote chapter transitions instead.

**❌ Only 3-5 assets**: Ripple density is insufficient; looks like "patching." Use "static arrangement + one-at-a-time highlight" instead.

**❌ Portrait (9:16)**: 3D tilt requires horizontal extension; portrait makes the tilt feel "skewed" rather than "spread open."

---

## How to Decide If Your Task Fits This Choreography

Three-step quick check:

**Step 1 · Asset count**: count how many visually homogeneous assets you have. < 15 → stop; 15-25 → stretch; 25+ → go straight to it.

**Step 2 · Consistency test**: lay 4 random assets side by side — do they look like "a set"? If not → unify the style first, or change approach.

**Step 3 · Narrative match**: are you trying to express "Breadth x Depth" (quantity x quality)? Or is it "process," "feature," "story"? If not the former, don't force it.

All three are yes: fork the v6 HTML directly, change the `SLIDE_FILES` array and timeline to reuse it. Change the palette via `--bg / --accent / --ink` to re-skin without changing the bones.

---

## Related References

- Full technical process: [references/animations.md](animations.md) · [references/animation-best-practices.md](animation-best-practices.md)
- Animation export pipeline: [references/video-export.md](video-export.md)
- Audio configuration (BGM + SFX dual track): [references/audio-design-rules.md](audio-design-rules.md)
- Apple gallery-style lateral reference: [references/apple-gallery-showcase.md](apple-gallery-showcase.md)
- Source HTML (v6 + audio integration): `www.huasheng.ai/huashu-design-hero/index.html`
