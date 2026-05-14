# Cinematic Patterns · Best Practices for Workflow Demo

> 5 key patterns for upgrading from "PPT animation" to "launch-event-grade cinematic."
> Distilled from the two cinematic demos in the 2026-04 "skill showcase" deck (Nuwa workflow + Darwin workflow) — reproducible from real-world testing.

---

## 0 · What Problem This Document Solves

When you need to create a "demo animation showcasing a workflow" (typical scenarios: skill workflows, product onboarding, API call processes, agent task execution), there are two common approaches:

| Paradigm | What it looks like | Outcome |
|---|---|---|
| **PPT animation** (bad) | step 1 fade in → step 2 fade in → step 3 fade in, 4 boxes displayed simultaneously | Audience feels "it's just a PPT with fade effects"; no wow moment |
| **Cinematic** (good) | Scene-based; only one thing in focus at a time; transitions between scenes use dissolve / focus pull / morph | Audience feels "this is a product launch clip"; they want to screenshot it |

The root difference is **not animation technique** — it is the **narrative paradigm**. This document explains how to upgrade from the former to the latter.

---

## 1 · Five Core Patterns

### Pattern A · Dashboard + Cinematic Overlay Dual-Layer Structure

**Problem**: Pure cinematic defaults to a black screen + a single ▶ button; if the viewer flips to this slide without clicking, they see nothing.

**Solution**:
```
DEFAULT state (always visible): complete static workflow dashboard
  └── viewer immediately understands how this skill / workflow runs

CLICK ▶ trigger (overlay floats up): 22-second cinematic
  └── automatically fades back to DEFAULT when done

```

**Implementation notes**:
- `.dash` is visible by default; `.cinema` defaults to `opacity: 0; pointer-events: none`
- `.play-cta` is a small gold button in the bottom-right corner (not a large center overlay)
- Click → `cinema.classList.add('show')` + `dash.classList.add('hide')`
- Run once with `requestAnimationFrame` (not a loop); when done, `endCinematic()` reverses the state

**Anti-pattern**: default = large ▶ overlay covering everything; the page is blank until clicked.

---

### Pattern B · Scene-based, NOT Step-based

**Problem**: Breaking animation into "step 1 show → step 2 show → ..." is PPT thinking.

**Solution**: Split into 5 scenes, where each scene is an **independent shot** — full-screen, focusing on only one thing:

| Scene type | Responsibility | Duration |
|---|---|---|
| 1 · Invoke | User input trigger (terminal typewriter) | 3-4s |
| 2 · Process | Visualization of the core workflow (distinctive visual language) | 5-6s |
| 3 · Result/Insight | Key extracted output (visualized) | 4-5s |
| 4 · Output | Display of actual output (file / diff / numbers) | 3-4s |
| 5 · Hero Reveal | Closing hero moment (large type + value proposition) | 4-5s |

**Total duration ≈ 22 seconds** — the golden length validated through testing:
- Under 18 seconds: PMs haven't settled in before it's over
- Over 25 seconds: attention is lost
- 22 seconds is exactly enough for "hook → unfold → close → leave an impression"

**Implementation notes**:
- `T = { DURATION: 22.0, s1_in: [0, 0.7], s2_in: [3.8, 4.6], ... }` global timeline object
- Single `requestAnimationFrame(render)` runs all scene opacity/transform calculations
- Do not use setTimeout chains (they break easily and are hard to debug)
- Easing must use `expoOut` / `easeOut` / cubic-bezier — **linear is prohibited**

---

### Pattern C · Each Demo Must Have Its Own Independent Visual Language

**Problem**: After completing the first cinematic, you take the lazy route on the second one — reusing the same template (same orbit + pentagon + typewriter + hero large type) and just swapping the copy.

**Consequence**: The audience notices both skills "look identical" — which signals "these two skills are the same thing."

**Solution**: Each workflow has a different core metaphor, so the visual language must be different.

**Comparison case**:

| Dimension | Nuwa (persona distiller) | Darwin (skill optimizer) |
|---|---|---|
| Core metaphor | Collect → distill → write | Loop → evaluate → ratchet |
| Visual motion | Floating / radiate / pentagon | Cycle / ascend / contrast |
| Scene 2 | 3D Orbit · 8 archive cards floating in a perspective ellipse | Spin Loop · tokens running 5 laps along a 6-node circle |
| Scene 3 | Pentagon · 5 tokens radiating from center | v1 vs v5 · side-by-side diff (red version vs gold version) |
| Scene 4 | SKILL.md typewriter | Hill-Climb · full-screen curve drawing |
| Scene 5 hero | "21 minutes" serif italic large type | Spinning gear ⚙ + "KEPT +1.1" gold tag |

**Test**: cover the copy, look only at the visuals — can you tell which demo it is? If not, it's a lazy copy.

---

### Pattern D · Use AI-Generated Real Assets, Not Emoji or Hand-Drawn SVG

**Problem**: 3D orbit / gallery needs asset fragments floating around; emoji (📚🎤) look cheap and off-brand; hand-drawn SVG book spines never look like real books.

**Solution**: Use `huashu-gpt-image` to generate a single 4x2 grid image (8 thematically related objects · white background · 60px breathing space · unified style), then use `extract_grid.py --mode bbox` to cut it into 8 independent transparent PNGs.

**Prompt key points** (detailed prompt patterns in the `huashu-gpt-image` skill):
- IP anchoring ("1960s Caltech archive aesthetic" / "Hearthstone-style consistent treatment")
- White background (easier to remove; grey background has better atmosphere but is harder to extract transparent backgrounds)
- 4x2 not 5x5 (avoids the last-row compression bug)
- Persona finishing ("You are a Wired magazine curator preparing an exhibition photo")

**Anti-pattern**: using emoji as icons, using CSS silhouettes instead of product images.

---

### Pattern E · BGM + SFX Dual Track

**Problem**: Animation without sound makes the audience subconsciously feel "this thing feels like a budget demo."

**Solution**: Long BGM track + 11 SFX cues.

**Universal SFX cue recipe** (for workflow demos):

| Timing | SFX | Trigger scene |
|---|---|---|
| 0.10s | whoosh | Terminal rising from below |
| 3.0s | enter | Typewriter completes, press enter |
| 4.0s | slide-in | Scene 2 elements enter |
| 5-9s x 5 times | sparkle | Key process nodes (each generation / each token / each data point) |
| 14s | click | Switch to output scene |
| 17.8s | logo-reveal | Hero reveal moment |
| typewriter | type | Triggered every 2 characters (don't make it too dense) |

**Frequency separation**: BGM volume 0.32 (low-frequency bed), SFX volume 0.55 (mid/high-frequency punch), sparkle 0.7 (must be noticeable), logo-reveal 0.85 (strongest hero moment).

**User control**:
- Must have a ▶ start overlay (browser autoplay restrictions)
- Small mute button in the top-right corner (user can toggle at any time)
- Do not make it "plays automatically when you scroll to this slide"

---

## 2 · Static Dashboard Design Notes

The dashboard is Layer 1 of the dual-layer structure; PMs who don't click ▶ can still understand the skill.

**Layout**: 3-column grid (or 1 large + 2 small); each panel solves one problem:

| Panel type | What problem it solves | Example |
|---|---|---|
| **Pipeline / Flow Diagram** | "What is the workflow for this skill?" | Nuwa 4-stage pipeline · Darwin autoresearch loop |
| **Snapshot / State** | "What does actual output data look like?" | Darwin 8-dimension rubric snapshot |
| **Trajectory / Evolution** | "How does it change across multiple runs?" | Darwin 5-generation hill-climb curve |
| **Examples / Gallery** | "What has it already produced?" | Nuwa 21 personas gallery |
| **Strip · Example I/O** | "Input what → output what" | Nuwa example strip: `› nuwa distill feynman → feynman.skill (21 min)` |

**Key constraints**:
- Information density must be sufficient (each panel should carry differentiated information)
- But do not stuff in data slop (every number must be meaningful)
- Color scheme consistent with cinematic (same palette; switching should not look jarring)

---

## 3 · Debugging and Development Tools

Any long animation must have three dev tools — without them, debugging will be a disaster.

### Tool 1 · `?seek=N` Freeze to Second N

```js
const seek = parseFloat(params.get('seek'));
if (!isNaN(seek)) {
  started = true; muted = true;
  frozenT = seek;  // render() uses this t instead of elapsed
  cinema.classList.add('show'); dash.classList.add('hide');
}

// Inside render():
let t = frozenT !== null ? frozenT : (elapsed % T.DURATION);
```

Usage: `http://.../slide.html?seek=12` jumps directly to the 12-second frame without waiting for playback.

### Tool 2 · `?autoplay=1` Skip the ▶ Overlay

Useful for Playwright automated screenshot testing, and for forcing playback when embedded in an iframe.

### Tool 3 · Manual REPLAY Button

A small button in the top-right corner; allows the user/developer to replay any number of times. CSS:

```css
.replay{position:absolute;top:18px;right:18px;background:rgba(212,165,116,0.1);
  border:1px solid rgba(212,165,116,0.3);color:#D4A574;
  font-family:monospace;font-size:10px;letter-spacing:.28em;text-transform:uppercase;
  padding:6px 12px;border-radius:1px;cursor:pointer;backdrop-filter:blur(6px);z-index:6}
```

---

## 4 · iframe Embedding Pitfalls (If Cinematic Is Embedded in a Deck)

### Pitfall 1 · Parent window click zone intercepts iframe buttons

If the deck index.html has "left/right 22vw transparent click zones for page navigation," they will **overlap the iframe's ▶ play button** — when the user clicks the button, it gets swallowed as "next page."

**Fix**: add `top: 12vh; bottom: 25vh` to the click zone, leaving the top and bottom 25% unblocked so both the center ▶ and bottom-right ▶ inside the iframe are clickable.

### Pitfall 2 · iframe stealing focus causes keyboard events to be lost

After the user clicks inside the iframe, focus is inside the iframe and the parent window stops receiving ←/→ keyboard events.

**Fix**:
```js
iframe.addEventListener('load', () => {
  // Inject keyboard forwarder
  const doc = iframe.contentDocument;
  doc.addEventListener('keydown', (e) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, ... }));
  });
  // Pull focus back to parent window after click
  doc.addEventListener('click', () => setTimeout(() => window.focus(), 0));
});
```

### Pitfall 3 · file:// vs https:// Behavior Differences

A cinematic tested locally via file:// may break after deployment because:
- Under file://, the iframe contentDocument is same-origin
- Under https:// it is also same-origin (if same host), but audio autoplay restrictions are stricter

**Fix**:
- Before deploying, test once using `python3 -m http.server` to spin up a local HTTP server
- BGM must only call `bgm.play()` after the user clicks ▶, not immediately on page load

---

## 5 · Anti-Pattern Quick Reference

| ❌ Anti-pattern | ✅ Correct pattern |
|---|---|
| Default = black screen ▶ overlay | Default = static dashboard; ▶ is supplementary |
| 4 steps side by side, all fade in simultaneously | 5 scenes full-screen switching; each scene focuses on only one thing |
| Reuse template, swap copy for different demos | Each demo has its own independent visual language (covering copy, visuals are distinguishable) |
| Emoji / hand-drawn SVG as assets | gpt-image-2 large image + extract_grid for cutting |
| No BGM, no SFX | BGM + 11 SFX cues dual track |
| setTimeout chains for scheduling | requestAnimationFrame + global timeline T object |
| Linear animation | Expo / cubic-bezier easing |
| No dev tools | `?seek=N` + `?autoplay=1` + REPLAY button |
| Buttons inside iframe swallowed by parent click zone | Click zone with top/bottom margin to give buttons room |

---

## 6 · Time Budget

Following these patterns, a complete cinematic demo (including dashboard):

| Task | Time |
|---|---|
| Design 5-scene narrative + visual language | 30 minutes (take this seriously — it determines independence) |
| Dashboard static layout + content | 1 hour |
| Cinematic 5 scenes implementation | 1.5 hours |
| Audio cue timing + REPLAY button | 30 minutes |
| Playwright screenshot validation at 5 key moments | 15 minutes |
| **Single demo total** | **3-4 hours** |

The second demo reuses the framework but **visual language must be independent** — approximately 2-3 hours.
