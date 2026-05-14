# Verification: Output Validation Process

Some native design-agent environments (e.g. Claude.ai Artifacts) have a built-in `fork_verifier_agent` that spawns a subagent to check using iframe screenshots. In most agent environments (Claude Code / Codex / Cursor / Trae / etc.) this built-in capability doesn't exist — using Playwright manually covers the same verification scenarios.

## Verification Checklist

After producing HTML, run through this checklist:

### 1. Browser Rendering Check (Required)

Most basic: **can the HTML open?** On macOS:

```bash
open -a "Google Chrome" "/path/to/your/design.html"
```

Or use a Playwright screenshot (next section).

### 2. Console Error Check

The most common problem in HTML files is a JS error causing a white screen. Run through it with Playwright:

```bash
python ~/.claude/skills/claude-design/scripts/verify.py path/to/design.html
```

This script will:
1. Open the HTML with headless Chromium
2. Save a screenshot to the project directory
3. Capture console errors
4. Report status

See `scripts/verify.py` for details.

### 3. Multi-Viewport Check

For responsive designs, capture multiple viewports:

```bash
python verify.py design.html --viewports 1920x1080,1440x900,768x1024,375x667
```

### 4. Interaction Check

Tweaks, animations, button toggles — static screenshots won't reveal these. **Recommended: have the user open it in a browser and click through it**, or use Playwright screen recording:

```python
page.video.record('interaction.mp4')
```

### 5. Slide-by-Slide Check

For deck-type HTML, capture each slide:

```bash
python verify.py deck.html --slides 10  # captures first 10 slides
```

Generates `deck-slide-01.png`, `deck-slide-02.png`... for quick review.

## Playwright Setup

First-time use requires:

```bash
# If not installed yet
npm install -g playwright
npx playwright install chromium

# Or the Python version
pip install playwright
playwright install chromium
```

If the user already has Playwright installed globally, use it directly.

## Screenshot Best Practices

### Full-page screenshot

```python
page.screenshot(path='full.png', full_page=True)
```

### Viewport screenshot

```python
page.screenshot(path='viewport.png')  # captures visible area only (default)
```

### Screenshot of a specific element

```python
element = page.query_selector('.hero-section')
element.screenshot(path='hero.png')
```

### High-DPI screenshot

```python
page = browser.new_page(device_scale_factor=2)  # retina
```

### Wait for animation to finish before capturing

```python
page.wait_for_timeout(2000)  # wait 2s for animation to settle
page.screenshot(...)
```

## Sending Screenshots to the User

### Open local screenshot directly

```bash
open screenshot.png
```

The user will see it in their Preview / Figma / VSCode / browser.

### Upload to an image host and share the link

For remote collaboration (e.g. Slack / Feishu / WeChat), have the user use their own image host tool or MCP to upload:

```bash
python ~/Documents/writing/tools/upload_image.py screenshot.png
```

Returns a permanent ImgBB link that can be pasted anywhere.

## When Verification Fails

### White screen

The console will definitely have errors. Check:

1. Are the React+Babel script tag integrity hashes correct? (see `react-setup.md`)
2. Is there a `const styles = {...}` naming conflict?
3. Are cross-file components exported to `window`?
4. JSX syntax error (babel.min.js doesn't always surface errors — switch to non-minified babel.js for clearer messages)

### Animation is choppy

- Record a clip with Chrome DevTools Performance tab
- Look for layout thrashing (frequent reflows)
- Prefer `transform` and `opacity` for animations (GPU accelerated)

### Wrong font

- Check that `@font-face` URLs are accessible
- Check fallback fonts
- CJK fonts load slowly: show fallback first, switch when loaded

### Layout is misaligned

- Check that `box-sizing: border-box` is applied globally
- Check for `* { margin: 0; padding: 0; }` reset
- Open gridlines in Chrome DevTools to see actual layout

## Verification = The Designer's Second Pair of Eyes

**Always do your own pass.** When AI writes code, common issues include:

- Looks correct but interaction has a bug
- Static screenshot looks fine but layout breaks on scroll
- Wide screen looks great but narrow screen breaks
- Dark mode wasn't tested
- Some components don't respond when Tweaks are switched

**The last 1 minute of verification can save 1 hour of rework.**

## Common Verification Script Commands

```bash
# Basic: open + screenshot + capture errors
python verify.py design.html

# Multiple viewports
python verify.py design.html --viewports 1920x1080,375x667

# Multiple slides
python verify.py deck.html --slides 10

# Output to specific directory
python verify.py design.html --output ./screenshots/

# headless=false, opens real browser so you can see it
python verify.py design.html --show
```
