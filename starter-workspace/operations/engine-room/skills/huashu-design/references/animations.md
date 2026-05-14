# Animations: Timeline Animation Engine

Read this when doing animation / motion design HTML. Covers principles, usage, and common patterns.

## Core Pattern: Stage + Sprite

Our animation system (`assets/animations.jsx`) provides a timeline-driven engine:

- **`<Stage>`**: The container for the entire animation; automatically provides auto-scale (fit viewport) + scrubber + play/pause/loop controls
- **`<Sprite start end>`**: A time segment. A Sprite is only visible between `start` and `end`. Internally you can read the local progress `t` (0→1) via the `useSprite()` hook
- **`useTime()`**: Reads the current global time (in seconds)
- **`Easing.easeInOut` / `Easing.easeOut` / ...**:  Easing functions
- **`interpolate(t, from, to, easing?)`**: Interpolates a value based on t

This pattern draws on the Remotion / After Effects approach, but is lightweight and zero-dependency.

## Getting Started

```html
<script type="text/babel" src="animations.jsx"></script>
<script type="text/babel">
  const { Stage, Sprite, useTime, useSprite, Easing, interpolate } = window.Animations;

  function Title() {
    const { t } = useSprite();  // local progress 0→1
    const opacity = interpolate(t, [0, 1], [0, 1], Easing.easeOut);
    const y = interpolate(t, [0, 1], [40, 0], Easing.easeOut);
    return (
      <h1 style={{
        opacity,
        transform: `translateY(${y}px)`,
        fontSize: 120,
        fontWeight: 900,
      }}>
        Hello.
      </h1>
    );
  }

  function Scene() {
    return (
      <Stage duration={10}>  {/* 10-second animation */}
        <Sprite start={0} end={3}>
          <Title />
        </Sprite>
        <Sprite start={2} end={5}>
          <SubTitle />
        </Sprite>
        {/* ... */}
      </Stage>
    );
  }

  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<Scene />);
</script>
```

## Common Animation Patterns

### 1. Fade In / Fade Out

```jsx
function FadeIn({ children }) {
  const { t } = useSprite();
  const opacity = interpolate(t, [0, 0.3], [0, 1], Easing.easeOut);
  return <div style={{ opacity }}>{children}</div>;
}
```

**Note on range**: `[0, 0.3]` means the fade-in completes in the first 30% of the sprite's time; opacity stays at 1 after that.

### 2. Slide In

```jsx
function SlideIn({ children, from = 'left' }) {
  const { t } = useSprite();
  const progress = interpolate(t, [0, 0.4], [0, 1], Easing.easeOut);
  const offset = (1 - progress) * 100;
  const directions = {
    left: `translateX(-${offset}px)`,
    right: `translateX(${offset}px)`,
    top: `translateY(-${offset}px)`,
    bottom: `translateY(${offset}px)`,
  };
  return (
    <div style={{
      transform: directions[from],
      opacity: progress,
    }}>
      {children}
    </div>
  );
}
```

### 3. Character-by-Character Typewriter

```jsx
function Typewriter({ text }) {
  const { t } = useSprite();
  const charCount = Math.floor(text.length * Math.min(t * 2, 1));
  return <span>{text.slice(0, charCount)}</span>;
}
```

### 4. Number Count-Up

```jsx
function CountUp({ from = 0, to = 100, duration = 0.6 }) {
  const { t } = useSprite();
  const progress = interpolate(t, [0, duration], [0, 1], Easing.easeOut);
  const value = Math.floor(from + (to - from) * progress);
  return <span>{value.toLocaleString()}</span>;
}
```

### 5. Segmented Explanation (Typical Educational Animation)

```jsx
function Scene() {
  return (
    <Stage duration={20}>
      {/* Phase 1: Present the problem */}
      <Sprite start={0} end={4}>
        <Problem />
      </Sprite>

      {/* Phase 2: Present the approach */}
      <Sprite start={4} end={10}>
        <Approach />
      </Sprite>

      {/* Phase 3: Present the result */}
      <Sprite start={10} end={16}>
        <Result />
      </Sprite>

      {/* Caption displayed throughout */}
      <Sprite start={0} end={20}>
        <Caption />
      </Sprite>
    </Stage>
  );
}
```

## Easing Functions

Preset easing curves:

| Easing | Characteristic | Used for |
|--------|------|------|
| `linear` | Constant speed | Scrolling text, continuous animation |
| `easeIn` | Slow → fast | Exit / disappear |
| `easeOut` | Fast → slow | Entrance / appear |
| `easeInOut` | Slow → fast → slow | Positional changes |
| **`expoOut`** ⭐ | **Exponential ease-out** | **Anthropic-grade primary easing** (physical weight feel) |
| **`overshoot`** ⭐ | **Elastic bounce-back** | **Toggle / button pop-out / emphasis interaction** |
| `spring` | Spring physics | Interaction feedback, geometry settling |
| `anticipation` | Counter-direction then forward | Emphasis actions |

**Default primary easing is `expoOut`** (not `easeOut`) — see `animation-best-practices.md` §2.
Entrances use `expoOut`, exits use `easeIn`, toggles use `overshoot` — the foundational pattern of Anthropic-grade animation.

## Timing and Duration Guide

### Micro-interactions (0.1–0.3 seconds)
- Button hover
- Card expand
- Tooltip appearance

### UI Transitions (0.3–0.8 seconds)
- Page switch
- Modal appearance
- List item addition

### Narrative Animation (2–10 seconds per segment)
- One phase of concept explanation
- Data chart reveal
- Scene transition

### Single narrative animation segment: no longer than 10 seconds
Human attention is limited. Tell one thing in 10 seconds, then move to the next.

## Thinking Order When Designing Animation

### 1. Content / Story First, Animation Second

**Wrong**: Start with wanting a fancy animation, then stuff content into it
**Right**: First clarify what information you want to communicate, then use animation to serve that information

Animation is a **signal**, not **decoration**. A fade-in says "this is important, look here" — if everything fades in, the signal loses meaning.

### 2. Write the Timeline by Scene

```
0:00 - 0:03   Problem appears (fade in)
0:03 - 0:06   Problem magnifies / expands (zoom+pan)
0:06 - 0:09   Solution appears (slide in from right)
0:09 - 0:12   Solution explained (typewriter)
0:12 - 0:15   Result demonstrated (counter up + chart reveal)
0:15 - 0:18   One-line summary (static, read for 3 seconds)
0:18 - 0:20   CTA or fade out
```

Write the timeline first, then write the components.

### 3. Assets First

Images / icons / fonts the animation will use — get them **first**. Don't go looking for assets halfway through — it breaks the rhythm.

## Common Issues

**Animation stutters**
→ Usually layout thrashing. Use `transform` and `opacity`; don't animate `top` / `left` / `width` / `height` / `margin`. The browser GPU-accelerates `transform`.

**Animation too fast, can't read it**
→ A person needs 100–150ms to read a character, 300–500ms for a word. If you're telling a story with text, leave at least 3 seconds per sentence.

**Animation too slow, audience bored**
→ Interesting visual changes should be dense. A static frame for more than 5 seconds will feel dull.

**Multiple animations interfering with each other**
→ Use CSS `will-change: transform` to tell the browser in advance that this element will move, reducing reflow.

**Recording to video**
→ Use the skill's built-in toolchain (one command for three formats): see `video-export.md`
- `scripts/render-video.js` — HTML → 25fps MP4 (Playwright + ffmpeg)
- `scripts/convert-formats.sh` — 25fps MP4 → 60fps MP4 + optimised GIF
- Want more precise frame rendering? Make render(t) a pure function — see `animation-pitfalls.md` rule 5

## Working With Video Tools

This skill produces **HTML animations** (running in the browser). If the final output needs to be used as video material:

- **Short animations / concept demos**: Use the approach here to make HTML animation → screen record
- **Long video / narrative**: This skill focuses on HTML animation; use AI video generation skills or professional video software for long-form video
- **Motion graphics**: Professional After Effects / Motion Canvas is more appropriate

## On Libraries Like Popmotion

If you genuinely need physics animation (spring, decay, keyframes with precise timing) that our engine can't handle, you can fall back to Popmotion:

```html
<script src="https://unpkg.com/popmotion@11.0.5/dist/popmotion.min.js"></script>
```

But **try our engine first**. It's sufficient for 90% of cases.
