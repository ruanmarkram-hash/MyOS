# Animation Pitfalls: Bugs Hit During HTML Animation and How to Avoid Them

The most common bugs when making animations, and how to avoid them. Every rule comes from a real failure.

Read this before writing any animation — it will save you one iteration cycle.

## 1. Stacking Layout — `position: relative` Is a Default Obligation

**The pitfall**: A sentence-wrap element wraps 3 bracket-layer elements (`position: absolute`). The sentence-wrap was not given `position: relative`, so the absolute-positioned brackets used `.canvas` as their coordinate system and drifted 200px off the bottom of the screen.

**Rules**:
- Any container with `position: absolute` children **must** explicitly have `position: relative`
- Even if there is no visual "offset" needed, write `position: relative` as a coordinate anchor
- If you are writing `.parent { ... }` and a child has `.child { position: absolute }`, reflexively add relative to the parent

**Quick check**: Every time `position: absolute` appears, count up the ancestors to confirm the nearest positioned ancestor is the *intended* coordinate system.

## 2. Character Traps — Do Not Rely on Rare Unicode

**The pitfall**: Wanted to use `␣` (U+2423 OPEN BOX) to visualise a "space token". Neither Noto Serif SC nor Cormorant Garamond have this glyph; it renders as blank/tofu and the audience sees nothing.

**Rules**:
- **Every character that appears in the animation must exist in your chosen font**
- Common rare character blacklist: `␣ ␀ ␐ ␋ ␨ ↩ ⏎ ⌘ ⌥ ⌃ ⇧ ␦ ␖ ␛`
- To represent meta-characters like "space / enter / tab", use **CSS-constructed semantic boxes**:
  ```html
  <span class="space-key">Space</span>
  ```
  ```css
  .space-key {
    display: inline-flex;
    padding: 4px 14px;
    border: 1.5px solid var(--accent);
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.3em;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  ```
- Also verify emoji: some emoji will fall back to a grey box in fonts other than Noto Emoji; best to use `emoji` font-family or SVG

## 3. Data-Driven Grid/Flex Templates

**The pitfall**: The code has `const N = 6` tokens, but CSS is hard-coded as `grid-template-columns: 80px repeat(5, 1fr)`. The 6th token has no column, and the entire matrix is misaligned.

**Rules**:
- When the count comes from a JS array (`TOKENS.length`), the CSS template should also be data-driven
- Option A: Inject using a CSS variable from JS
  ```js
  el.style.setProperty('--cols', N);
  ```
  ```css
  .grid { grid-template-columns: 80px repeat(var(--cols), 1fr); }
  ```
- Option B: Use `grid-auto-flow: column` to let the browser expand automatically
- **Prohibit the "fixed number + JS constant" combination** — if N changes, CSS won't update automatically

## 4. Transition Gaps — Scene Switches Must Be Continuous

**The pitfall**: zoom1 (13–19s) → zoom2 (19.2–23s): the main sentence is already hidden, zoom1 fade out (0.6s) + zoom2 fade in (0.6s) + stagger delay (0.2s+) = approximately 1 second of pure blank screen. The audience thinks the animation has frozen.

**Rules**:
- When switching scenes continuously, fade out and fade in must **cross-overlap** — not the previous one fully disappearing before the next begins
  ```js
  // Bad:
  if (t >= 19) hideZoom('zoom1');      // 19.0s out
  if (t >= 19.4) showZoom('zoom2');    // 19.4s in → 0.4s blank in between

  // Good:
  if (t >= 18.6) hideZoom('zoom1');    // start fade out 0.4s early
  if (t >= 18.6) showZoom('zoom2');    // fade in simultaneously (cross-fade)
  ```
- Or use an "anchor element" (such as the main sentence) as a visual connector between scenes — briefly reappear during the zoom switch
- Calculate CSS transition durations carefully; avoid triggering the next transition before the current one finishes

## 5. Pure Render Principle — Animation State Should Be Seekable

**The pitfall**: Using `setTimeout` + `fireOnce(key, fn)` chained to trigger animation states. Normal playback is fine, but when doing frame-by-frame recording or seeking to an arbitrary time point, the previous setTimeouts have already fired and there is no way to "go back to the past".

**Rules**:
- The `render(t)` function should ideally be a **pure function**: given t, output a unique DOM state
- If side effects are necessary (e.g. class switching), use a `fired` set with explicit reset:
  ```js
  const fired = new Set();
  function fireOnce(key, fn) { if (!fired.has(key)) { fired.add(key); fn(); } }
  function reset() { fired.clear(); /* clear all .show classes */ }
  ```
- Expose `window.__seek(t)` for Playwright / debugging:
  ```js
  window.__seek = (t) => { reset(); render(t); };
  ```
- Animation-related setTimeouts should not span >1 second; otherwise things break when seeking back

## 6. Measuring Before Font Load = Measuring Wrong

**The pitfall**: `charRect(idx)` was called to measure bracket positions on DOMContentLoaded, before fonts had loaded. Every character's width was the fallback font's width, so all positions were wrong. Once the font loaded (~500ms later), the bracket `left: Xpx` still had the old value — permanently offset.

**Rules**:
- Any layout code relying on DOM measurement (`getBoundingClientRect`, `offsetWidth`) **must** be wrapped in `document.fonts.ready.then()`
  ```js
  document.fonts.ready.then(() => {
    requestAnimationFrame(() => {
      buildBrackets(...);  // fonts are ready now, measurement is accurate
      tick();              // animation starts
    });
  });
  ```
- The extra `requestAnimationFrame` gives the browser one frame to commit layout
- If using Google Fonts CDN, add `<link rel="preconnect">` to speed up the first load

## 7. Recording Preparation — Leave Handles for Video Export

**The pitfall**: Playwright `recordVideo` defaults to 25fps and starts recording from context creation. The first 2 seconds of page loading and font loading are recorded. The delivered video has 2 seconds of blank/white flash at the start.

**Rules**:
- Provide a `render-video.js` tool to handle: warmup navigate → reload to restart animation → wait for duration → ffmpeg trim head + convert to H.264 MP4
- **Frame 0** of the animation must be the complete initial state with final layout already in place (not blank or loading)
- Want 60fps? Use ffmpeg `minterpolate` in post-processing; don't rely on the browser's source frame rate
- Want GIF? Two-phase palette (`palettegen` + `paletteuse`); for a 30s 1080p animation this can compress to 3MB

See `video-export.md` for complete script invocation instructions.

## 8. Batch Export — tmp Directories Must Include PID to Prevent Concurrent Conflicts

**The pitfall**: Running `render-video.js` in 3 parallel processes to record 3 HTML files. Because TMP_DIR was named with only `Date.now()`, 3 processes started at the same millisecond shared the same tmp directory. The first process to finish cleaned up tmp; the other two got `ENOENT` when reading the directory and all crashed.

**Rules**:
- Any temporary directory that may be shared by multiple processes must include **PID or a random suffix** in its name:
  ```js
  const TMP_DIR = path.join(DIR, '.video-tmp-' + Date.now() + '-' + process.pid);
  ```
- If you actually want parallel multi-file processing, use shell `&` + `wait` rather than forking inside a single Node script
- When batch-recording multiple HTML files, the conservative approach is **serial** execution (up to 2 can run in parallel; 3 or more should queue up)

## 9. Progress Bar / Replay Button Visible in Recording — Chrome Elements Polluting the Video

**The pitfall**: The animation HTML added a `.progress` progress bar, `.replay` replay button, and `.counter` timestamp for human debugging. When rendered to MP4 for delivery, these elements appear at the bottom of the video — as if the developer tools were captured in the recording.

**Rules**:
- Separate "chrome elements" intended for humans (progress bar / replay button / footer / masthead / counter / phase labels) from the video content itself
- **Use the class name convention** `.no-record`: any element with this class is automatically hidden by the recording script
- The script-side (`render-video.js`) injects CSS to hide common chrome class names by default:
  ```
  .progress .counter .phases .replay .masthead .footer .no-record [data-role="chrome"]
  ```
- Inject using Playwright's `addInitScript` (takes effect before every navigate, stable through reloads)
- To see the original HTML (with chrome), add the `--keep-chrome` flag

## 10. Animation Repeats at the Start of the Recording — Warmup Frame Leak

**The pitfall**: The old `render-video.js` flow was `goto → wait fonts 1.5s → reload → wait duration`. Recording started from context creation; the warmup phase had already played part of the animation, then reload restarted from 0. The result: the first few seconds of video are "animation mid-run + switch + animation starting from 0" — a strong repetition effect.

**Rules**:
- **Warmup and Record must use separate contexts**:
  - Warmup context (no `recordVideo` option): only responsible for loading the URL, waiting for fonts, then closing
  - Record context (with `recordVideo`): starts fresh; animation begins recording from t=0
- ffmpeg `-ss trim` can only cut out a little Playwright startup latency (~0.3s) — **it cannot** be used to cover up warmup frames; the source must be clean
- Closing the record context = the webm file is written to disk — this is a Playwright constraint
- Related code pattern:
  ```js
  // Phase 1: warmup (throwaway)
  const warmupCtx = await browser.newContext({ viewport });
  const warmupPage = await warmupCtx.newPage();
  await warmupPage.goto(url, { waitUntil: 'networkidle' });
  await warmupPage.waitForTimeout(1200);
  await warmupCtx.close();

  // Phase 2: record (fresh)
  const recordCtx = await browser.newContext({ viewport, recordVideo });
  const page = await recordCtx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(DURATION * 1000);
  await page.close();
  await recordCtx.close();
  ```

## 11. Don't Draw "Fake Chrome" On-Screen — Decorative Player UI Clashes With Real Chrome

**The pitfall**: The animation uses a `Stage` component which already includes scrubber + timecode + pause button (part of `.no-record` chrome, automatically hidden on export). I also drew a "magazine page number style decorative progress bar" — `00:60 ──── CLAUDE-DESIGN / ANATOMY` — at the bottom of the canvas, feeling proud of it. **Result**: users saw two progress bars — one from the Stage controller, one from my decoration. Visually they collided completely, triggering a bug report. "Why is there another progress bar inside the video?"

**Rules**:

- Stage already provides: scrubber + timecode + pause/replay buttons. **Do not draw** progress indicators, current timecodes, copyright attribution bars, or chapter counters inside the canvas — they either clash with chrome or are just filler slop (violating the "earn its place" principle).
- "Page number feel", "magazine feel", "bottom attribution bar" — these **decorative impulses** are high-frequency filler automatically added by AI. Every time one appears, be suspicious — does it really convey irreplaceable information? Or is it simply filling empty space?
- If you genuinely believe a bottom bar must exist (e.g. the animation's theme is literally about a player UI), it must be **narratively necessary** and **visually distinct from the Stage scrubber** (different position, different form, different colour tone).

**Element ownership test** (every element drawn onto the canvas must be able to answer):

| It belongs to | Action |
|------------|------|
| The narrative content of a specific scene | OK, keep it |
| Global chrome (control/debug use) | Add `.no-record` class, hidden on export |
| **Neither any scene nor chrome** | **Delete.** This is an ownerless element — it is necessarily filler slop |

**Self-check (3 seconds before delivery)**: Take a static screenshot and ask yourself:

- Is there anything in the frame that "looks like video player UI" (horizontal progress bar, timecode, control button shapes)?
- If there is, would removing it harm the narrative? If not, delete it.
- Is the same type of information (progress / time / attribution) appearing twice? Consolidate it into one chrome location.

**Counter-examples**: Drawing `00:42 ──── PROJECT NAME` at the bottom, drawing a "CH 03 / 06" chapter counter in the lower-right corner, drawing version number "v0.3.1" at the edge of the frame — all fake chrome filler.

## 12. Pre-recording Blank + Recording Start Offset — The `__ready` × tick × lastTick Triple Trap

**The pitfall (A — pre-recording blank)**: Exporting a 60-second animation to MP4; the first 2–3 seconds are blank. `ffmpeg --trim=0.3` cannot remove them.

**The pitfall (B — start offset, real incident 2026-04-20)**: Exporting a 24-second video, but the user's experience is "the video only starts playing the first frame at 19 seconds". In reality, the animation started recording at t=5, recorded to t=24, then looped back to t=0, then recorded 5 more seconds to end — so the last 5 seconds of the video are actually the true beginning of the animation.

**Root cause** (shared by both pitfalls):

Playwright `recordVideo` starts writing WebM from the moment `newContext()` is called, while Babel/React/font loading takes L seconds (2–6s). The recording script waits for `window.__ready = true` as the anchor for "animation starts here" — it must be strictly paired with animation `time = 0`. Two common mistakes:

| Mistake | Symptom |
|------|------|
| `__ready` set during `useEffect` or synchronous setup (before the first tick frame) | The recording script thinks the animation has started, but the WebM is still recording a blank page → **pre-recording blank** |
| tick's `lastTick = performance.now()` initialised **at the top level of the script** | Font loading of L seconds is counted into the first frame's `dt`; `time` instantly jumps to L → the entire recording is offset by L seconds → **start offset** |

**Correct complete starter tick template** (must use this skeleton for handwritten animations):

```js
// ━━━━━━ state ━━━━━━
let time = 0;
let playing = false;   // ❗ don't play by default; start after fonts are ready
let lastTick = null;   // ❗ sentinel — force dt to 0 on the first tick frame (don't use performance.now())
const fired = new Set();

// ━━━━━━ tick ━━━━━━
function tick(now) {
  if (lastTick === null) {
    lastTick = now;
    window.__ready = true;   // ✅ paired: "recording start" and "animation t=0" are the same frame
    render(0);               // render once more to ensure DOM is ready (fonts are ready now)
    requestAnimationFrame(tick);
    return;
  }
  const dt = (now - lastTick) / 1000;   // dt only starts advancing after the first frame
  lastTick = now;

  if (playing) {
    let t = time + dt;
    if (t >= DURATION) {
      t = window.__recording ? DURATION - 0.001 : 0;  // don't loop during recording; keep 0.001s to preserve final frame
      if (!window.__recording) fired.clear();
    }
    time = t;
    render(time);
  }
  requestAnimationFrame(tick);
}

// ━━━━━━ boot ━━━━━━
// Don't rAF immediately at the top level — wait for fonts to load before starting
document.fonts.ready.then(() => {
  render(0);                 // draw the initial frame first (fonts are ready)
  playing = true;
  requestAnimationFrame(tick);  // the first tick will pair __ready + t=0
});

// ━━━━━━ seek interface (for render-video defensive correction) ━━━━━━
window.__seek = (t) => { fired.clear(); time = t; lastTick = null; render(t); };
```

**Why this template is correct**:

| Step | Why it must be this way |
|------|-------------|
| `lastTick = null` + first frame `return` | Prevents the L seconds from "script load to first tick execution" from being counted into animation time |
| `playing = false` by default | During font loading, even if `tick` runs, time does not advance — avoids render misalignment |
| `__ready` set in the first tick frame | The recording script starts timing from this moment, corresponding to the animation's true t=0 |
| `document.fonts.ready.then(...)` before starting tick | Avoids fallback font width measurements and avoids first-frame font jumping |
| `window.__seek` exists | Lets `render-video.js` proactively correct — a second line of defence |

**Corresponding defences on the recording script side**:
1. `addInitScript` injects `window.__recording = true` (before page goto)
2. `waitForFunction(() => window.__ready === true)`, record this offset for ffmpeg trim
3. **Additionally**: after `__ready`, proactively run `page.evaluate(() => window.__seek && window.__seek(0))` to force any time offset in the HTML back to zero — this is the second line of defence, handling HTML that does not strictly follow the starter template

**Verification method**: After exporting MP4:
```bash
ffmpeg -i video.mp4 -ss 0 -vframes 1 frame-0.png
ffmpeg -i video.mp4 -ss $DURATION-0.1 -vframes 1 frame-end.png
```
The first frame must be the animation's t=0 initial state (not mid-run, not black). The final frame must be the animation's end state (not a moment in a second loop).

**Reference implementation**: The Stage component in `assets/animations.jsx` and `scripts/render-video.js` both implement this protocol. Handwritten HTML must follow the starter tick template — every line guards against a specific real bug.

## 13. Prohibit Loop During Recording — `window.__recording` Signal

**The pitfall**: The animation Stage defaults to `loop=true` (convenient for viewing in the browser). `render-video.js` waits an extra 300ms buffer after the duration before stopping; this 300ms lets Stage enter the next loop cycle. When ffmpeg `-t DURATION` trims, the last 0.5–1s falls into the next cycle — the video ending suddenly jumps back to the first frame (Scene 1), making the audience think the video has a bug.

**Root cause**: There is no "I am recording" handshake protocol between the recording script and the HTML. The HTML doesn't know it's being recorded and continues looping as in a browser interaction scenario.

**Rules**:

1. **Recording script**: Inject `window.__recording = true` in `addInitScript` (before page goto):
   ```js
   await recordCtx.addInitScript(() => { window.__recording = true; });
   ```

2. **Stage component**: Recognise this signal and force loop=false:
   ```js
   const effectiveLoop = (typeof window !== 'undefined' && window.__recording) ? false : loop;
   // ...
   if (next >= duration) return effectiveLoop ? 0 : duration - 0.001;
   //                                                       ↑ keep 0.001 to prevent Sprite end=duration from being closed
   ```

3. **Ending Sprite's fadeOut**: In recording mode, this should be set to `fadeOut={0}`; otherwise the end of the video fades to transparent/dark — users expect to stop on a clear final frame, not a fade out. It is recommended to always use `fadeOut={0}` for ending Sprites in handwritten HTML.

**Reference implementation**: The Stage in `assets/animations.jsx` and `scripts/render-video.js` both have the handshake built in. Handwritten Stage must implement `__recording` detection — otherwise recording will always hit this pitfall.

**Verification**: After exporting MP4, run `ffmpeg -ss 19.8 -i video.mp4 -frames:v 1 end.png` and check that the last 0.2 seconds is still the expected final frame, with no sudden switch to another scene.

## 14. 60fps Video Defaults to Frame Duplication — minterpolate Has Poor Compatibility

**The pitfall**: `convert-formats.sh` using `minterpolate=fps=60:mi_mode=mci...` to generate 60fps MP4 — the output cannot be opened in some versions of macOS QuickTime / Safari (pure black or direct rejection). VLC / Chrome can open it.

**Root cause**: The H.264 elementary stream output by minterpolate contains SEI / SPS fields that some players have issues parsing.

**Rules**:

- Default 60fps uses the simple `fps=60` filter (frame duplication) — broadly compatible (QuickTime / Safari / Chrome / VLC can all open it)
- High-quality frame interpolation uses the `--minterpolate` flag when explicitly enabled — but **must be tested locally** against the target player before delivery
- The value of a 60fps label is **algorithm recognition on upload platforms** (Bilibili / YouTube prioritise 60fps streams); for CSS animations, actual perceived smoothness improvement is minimal
- Add `-profile:v high -level 4.0` to improve H.264 general compatibility

**`convert-formats.sh` has already been changed to compatibility mode by default.** If you need high-quality frame interpolation, add the `--minterpolate` flag:
```bash
bash convert-formats.sh input.mp4 --minterpolate
```

## 15. `file://` + External `.jsx` CORS Trap — Single-File Delivery Must Inline the Engine

**The pitfall**: The animation HTML uses `<script type="text/babel" src="animations.jsx"></script>` to load the engine externally. Opening locally by double-clicking (`file://` protocol) → Babel Standalone uses XHR to fetch the `.jsx` → Chrome reports `Cross origin requests are only supported for protocol schemes: http, https, chrome, chrome-extension...` → entire page black screen. This doesn't trigger `pageerror`, only a console error — easy to misdiagnose as "animation not triggered".

Starting an HTTP server may not save it either — when the local machine has a global proxy, `localhost` can also go through the proxy and return 502 / connection failure.

**Rules**:

- **Single-file delivery (HTML that works by double-clicking)** → `animations.jsx` must be **inlined** inside a `<script type="text/babel">...</script>` tag; do not use `src="animations.jsx"`
- **Multi-file project (demo with an HTTP server)** → external loading is fine, but clearly document the `python3 -m http.server 8000` command at delivery
- Deciding factor: is what you're delivering to the user "an HTML file" or "a project directory with a server"? Use inline for the former
- The Stage component / animations.jsx is often 200+ lines — pasting it into an HTML `<script>` block is completely acceptable; don't worry about size

**Minimum verification**: Double-click your generated HTML — **do not** open it through any server. Only if Stage correctly displays the animation's first frame does it pass.

## 16. Cross-Scene Inverted Colour Context — Elements Inside the Canvas Must Not Hard-Code Colours

**The pitfall**: In a multi-scene animation, elements that appear **across all scenes** — `ChapterLabel` / `SceneNumber` / `Watermark` etc. — have `color: '#1A1A1A'` (dark text) hard-coded in the component. The first 4 scenes with light backgrounds are fine; in the 5th dark-background scene, "05" and the watermark simply disappear — no error, no check triggered, key information invisible.

**Rules**:

- **Canvas elements reused across multiple scenes** (chapter labels / scene numbers / timecodes / watermarks / copyright bars) **must not have hard-coded colour values**
- Use one of three approaches instead:
  1. **`currentColor` inheritance**: the element only has `color: currentColor`; the parent scene container sets `color: computed-value`
  2. **invert prop**: the component accepts `<ChapterLabel invert />` to manually switch between light and dark
  3. **Auto-calculate from background colour**: `color: contrast-color(var(--scene-bg))` (CSS Level 4 new API, or JS-based detection)
- Before delivery, use Playwright to extract **a representative frame from each scene** and manually scan that "cross-scene elements" are all visible

The insidious nature of this pitfall is — **there is no bug alert**. Only human eyes or OCR can detect it.

## Quick Self-Check List (5 Seconds Before Starting Work)

- [ ] Does every `position: absolute` element's parent have `position: relative`?
- [ ] Do all special characters in the animation (`␣` `⌘` `emoji`) exist in the font?
- [ ] Does the Grid/Flex template count match the JS data length?
- [ ] Is there a cross-fade between scene switches, with no >0.3s pure blank period?
- [ ] Is DOM measurement code wrapped in `document.fonts.ready.then()`?
- [ ] Is `render(t)` pure, or is there a clear reset mechanism?
- [ ] Is frame 0 a complete initial state, not blank?
- [ ] Is there no "fake chrome" decoration on screen (progress bars / timecodes / bottom attribution bars clashing with the Stage scrubber)?
- [ ] Does the animation tick set `window.__ready = true` synchronously on the first frame? (Built into animations.jsx; handwritten HTML must add it manually)
- [ ] Does Stage detect `window.__recording` and force loop=false? (Mandatory for handwritten HTML)
- [ ] Is the ending Sprite's `fadeOut` set to 0 (video ends on a clear final frame)?
- [ ] Does 60fps MP4 default to frame duplication mode (compatibility), with `--minterpolate` only for high-quality frame interpolation?
- [ ] After export, did you extract frame 0 + final frame and verify they are the animation's initial/final state?
- [ ] Involving a specific brand (Stripe/Anthropic/Lovart/...): have you completed the "brand assets protocol" (SKILL.md §1.a five steps)? Is there a `brand-spec.md`?
- [ ] For single-file delivery HTML: is `animations.jsx` inlined, not `src="..."`? (External .jsx under file:// causes CORS black screen)
- [ ] Do elements appearing across scenes (chapter labels / watermarks / scene numbers) have no hard-coded colours? Are they visible against every scene's background?
