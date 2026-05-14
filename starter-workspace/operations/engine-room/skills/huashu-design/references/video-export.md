# Video Export: HTML Animation to MP4/GIF

After completing an animated HTML, users often ask "can this be exported as video?" This guide covers the full workflow.

## When to Export

**Export timing**:
- Animation runs completely and has been visually verified (Playwright screenshots confirm correct state at key timestamps)
- User has watched it in a browser at least once and confirmed the effect is good
- **Do not** export while animation bugs are still unresolved — fixing things after export to video is more expensive

**Trigger phrases users might say**:
- "Can this be exported as video?"
- "Convert to MP4"
- "Make it a GIF"
- "60fps"

## Output Specs

Default: deliver three formats at once and let the user choose:

| Format | Specs | Best For | Typical Size (30s) |
|---|---|---|---|
| MP4 25fps | 1920×1080 · H.264 · CRF 18 | WeChat article embed, video channels, YouTube | 1-2 MB |
| MP4 60fps | 1920×1080 · minterpolate frame interpolation · H.264 · CRF 18 | High frame-rate showcase, Bilibili, portfolio | 1.5-3 MB |
| GIF | 960×540 · 15fps · palette optimized | Twitter/X, README, Slack preview | 2-4 MB |

## Toolchain

Two scripts in `scripts/`:

### 1. `render-video.js` — HTML to MP4

Records a 25fps MP4 base version. Requires globally installed playwright.

```bash
NODE_PATH=$(npm root -g) node /path/to/claude-design/scripts/render-video.js <html-file>
```

Optional parameters:
- `--duration=30` animation duration (seconds)
- `--width=1920 --height=1080` resolution
- `--trim=2.2` seconds to trim from the start (removes reload + font loading time)
- `--fontwait=1.5` font loading wait time (seconds); increase when using many fonts

Output: same directory as HTML, same name with `.mp4` extension.

### 2. `add-music.sh` — MP4 + BGM to MP4

Mixes background music into a silent MP4 — selects from the built-in BGM library by scene (mood), or you can supply your own audio. Automatically matches duration and adds fade in/out.

```bash
bash add-music.sh <input.mp4> [--mood=<name>] [--music=<path>] [--out=<path>]
```

**Built-in BGM library** (in `assets/bgm-<mood>.mp3`):

| `--mood=` | Style | Best Fit |
|-----------|-------|---------|
| `tech` (default) | Apple Silicon / Apple keynote style, minimal synth + piano | Product launch, AI tools, skill promo |
| `ad` | Upbeat modern electronic with build + drop | Social media ads, product trailers, promo reels |
| `educational` | Warm and bright, light guitar/electric piano, inviting | Science explainers, tutorial intros, course previews |
| `educational-alt` | Same category, alternate track | Same as above |
| `tutorial` | Lo-fi ambient, almost inaudible | Software demos, coding tutorials, long walkthroughs |
| `tutorial-alt` | Same category, alternate track | Same as above |

**Behavior**:
- Music is trimmed to video duration
- 0.3s fade-in + 1s fade-out (avoids hard cut)
- Video stream uses `-c:v copy` (no re-encoding); audio AAC 192k
- `--music=<path>` takes priority over `--mood`; any external audio can be specified directly
- Passing an invalid mood name lists all available options — no silent failure

**Typical pipeline** (animation export three-step + music):
```bash
node render-video.js animation.html                        # screen record
bash convert-formats.sh animation.mp4                      # derive 60fps + GIF
bash add-music.sh animation-60fps.mp4                      # add default tech BGM
# Or for specific scenes:
bash add-music.sh tutorial-demo.mp4 --mood=tutorial
bash add-music.sh product-promo.mp4 --mood=ad --out=promo-final.mp4
```

### 3. `convert-formats.sh` — MP4 to 60fps MP4 + GIF

Generates a 60fps version and GIF from an existing MP4.

```bash
bash /path/to/claude-design/scripts/convert-formats.sh <input.mp4> [gif_width] [--minterpolate]
```

Output (same directory as input):
- `<name>-60fps.mp4` — defaults to `fps=60` frame duplication (broad compatibility); add `--minterpolate` to enable high-quality frame interpolation
- `<name>.gif` — palette-optimized GIF (default 960 width, adjustable)

**60fps mode selection**:

| Mode | Command | Compatibility | Use Case |
|---|---|---|---|
| Frame duplication (default) | `convert-formats.sh in.mp4` | QuickTime/Safari/Chrome/VLC all pass | General delivery, platform uploads, social media |
| minterpolate interpolation | `convert-formats.sh in.mp4 --minterpolate` | macOS QuickTime/Safari may refuse playback | Bilibili and other sites needing true interpolation — **must test on target player before delivery** |

Why the default was changed to frame duplication? minterpolate output's H.264 elementary stream has a known compat bug — the previous default of minterpolate caused "macOS QuickTime can't open it" issues multiple times. See `animation-pitfalls.md` §14.

`gif_width` parameter:
- 960 (default) — general social platform use
- 1280 — sharper but larger file
- 600 — Twitter/X fast loading priority

## Full Workflow (Standard Recommendation)

After the user says "export video":

```bash
cd <project-directory>

# Assume $SKILL points to this skill's root directory (adjust to your install location)

# 1. Record 25fps base MP4
NODE_PATH=$(npm root -g) node "$SKILL/scripts/render-video.js" my-animation.html

# 2. Derive 60fps MP4 and GIF
bash "$SKILL/scripts/convert-formats.sh" my-animation.mp4

# Output list:
# my-animation.mp4         (25fps · 1-2 MB)
# my-animation-60fps.mp4   (60fps · 1.5-3 MB)
# my-animation.gif         (15fps · 2-4 MB)
```

## Technical Details (for troubleshooting)

### Playwright recordVideo Caveats

- Frame rate is fixed at 25fps — you cannot record 60fps directly (Chromium headless compositor limit)
- Recording starts as soon as context is created; must use `trim` to cut out the leading load time
- Default format is webm; needs ffmpeg conversion to H.264 MP4 for universal playback

`render-video.js` already handles all of the above.

### ffmpeg minterpolate Parameters

Current config: `minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`

- `mi_mode=mci` — motion compensation interpolation
- `mc_mode=aobmc` — adaptive overlapped block motion compensation
- `me_mode=bidir` — bidirectional motion estimation
- `vsbmc=1` — variable size block motion compensation

Works well for CSS **transform animations** (translate/scale/rotate).
May produce slight ghosting on **pure fades** — if the user objects, fall back to simple frame duplication:

```bash
ffmpeg -i input.mp4 -r 60 -c:v libx264 ... output.mp4
```

### Why GIF palette requires two passes

GIF can only use 256 colors. A single-pass GIF compresses the entire animation's colors into a 256-color universal palette — for subtle palettes like warm beige + orange, the result is muddy.

Two passes:
1. `palettegen=stats_mode=diff` — scans the full video first, generates an **optimal palette specific to this animation**
2. `paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle` — encodes with this palette; rectangle diff only updates changed regions, dramatically reducing file size

`dither=bayer` produces smoother fade transitions than `none`, but slightly larger files.

## Pre-flight Check (Before Export)

30-second self-check before exporting:

- [ ] HTML has run completely in a browser with no console errors
- [ ] Frame 0 is the complete initial state (not a blank loading screen)
- [ ] Final frame is the stable end state (not mid-transition)
- [ ] Fonts / images / emoji all render correctly (see `animation-pitfalls.md`)
- [ ] Duration parameter matches the actual animation duration in the HTML
- [ ] HTML Stage detection `window.__recording` forces loop=false (required for hand-written Stage; `assets/animations.jsx` includes this automatically)
- [ ] Final Sprite has `fadeOut={0}` (last video frame doesn't fade out)
- [ ] "Created by Huashu-Design" watermark included (required for animation scenes only; add "Unofficial production · " prefix for third-party brand work. See SKILL.md § "Skill Promotion Watermark")

## Delivery Note Format

Standard format to give users after export is complete:

```
**Full Delivery**

| File | Format | Specs | Size |
|---|---|---|---|
| foo.mp4 | MP4 | 1920×1080 · 25fps · H.264 | X MB |
| foo-60fps.mp4 | MP4 | 1920×1080 · 60fps (motion interpolated) · H.264 | X MB |
| foo.gif | GIF | 960×540 · 15fps · palette optimized | X MB |

**Notes**
- 60fps uses minterpolate motion estimation; works well for transform animations
- GIF uses palette optimization; 30s animation compresses to ~3MB

Let me know if you need a different size or frame rate.
```

## Common User Follow-up Requests

| User says | Response |
|---|---|
| "Too big" | MP4: increase CRF to 23-28; GIF: reduce resolution to 600 or fps to 10 |
| "GIF is too blurry" | Increase `gif_width` to 1280; or suggest using MP4 instead (WeChat Moments supports it too) |
| "Need vertical 9:16" | Change HTML source `--width=1080 --height=1920` and re-record |
| "Add a watermark" | Add `-vf "drawtext=..."` or `overlay=` a PNG in ffmpeg |
| "Need transparent background" | MP4 doesn't support alpha; use WebM VP9 + alpha or APNG |
| "Need lossless" | Set CRF to 0 + preset veryslow (file will be 10x larger) |
