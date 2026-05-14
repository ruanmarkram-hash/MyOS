# Apple Gallery Showcase · Gallery Wall Animation Style

> Inspiration: Claude Design official hero video + Apple product page "portfolio wall" display
> Source: huashu-design launch hero v5
> Use cases: **product launch hero animations, skill capability demos, portfolio showcases** — any scenario requiring simultaneous display of multiple high-quality outputs while guiding audience attention

---

## Trigger Assessment: When to Use This Style

**Good fit**:
- Have 10+ real outputs to display on screen simultaneously (PPT, App, web, infographic)
- Audience is professional (developers, designers, product managers) — sensitive to "quality feel"
- Desired character is "restrained, exhibition-style, high-end, spatial"
- Need both close detail and overall context simultaneously

**Not a good fit**:
- Single-product focus (use frontend-design product hero template)
- Emotion-driven / strong narrative animations (use timeline storytelling template)
- Small screens / vertical orientation (perspective tilt gets muddy at small sizes)

---

## Core Visual Tokens

```css
:root {
  /* Light gallery palette */
  --bg:         #F5F5F7;   /* main canvas — Apple website gray */
  --bg-warm:    #FAF9F5;   /* warm off-white variant */
  --ink:        #1D1D1F;   /* primary text */
  --ink-80:     #3A3A3D;
  --ink-60:     #545458;
  --muted:      #86868B;   /* secondary text */
  --dim:        #C7C7CC;
  --hairline:   #E5E5EA;   /* card 1px border */
  --accent:     #D97757;   /* terracotta orange — Claude brand */
  --accent-deep:#B85D3D;

  --serif-cn: "Noto Serif SC", "Songti SC", Georgia, serif;
  --serif-en: "Source Serif 4", "Tiempos Headline", Georgia, serif;
  --sans:     "Inter", -apple-system, "PingFang SC", system-ui;
  --mono:     "JetBrains Mono", "SF Mono", ui-monospace;
}
```

**Core principles**:
1. **Never use pure black background**. Black makes work look like a film — not like "ready-to-adopt work output"
2. **Terracotta orange is the only hue accent** — everything else is grayscale + white
3. **Three-font stack** (serif English + serif CJK + sans + mono) creates a "publication" feel rather than "internet product"

---

## Core Layout Patterns

### 1. Floating Card (The Fundamental Unit of This Style)

```css
.gallery-card {
  background: #FFFFFF;
  border-radius: 14px;
  padding: 6px;                          /* inner padding = "mat board" */
  border: 1px solid var(--hairline);
  box-shadow:
    0 20px 60px -20px rgba(29, 29, 31, 0.12),   /* main shadow — soft and long */
    0 6px 18px -6px rgba(29, 29, 31, 0.06);     /* second layer near-light, creates float */
  aspect-ratio: 16 / 9;                  /* uniform slide ratio */
  overflow: hidden;
}
.gallery-card img {
  width: 100%; height: 100%;
  object-fit: cover;
  border-radius: 9px;                    /* slightly smaller than card radius — visual nesting */
}
```

**Anti-pattern**: Do not flush-tile with no padding/border/shadow — that's information-dense expression, not an exhibition.

### 2. 3D Tilted Gallery Wall

```css
.gallery-viewport {
  position: absolute; inset: 0;
  overflow: hidden;
  perspective: 2400px;                   /* deeper perspective — tilt isn't exaggerated */
  perspective-origin: 50% 45%;
}
.gallery-canvas {
  width: 4320px;                         /* canvas = 2.25x viewport */
  height: 2520px;                        /* leaves room for pan */
  transform-origin: center center;
  transform: perspective(2400px)
             rotateX(14deg)              /* tilt back */
             rotateY(-10deg)             /* turn left */
             rotateZ(-2deg);             /* slight rotation — removes over-regularity */
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 40px;
  padding: 60px;
}
```

**Parameter sweet spots**:
- rotateX: 10-15deg (more than this starts to look like a VIP event backdrop)
- rotateY: ±8-12deg (sense of left-right symmetry)
- rotateZ: ±2-3deg (the human touch of "this wasn't placed by a machine")
- perspective: 2000-2800px (below 2000 gets fisheye, above 3000 approaches orthographic projection)

### 3. 2×2 Four-Corner Convergence (Selection Scene)

```css
.grid22 {
  display: grid;
  grid-template-columns: repeat(2, 800px);
  gap: 56px 64px;
  align-items: start;
}
```

Each card slides from its corresponding corner (tl/tr/bl/br) toward center + fade in. Corresponding `cornerEntry` vectors:

```js
const cornerEntry = {
  tl: { dx: -700, dy: -500 },
  tr: { dx:  700, dy: -500 },
  bl: { dx: -700, dy:  500 },
  br: { dx:  700, dy:  500 },
};
```

---

## Five Core Animation Patterns

### Pattern A · Four-Corner Convergence (0.8-1.2s)

4 elements slide in from the viewport corners, simultaneously scaling 0.85→1.0, with ease-out. Good opening for "showing multi-directional choices."

```js
const inP = easeOut(clampLerp(t, start, end));
card.style.transform = `translate3d(${(1-inP)*ce.dx}px, ${(1-inP)*ce.dy}px, 0) scale(${0.85 + 0.15*inP})`;
card.style.opacity = inP;
```

### Pattern B · Selected Card Zooms + Others Slide Out (0.8s)

Selected card scales 1.0→1.28; other cards fade out + blur + drift back toward their corners:

```js
// Selected card
card.style.transform = `translate3d(${cellDx*outP}px, ${cellDy*outP}px, 0) scale(${1 + 0.28*easeOut(zoomP)})`;
// Unselected cards
card.style.opacity = 1 - outP;
card.style.filter = `blur(${outP * 1.5}px)`;
```

**Critical**: unselected cards should blur, not just fade. Blur simulates depth of field, visually "pushing" the selected card forward.

### Pattern C · Ripple Expansion (1.7s)

From center outward, staggered by distance — each card fades in + scales from 1.25x down to 0.94x ("camera pulls back"):

```js
const col = i % COLS, row = Math.floor(i / COLS);
const dc = col - (COLS-1)/2, dr = row - (ROWS-1)/2;
const dist = Math.sqrt(dc*dc + dr*dr);
const delay = (dist / maxDist) * 0.8;
const localT = Math.max(0, (t - rippleStart - delay) / 0.7);
card.style.opacity = easeOut(Math.min(1, localT));

// Simultaneously overall scale 1.25→0.94
const galleryScale = 1.25 - 0.31 * easeOut(rippleProgress);
```

### Pattern D · Sinusoidal Pan (Continuous Drift)

Uses a combination of sine wave + linear drift, avoiding the "has a start and end" looping feel of a marquee:

```js
const panX = Math.sin(panT * 0.12) * 220 - panT * 8;    // drifts left
const panY = Math.cos(panT * 0.09) * 120 - panT * 5;    // drifts up
const clampedX = Math.max(-900, Math.min(900, panX));   // prevents exposing edge
```

**Parameters**:
- Sine period `0.09-0.15 rad/s` (slow, about 30-50s per sway)
- Linear drift `5-8 px/s` (slower than a viewer's blink)
- Amplitude `120-220 px` (large enough to feel, small enough not to cause motion sickness)

### Pattern E · Focus Overlay (Focus Switch)

**Key design**: focus overlay is a **flat element** (no tilt) floating above the tilted canvas. The selected slide scales from its tile position (~400×225) to screen center (960×540); the background canvas doesn't un-tilt but **darkens to 45%**:

```js
// Focus overlay (flat, centered)
focusOverlay.style.width = (startW + (endW - startW) * focusIntensity) + 'px';
focusOverlay.style.height = (startH + (endH - startH) * focusIntensity) + 'px';
focusOverlay.style.opacity = focusIntensity;

// Background cards darken, but remain visible (critical — don't 100% cover)
card.style.opacity = entryOp * (1 - 0.55 * focusIntensity);   // 1 → 0.45
card.style.filter = `brightness(${1 - 0.3 * focusIntensity})`;
```

**Clarity iron rule**:
- Focus overlay's `<img>` must `src` directly to the original image — **do not reuse compressed thumbnails from the gallery tiles**
- Preload all original images into a `new Image()[]` array in advance
- overlay's own `width/height` computed per frame — browser resamples original image every frame

---

## Timeline Architecture (Reusable Skeleton)

```js
const T = {
  DURATION: 25.0,
  s1_in: [0.0, 0.8],    s1_type: [1.0, 3.2],  s1_out: [3.5, 4.0],
  s2_in: [3.9, 5.1],    s2_hold: [5.1, 7.0],  s2_out: [7.0, 7.8],
  s3_hold: [7.8, 8.3],  s3_ripple: [8.3, 10.0],
  panStart: 8.6,
  focuses: [
    { start: 11.0, end: 12.7, idx: 2  },
    { start: 13.3, end: 15.0, idx: 3  },
    { start: 15.6, end: 17.3, idx: 10 },
    { start: 17.9, end: 19.6, idx: 16 },
  ],
  s4_walloff: [21.1, 21.8], s4_in: [21.8, 22.7], s4_hold: [23.7, 25.0],
};

// Core easing
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
function lerp(time, start, end, fromV, toV, easing) {
  if (time <= start) return fromV;
  if (time >= end) return toV;
  let p = (time - start) / (end - start);
  if (easing) p = easing(p);
  return fromV + (toV - fromV) * p;
}

// Single render(t) function reads timestamp and writes all elements
function render(t) { /* ... */ }
requestAnimationFrame(function tick(now) {
  const t = ((now - startMs) / 1000) % T.DURATION;
  render(t);
  requestAnimationFrame(tick);
});
```

**Architectural insight**: **all state is derived from the timestamp t** — no state machines, no setTimeouts. This means:
- Jump to any playback position instantly with `window.__setTime(12.3)` (convenient for Playwright frame-by-frame captures)
- Looping is naturally seamless (t mod DURATION)
- Can freeze any single frame for debugging

---

## Texture Details (Easy to Miss, Fatal to Omit)

### 1. SVG Noise Texture

Light backgrounds are most prone to looking "too flat." Overlay an extremely subtle fractalNoise layer:

```html
<style>
.stage::before {
  content: '';
  position: absolute; inset: 0;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.078  0 0 0 0 0.078  0 0 0 0 0.074  0 0 0 0.035 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  opacity: 0.5;
  pointer-events: none;
  z-index: 30;
}
</style>
```

Looks like it makes no difference — until you remove it.

### 2. Corner Brand Mark

```html
<div class="corner-brand">
  <div class="mark"></div>
  <div>HUASHU · DESIGN</div>
</div>
```

```css
.corner-brand {
  position: absolute; top: 48px; left: 72px;
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--muted);
}
```

Only visible during the gallery wall scene — fades in and out. Like a museum exhibition label.

### 3. Brand Closure Wordmark

```css
.brand-wordmark {
  font-family: var(--sans);
  font-size: 148px;
  font-weight: 700;
  letter-spacing: -0.045em;   /* negative tracking is key — makes letters tight into a mark */
}
.brand-wordmark .accent {
  color: var(--accent);
  font-weight: 500;           /* accent character is lighter — visual weight contrast */
}
```

`letter-spacing: -0.045em` is the standard Apple product page large-type treatment.

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| Looks like a PPT template | Cards have no shadow / hairline | Add two-layer box-shadow + 1px border |
| Tilt looks cheap | Only used rotateY without rotateZ | Add ±2-3deg rotateZ to break the rigidity |
| Pan feels "choppy" | Used setTimeout or CSS keyframe loop | Use rAF + sin/cos continuous functions |
| Focus text is blurry | Reused low-res gallery tile image | Separate overlay + direct original image src |
| Background too empty | Plain `#F5F5F7` color | Overlay SVG fractalNoise at 0.5 opacity |
| Fonts feel "internet-product" | Only Inter | Add Serif (one English, one CJK) + mono three-stack |

---

## References

- Complete implementation sample: `/Users/alchain/Documents/writing/01-WeChat-articles/projects/2026.04-huashu-design-launch/assets/hero-animation-v5.html`
- Original inspiration: claude.ai/design hero video
- Reference aesthetics: Apple product pages, Dribbble shot collections

When facing an animation requirement of "multiple high-quality outputs to display," copy the skeleton from this file directly, swap in content + adjust timing.
