# Animation Best Practices · Positive Animation Design Grammar

> Based on a deep breakdown of Anthropic's three official product animations (Claude Design / Claude Code Desktop / Claude for Word),
> distilling the "Anthropic-grade" animation design rules.
>
> Use alongside `animation-pitfalls.md` (the pitfalls checklist) — this file is "**do it this way**",
> pitfalls is "**don't do it this way**". They are orthogonal; read both.
>
> **Scope declaration**: This file only covers **motion logic and expressive style**. It does not introduce any specific brand colour values.
> Colour decisions go through the §1.a core assets protocol (extracted from the brand spec) or the "design direction advisor"
> (colour schemes for each of the 20 philosophies). This reference discusses "**how to move**", not "**what colour**".

---

## §0 · Who You Are · Identity and Taste

> Read this section before any of the technical rules that follow. The rules **emerge from identity** —
> not the other way around.

### §0.1 Identity Anchor

**You are a motion designer who has studied the motion archives of Anthropic / Apple / Pentagram / Field.io.**

When you make animations, you are not tweaking CSS transitions — you are using digital elements to **simulate a physical world**,
making the viewer's subconscious believe "this has weight, inertia, and can overflow".

You do not make PowerPoint-style animations. You do not make "fade in fade out" animations. Your animations **make people believe the screen
is a space they can reach into**.

### §0.2 Core Beliefs (3)

1. **Animation is physics, not easing curves**
   `linear` is a number; `expoOut` is an object. You believe the pixels on screen deserve to be treated as "objects".
   Every easing choice is answering the physical question: "How heavy is this element? What is its friction coefficient?"

2. **Timing distribution matters more than curve shape**
   Slow-Fast-Boom-Stop is your breath. **Animation with uniform tempo is a technical demo; animation with rhythm is storytelling.**
   Slowing down at the right moment matters more than using the right easing at the wrong moment.

3. **Respecting the audience is harder than showing off**
   Pausing 0.5 seconds before a key result is **craft**, not compromise. **Giving the human brain reaction time is the highest skill of an animator.**
   AI defaults to animation with no pauses and information density at maximum — that is amateur work. What you must do is exercise restraint.

### §0.3 Taste Standard · What is Beautiful

Your criteria for judging "good" vs "great" are below. Each dimension has an **identification method** — when you look at a candidate animation,
use these questions to judge whether it passes, rather than mechanically checking 14 rules.

| Dimension of beauty | Identification method (audience reaction) |
|---|---|
| **Physical weight** | When the animation ends, the element "**lands**" with stability — it does not just "**stop**" there. The viewer subconsciously feels "this has weight" |
| **Respecting the audience** | There is a perceptible pause (≥300ms) before key information appears — the audience has time to "**see**" it before things continue |
| **Negative space** | The ending is a hard cut + hold, not a fade to black. The final frame is clear, confident, decisive |
| **Restraint** | There is only one moment of "120% refinement" in the whole piece; the remaining 80% is just right — **showing off everywhere is a cheap signal** |
| **Hand-feel** | Arcs (not straight lines), irregularity (not mechanical setInterval rhythm), a sense of breathing |
| **Respect** | Show the tweak process, show the bug being fixed — **don't hide the work, don't do "magic"**. AI is a collaborator, not a magician |

### §0.4 Self-check · The Audience First-Reaction Method

After finishing an animation, **what is the audience's first reaction?** — that is the only metric you need to optimise for.

| Audience reaction | Rating | Diagnosis |
|---|---|---|
| "Looks pretty smooth" | good | Technically acceptable but characterless — you are making PowerPoint |
| "That animation feels really fluid" | good+ | Technically right, but not stunning |
| "That thing really looks like **it's floating up off a desk**" | great | You touched physical weight |
| "This doesn't look like it was made by AI" | great+ | You touched Anthropic's threshold |
| "I want to **screenshot** this and share it" | great++ | You made the audience want to spread it |

**The difference between great and good is not technical correctness — it is taste. Technical correctness + taste = great.
Technical correctness + no taste = good. Technical errors = you haven't started.**

### §0.5 The Relationship Between Identity and Rules

The technical rules in §1–§8 below are the **execution tools** of this identity in specific scenarios — not an independent rule list.

- When you encounter a scenario the rules don't cover → return to §0 and use **identity** to judge; don't guess
- When rules conflict → return to §0 and use **taste criteria** to determine which is more important
- When you want to break a rule → first answer: "Which beauty criterion in §0.3 does this serve?" If you can answer, break it. If you can't, don't.

Right. Keep reading.

---

## Overview · Animation as Physics: Three Levels

The root cause of the cheap feel in most AI-generated animation is — **they behave like "numbers" rather than "objects"**.
Real-world objects have mass, inertia, elasticity, and can overflow. The "premium feel" of Anthropic's three films
comes from giving digital elements a set of **physical-world motion rules**.

These rules have 3 levels:

1. **Narrative rhythm layer**: Timing distribution of Slow-Fast-Boom-Stop
2. **Motion curve layer**: Expo Out / Overshoot / Spring, rejecting linear
3. **Expressive language layer**: Showing process, mouse arcs, Logo morph convergence

---

## 1. Narrative Rhythm · Slow-Fast-Boom-Stop 5-Segment Structure

All three Anthropic films follow this structure without exception:

| Segment | Share | Tempo | Purpose |
|---|---|---|---|
| **S1 Trigger** | ~15% | Slow | Give humans reaction time, establish authenticity |
| **S2 Generation** | ~15% | Medium | Visual wow moment appears |
| **S3 Process** | ~40% | Fast | Show controllability / density / detail |
| **S4 Explosion** | ~20% | Boom | Camera pulls back / 3D pop-out / multi-panel surge |
| **S5 Landing** | ~10% | Still | Brand Logo + hard cut |

**Concrete timing map** (for a 15-second animation):
S1 Trigger 2s · S2 Generation 2s · S3 Process 6s · S4 Explosion 3s · S5 Landing 2s

**Forbidden actions**:
- ❌ Uniform tempo (same information density every second) — audience fatigue
- ❌ Sustained high density — no peaks, no memorable moments
- ❌ Fading out to transparent at the end — should be a **hard cut**

**Self-check**: Sketch 5 thumbnails on paper, each representing the climax frame of one segment. If the 5 drawings look similar,
the rhythm hasn't been established.

---

## 2. Easing Philosophy · Reject linear, Embrace Physics

All motion effects in Anthropic's three films use Bezier curves with a "damped" feel. The default cubic easeOut
(`1-(1-t)³`) is **not sharp enough** — the start is not fast enough, the stop is not stable enough.

### Three Core Easings (built into animations.jsx)

```js
// 1. Expo Out · Fast start, slow brake (most common, default primary easing)
// CSS equivalent: cubic-bezier(0.16, 1, 0.3, 1)
Easing.expoOut(t) // = t === 1 ? 1 : 1 - Math.pow(2, -10 * t)

// 2. Overshoot · Elastic toggle/button pop-out
// CSS equivalent: cubic-bezier(0.34, 1.56, 0.64, 1)
Easing.overshoot(t)

// 3. Spring physics · Geometry settling, natural landing
Easing.spring(t)
```

### Usage Mapping

| Scenario | Which Easing |
|---|---|
| Card rise-in / panel entry / Terminal fade / focus overlay | **`expoOut`** (primary easing, most common) |
| Toggle switch / button pop-out / emphasis interaction | `overshoot` |
| Preview geometry settling / physical landing / UI element bounce | `spring` |
| Continuous motion (e.g. mouse path interpolation) | `easeInOut` (preserves symmetry) |

### Counter-intuitive Insight

Most product promo animations are **too fast and too stiff**. `linear` makes digital elements feel like machines; `easeOut` is a baseline score;
`expoOut` is the technical root of "premium feel" — it gives digital elements a **sense of physical-world weight**.

---

## 3. Motion Language · 8 Common Principles

### 3.1 Background Colour Is Not Pure Black or Pure White

None of Anthropic's three films use `#FFFFFF` or `#000000` as their main background colour. **Neutral colours with a colour temperature**
(warm or cool) have the material feel of "paper / canvas / desk surface", which reduces the machine-like sensation.

**Specific colour value decisions** go through the §1.a core assets protocol (extracted from the brand spec) or the "design direction advisor"
(background colour schemes for each of the 20 philosophies). This reference does not give specific values — that is a **brand decision**, not a motion rule.

### 3.2 Easing Is Never linear

See §2.

### 3.3 Slow-Fast-Boom-Stop Narrative

See §1.

### 3.4 Show "Process" Rather Than "Magic Result"

- Claude Design shows tweaking parameters, dragging sliders (not one-click perfect results)
- Claude Code shows code errors + AI fixing them (not success on the first try)
- Claude for Word shows the Redline red-deletion green-addition revision process (not handing over the final draft directly)

**Shared subtext**: The product is a **collaborator, pair programmer, senior editor** — not a one-click magician.
This precisely addresses professional users' pain points around "controllability" and "authenticity".

**Anti-AI slop**: AI defaults to "magic one-click success" animations (one click to generate → perfect result);
that is the common denominator. **Doing the opposite** — showing the process, showing tweaks, showing bugs and fixes —
is the source of brand identity.

### 3.5 Mouse Paths Hand-Drawn (Arcs + Perlin Noise)

A real human's mouse movement is not a straight line — it is "acceleration at start → arc → deceleration correction → click".
Mouse paths that AI interpolates in straight lines create a **subconscious sense of rejection**.

```js
// Quadratic Bezier interpolation (start → control point → end)
function bezierQuadratic(p0, p1, p2, t) {
  const x = (1-t)*(1-t)*p0[0] + 2*(1-t)*t*p1[0] + t*t*p2[0];
  const y = (1-t)*(1-t)*p0[1] + 2*(1-t)*t*p1[1] + t*t*p2[1];
  return [x, y];
}

// Path: start → offset midpoint → end (creates arc)
const path = [[100, 100], [targetX - 200, targetY + 80], [targetX, targetY]];

// Overlay tiny Perlin Noise (±2px) to create "hand tremor"
const jitterX = (simpleNoise(t * 10) - 0.5) * 4;
const jitterY = (simpleNoise(t * 10 + 100) - 0.5) * 4;
```

### 3.6 Logo "Morph" Convergence

The Logo entrance in Anthropic's three films is **never a simple fade-in** — it **morphs from the preceding visual element**.

**Common pattern**: In the last 1–2 seconds, do a Morph / Rotate / Converge, letting the entire narrative "collapse" onto the brand moment.

**Low-cost implementation** (without true morph):
Let the previous visual element "collapse" into a colour block (scale → 0.1, translate toward centre),
then let the colour block "expand" into the wordmark. Use a 150ms quick cut + motion blur
(`filter: blur(6px)` → `0`) for the transition.

```js
<Sprite start={13} end={14}>
  {/* Collapse: previous element scale 0.1, opacity retained, filter blur increases */}
  const scale = interpolate(t, [0, 0.5], [1, 0.1], Easing.expoOut);
  const blur = interpolate(t, [0, 0.5], [0, 6]);
</Sprite>
<Sprite start={13.5} end={15}>
  {/* Expand: Logo scales from colour block centre 0.1 → 1, blur 6 → 0 */}
  const scale = interpolate(t, [0, 0.6], [0.1, 1], Easing.overshoot);
  const blur = interpolate(t, [0, 0.6], [6, 0]);
</Sprite>
```

### 3.7 Serif + Sans-Serif Dual Typefaces

- **Brand / narration**: serif (gives "academic / publication / cultured" feeling)
- **UI / code / data**: sans-serif + monospace

**Using a single typeface is wrong.** Serif gives "taste"; sans-serif gives "function".

Specific font choices go through the brand spec (the Display / Body / Mono stack in brand-spec.md) or the design direction
advisor's 20 philosophies. This reference does not give specific fonts — that is a **brand decision**.

### 3.8 Focus Switch = Background Weakened + Foreground Sharpened + Flash Guidance

A focus switch is **not only** lowering opacity. The complete recipe is:

```js
// Filter combination for non-focus elements
tile.style.filter = `
  brightness(${1 - 0.5 * focusIntensity})
  saturate(${1 - 0.3 * focusIntensity})
  blur(${focusIntensity * 4}px)        // ← Key: adding blur makes it truly "recede"
`;
tile.style.opacity = 0.4 + 0.6 * (1 - focusIntensity);

// After focus completes, do a 150ms Flash highlight at the focus position to guide the eye back
focusOverlay.animate([
  { background: 'rgba(255,255,255,0.3)' },
  { background: 'rgba(255,255,255,0)' }
], { duration: 150, easing: 'ease-out' });
```

**Why blur is essential**: Relying only on opacity + brightness, the out-of-focus elements remain "sharp",
and visually there is no "receding into the background" effect. blur(4–8px) genuinely pushes non-focus elements one depth layer back.

---

## 4. Specific Motion Techniques (Code Snippets You Can Copy Directly)

### 4.1 FLIP / Shared Element Transition

A button "expands" into an input field — it is **not** the button disappearing + a new panel appearing. The core is **the same DOM element**
transitioning between two states, not two elements cross-fading.

```jsx
// Using Framer Motion layoutId
<motion.div layoutId="design-button">Design</motion.div>
// ↓ After click, same layoutId
<motion.div layoutId="design-button">
  <input placeholder="Describe your design..." />
</motion.div>
```

Native implementation reference: https://aerotwist.com/blog/flip-your-animations/

### 4.2 "Breathing" Expansion (width → height)

A panel expanding is **not** pulling width and height simultaneously — instead:
- First 40% of time: only pull width (keep height small)
- Last 60% of time: width holds, height expands

This simulates the physical feel of "unfold first, then fill with water".

```js
const widthT = interpolate(t, [0, 0.4], [0, 1], Easing.expoOut);
const heightT = interpolate(t, [0.3, 1], [0, 1], Easing.expoOut);
style.width = `${widthT * targetW}px`;
style.height = `${heightT * targetH}px`;
```

### 4.3 Staggered Fade-up (30ms stagger)

When table rows, card columns, or list items enter, **each element is delayed 30ms**, `translateY` moves from 10px back to 0.

```js
rows.forEach((row, i) => {
  const localT = Math.max(0, t - i * 0.03);  // 30ms stagger
  row.style.opacity = interpolate(localT, [0, 0.3], [0, 1], Easing.expoOut);
  row.style.transform = `translateY(${
    interpolate(localT, [0, 0.3], [10, 0], Easing.expoOut)
  }px)`;
});
```

### 4.4 Non-linear Breathing · Hold 0.5s Before Key Result

Machines execute fast and continuously, but **holding 0.5 seconds before a key result appears** gives the viewer's brain reaction time.

```jsx
// Typical scenario: AI generation complete → hold 0.5s → result appears
<Sprite start={8} end={8.5}>
  {/* 0.5s pause — nothing moves, let the audience stare at the loading state */}
  <LoadingState />
</Sprite>
<Sprite start={8.5} end={10}>
  <ResultAppear />
</Sprite>
```

**Counter-example**: AI generation complete → immediately cuts to result without pause — the audience has no reaction time, information is lost.

### 4.5 Chunk Reveal · Simulating Token Streaming

AI-generated text should **not use `setInterval` to pop characters out one by one** (like old movie subtitles) — use **chunk reveal**
— appear 2–5 characters at a time, with irregular intervals, simulating real token streaming output.

```js
// Split into chunks, not individual characters
const chunks = text.split(/(\s+|,\s*|\.\s*|;\s*)/);  // split by word + punctuation
let i = 0;
function reveal() {
  if (i >= chunks.length) return;
  element.textContent += chunks[i++];
  const delay = 40 + Math.random() * 80;  // irregular 40-120ms
  setTimeout(reveal, delay);
}
reveal();
```

### 4.6 Anticipation → Action → Follow-through

3 of Disney's 12 principles. Anthropic uses them very explicitly:

- **Anticipation**: A small counter-movement before the action begins (button slightly shrinks before popping out)
- **Action**: The main action itself
- **Follow-through**: Residual movement after the action ends (card gently bounces after landing)

```js
// Complete three-phase card entrance
const anticip = interpolate(t, [0, 0.2], [1, 0.95], Easing.easeIn);     // anticipation
const action  = interpolate(t, [0.2, 0.7], [0.95, 1.05], Easing.expoOut); // main action
const settle  = interpolate(t, [0.7, 1], [1.05, 1], Easing.spring);       // settle bounce
// Final scale = product of the three phases or applied in sequence
```

**Counter-example**: Animation with only Action and no Anticipation + Follow-through looks like "PowerPoint animation".

### 4.7 3D Perspective + translateZ Layering

For a "tilted 3D + floating card" quality, add perspective to the container and different translateZ values to individual elements:

```css
.stage-wrap {
  perspective: 2400px;
  perspective-origin: 50% 30%;  /* viewpoint looks down slightly */
}
.card-grid {
  transform-style: preserve-3d;
  transform: rotateX(8deg) rotateY(-4deg);  /* golden ratio */
}
.card:nth-child(3n) { transform: translateZ(30px); }
.card:nth-child(5n) { transform: translateZ(-20px); }
.card:nth-child(7n) { transform: translateZ(60px); }
```

**Why rotateX 8° / rotateY -4° is the golden ratio**:
- Greater than 10° → elements feel too distorted, as if "falling over"
- Less than 5° → looks like a "shear" rather than "perspective"
- The asymmetric ratio of 8° × -4° simulates the natural angle of "a camera looking down from the upper-left corner of a desk"

### 4.8 Diagonal Pan · Moving X and Y Simultaneously

Camera movement is not purely up-down or left-right — it **moves X and Y simultaneously** to simulate diagonal movement:

```js
const panX = Math.sin(flowT * 0.22) * 40;
const panY = Math.sin(flowT * 0.35) * 30;
stage.style.transform = `
  translate(-50%, -50%)
  rotateX(8deg) rotateY(-4deg)
  translate3d(${panX}px, ${panY}px, 0)
`;
```

**Key**: X and Y have different frequencies (0.22 vs 0.35), avoiding Lissajous loops from becoming regular.

---

## 5. Scene Recipes (Three Narrative Templates)

The three videos in the reference materials correspond to three product personalities. **Pick the one that best fits your product** — don't mix them.

### Recipe A · Apple Keynote Dramatic Style (Claude Design type)

**Suitable for**: Major version releases, hero animations, visual impact is the priority
**Tempo**: Slow-Fast-Boom-Stop strong arc
**Easing**: Full `expoOut` + small amount of `overshoot`
**SFX density**: High (~0.4/s), SFX pitch tuned to BGM scale
**BGM**: IDM / minimalist tech electronic, calm + precise
**Convergence**: Camera hard pulls back → drop → Logo morph → ethereal single note → hard cut

### Recipe B · One-Shot Tool Style (Claude Code type)

**Suitable for**: Developer tools, productivity apps, flow state scenarios
**Tempo**: Continuous stable flow, no obvious peaks
**Easing**: `spring` physics + `expoOut`
**SFX density**: **0** (purely driven by BGM edit rhythm)
**BGM**: Lo-fi Hip-hop / Boom-bap, 85–90 BPM
**Core technique**: Key UI actions land on BGM kick/snare transients — "**music rhythm is the interaction sound effect**"

### Recipe C · Office Efficiency Narrative Style (Claude for Word type)

**Suitable for**: Enterprise software, document/spreadsheet/calendar apps, professional feel is the priority
**Tempo**: Multi-scene hard cuts + Dolly In/Out
**Easing**: `overshoot` (toggle) + `expoOut` (panels)
**SFX density**: Medium (~0.3/s), UI clicks dominate
**BGM**: Jazzy Instrumental, minor key, BPM 90–95
**Core highlight**: One scene must be the "whole-piece highlight" — 3D pop-out / lifting off the plane

---

## 6. Counter-examples · This Is AI Slop

| Anti-pattern | Why it's wrong | Correct approach |
|---|---|---|
| `transition: all 0.3s ease` | `ease` is a cousin of linear; all elements move at the same speed | Use `expoOut` + per-element stagger |
| All entrances are `opacity 0→1` | No sense of directional movement | Combine with `translateY 10→0` + Anticipation |
| Logo fades in | No narrative convergence | Morph / Converge / Collapse-Expand |
| Mouse moves in a straight line | Subconscious machine feel | Bezier arc + Perlin Noise |
| Character-by-character typing (setInterval) | Like old movie subtitles | Chunk Reveal with random intervals |
| Key result appears with no hold | Audience has no reaction time | 0.5s hold before result |
| Focus switch only changes opacity | Out-of-focus elements are still sharp | opacity + brightness + **blur** |
| Pure black background / pure white background | Cyber feel / reflective fatigue | Neutral colour with colour temperature (follow brand spec) |
| All animations at the same speed | No rhythm | Slow-Fast-Boom-Stop |
| Fade out ending | No decisiveness | Hard cut (hold the final frame) |

---

## 7. Self-Check List (60 Seconds Before Animation Delivery)

- [ ] Is the narrative structure Slow-Fast-Boom-Stop, not uniform tempo?
- [ ] Is the default easing `expoOut`, not `easeOut` or `linear`?
- [ ] Did toggle / button pop-out use `overshoot`?
- [ ] Does card / list entrance have a 30ms stagger?
- [ ] Is there a 0.5s hold before the key result?
- [ ] Does typing use Chunk Reveal, not setInterval single-character?
- [ ] Does the focus switch include blur (not just opacity)?
- [ ] Is the Logo a morph convergence, not a fade-in?
- [ ] Is the background colour not pure black / pure white (has colour temperature)?
- [ ] Do the text elements have serif + sans-serif hierarchy?
- [ ] Does the ending hard cut, rather than fading out?
- [ ] (If there is a mouse) Is the mouse path an arc, not a straight line?
- [ ] Does the SFX density match the product personality (see Recipe A/B/C)?
- [ ] Is there a 6–8dB loudness difference between BGM and SFX? (see `audio-design-rules.md`)

---

## 8. Relationship With Other References

| Reference | Role | Relationship |
|---|---|---|
| `animation-pitfalls.md` | Technical pitfalls (16 rules) | "**Don't do this**" · The flip side of this file |
| `animations.md` | Stage/Sprite engine usage | The foundation of **how to write** animations |
| `audio-design-rules.md` | Dual-track audio rules | Rules for **pairing audio** with animation |
| `sfx-library.md` | 37 SFX catalogue | Sound effect **asset library** |
| `apple-gallery-showcase.md` | Apple gallery showcase style | A dedicated topic on one specific motion style |
| **This file** | Positive motion design grammar | "**Do it this way**" |

**Invocation order**:
1. First read the four-question position in SKILL.md workflow Step 3 (determines narrative role and visual temperature)
2. After picking a direction, read this file to determine **motion language** (Recipe A/B/C)
3. When writing code, reference `animations.md` and `animation-pitfalls.md`
4. When exporting video, follow `audio-design-rules.md` + `sfx-library.md`

---

## Appendix · Sources for This File

- Anthropic official animation breakdown: `References/BEST-PRACTICES.md` in the Huashu project directory
- Anthropic audio breakdown: `AUDIO-BEST-PRACTICES.md` in the same directory
- 3 reference videos: `ref-{1,2,3}.mp4` + corresponding `gemini-ref-*.md` / `audio-ref-*.md`
- **Strict filtering**: This reference does not include any specific brand colour values, font names, or product names.
  Colour/font decisions go through the §1.a core assets protocol or the 20 design philosophies.
