# Content Guidelines: Anti-AI-Slop, Content Standards, Scale Specifications

The traps that are easiest to fall into with AI design. This is a "what not to do" list — more important than the "what to do" list — because AI slop is the default. If you don't actively avoid it, it will happen.

## AI Slop Complete Blacklist

### Visual Traps

**No aggressive gradient backgrounds**
- Purple → pink → blue full-screen gradient (the signature look of AI-generated web pages)
- Rainbow gradients in any direction
- Mesh gradients filling the background
- If you must use gradients: subtle, monochromatic, intentional accents (e.g. button hover)

**No rounded cards + left border accent color**
```css
/* This is the signature fingerprint of an AI-taste card */
.card {
  border-radius: 12px;
  border-left: 4px solid #3b82f6;
  padding: 16px;
}
```
This card pattern is rampant in AI-generated dashboards. Want to create emphasis? Use more design-considered approaches: background color contrast, weight/size contrast, plain dividers, or simply don't use cards at all.

**No emoji decoration**
Unless the brand itself uses emoji (e.g. Notion, Slack), don't put emoji in the UI. **Especially avoid**:
- 🚀 ⚡️ ✨ 🎯 💡 before headings
- ✅ in feature lists
- → inside CTA buttons (standalone arrow icon is OK, emoji arrow is not)

No icons? Use a real icon library (Lucide/Heroicons/Phosphor), or use a placeholder.

**No SVG imagery**
Do not attempt to draw in SVG: people, scenes, devices, objects, abstract art. AI-generated SVG imagery is immediately recognizable as AI — it looks juvenile and cheap. **A gray rectangle + "Illustration placeholder 1200×800" label text is 100x better than a clumsy SVG hero illustration**.

The only acceptable SVG uses:
- True icons (16×16 to 32×32 size range)
- Geometric shapes as decorative elements
- Charts for data viz

**No excessive iconography**
Not every heading/feature/section needs an icon. Over-using icons makes the interface look like a toy. Less is more.

**No "data slop"**
Fabricated stats as decoration:
- "10,000+ happy customers" (you don't even know if that's true)
- "99.9% uptime" (don't write it without real data)
- Decorative "metric cards" made of icon + number + phrase
- Mock tables full of fake data dressed up elaborately

If you don't have real data, leave a placeholder or ask the user for it.

**No "quote slop"**
Fabricated user testimonials or celebrity quotes decorating the page. Leave a placeholder and ask the user for real quotes.

### Typography Traps

**Avoid these overused fonts**:
- Inter (default in AI-generated web pages)
- Roboto
- Arial / Helvetica
- Pure system font stack
- Fraunces (AI discovered this and overused it)
- Space Grotesk (currently AI's favorite)

**Use distinctive display+body pairings**. Inspiration directions:
- Serif display + sans-serif body (editorial feel)
- Mono display + sans body (technical feel)
- Heavy display + light body (contrast)
- Variable font for weight animation in hero

Font resources:
- Lesser-known quality options on Google Fonts (Instrument Serif, Cormorant, Bricolage Grotesque, JetBrains Mono)
- Open-source font sites (Fraunces sibling fonts, Adobe Fonts)
- Never invent font names from scratch

### Color Traps

**No inventing colors from scratch**
Don't design a whole unfamiliar color palette from zero. It usually isn't harmonious.

**Strategy**:
1. Brand colors exist → use brand colors; fill missing color tokens with oklch interpolation
2. No brand colors but have a reference → extract colors from reference product screenshots
3. Starting completely from zero → pick a known color system (Radix Colors / Tailwind default palette / Anthropic brand), don't invent your own

**Defining colors with oklch** is the most modern approach:
```css
:root {
  --primary: oklch(0.65 0.18 25);      /* warm terracotta */
  --primary-light: oklch(0.85 0.08 25); /* same hue, lighter */
  --primary-dark: oklch(0.45 0.20 25);  /* same hue, darker */
}
```
oklch ensures hue doesn't drift when adjusting lightness — better than hsl.

**No casually inverted dark mode**
It's not simply inverting colors. Good dark mode requires re-calibrating saturation, contrast, and accent colors. If you don't want to do dark mode properly, don't do it at all.

### Layout Traps

**No bento grid overuse**
Every AI-generated landing page wants a bento. Unless your information structure actually suits a bento layout, use something else.

**No large hero + 3-column features + testimonials + CTA**
This landing page template is worn out. If you want to innovate, actually innovate.

**No card grids where every card looks identical**
Asymmetric, varying card sizes, some with images and some text-only, some spanning columns — that's what real designer work looks like.

## Content Standards

### 1. Don't add filler content

Every element must earn its place. Whitespace is a design problem — solve it with **composition** (contrast, rhythm, breathing room), **not** by filling space with content.

**Questions to identify filler**:
- If you remove this content, does the design get worse? If the answer is "no," remove it.
- What real problem does this element solve? If the answer is "makes the page less empty," delete it.
- Does this stat/quote/feature have real data backing it? If not, don't fabricate it.

"One thousand no's for every yes."

### 2. Ask before adding material

Think adding a section / page / block would make it better? Ask the user first — don't add it unilaterally.

Why:
- The user knows their audience better than you do
- Adding content has a cost; the user may not want it
- Unilaterally adding content violates the "junior designer reporting to manager" relationship

### 3. Create a system up front

After exploring the design context, **verbally state the system you're going to use** and let the user confirm:

```markdown
My design system:
- Colors: #1A1A1A primary + #F0EEE6 background + #D97757 accent (from your brand)
- Typefaces: Instrument Serif for display + Geist Sans for body
- Rhythm: section titles use full-bleed colored background + white text; regular sections use white background
- Images: hero uses full-bleed photo, feature sections use placeholder until you provide images
- Maximum 2 background colors to avoid clutter

Confirm this direction and I'll start.
```

Wait for the user to confirm before starting. This check-in prevents "half done and realizing the direction is wrong."

## Scale Specifications

### Slides (1920×1080)

- Body text minimum **24px**, ideal 28-36px
- Headings 60-120px
- Section title 80-160px
- Hero headline can use 180-240px large type
- Never use text smaller than 24px on slides

### Print Documents

- Body text minimum **10pt** (approx 13.3px), ideal 11-12pt
- Headings 18-36pt
- Captions 8-9pt

### Web and Mobile

- Body text minimum **14px** (16px for accessibility)
- Mobile body text **16px** (avoids iOS auto-zoom)
- Hit targets (clickable elements) minimum **44×44px**
- Line height 1.5-1.7 (Chinese text 1.7-1.8)

### Contrast

- Body text vs background **at least 4.5:1** (WCAG AA)
- Large text vs background **at least 3:1**
- Check with Chrome DevTools accessibility tool

## CSS Power Features

**Advanced CSS features** are a designer's friend — use them boldly:

### Typography

```css
/* More natural headline line breaks — no orphan words at end of line */
h1, h2, h3 { text-wrap: balance; }

/* Body text line breaks — avoids widows and orphans */
p { text-wrap: pretty; }

/* CJK typography: punctuation compression, line-start/end control */
p {
  text-spacing-trim: space-all;
  hanging-punctuation: first;
}
```

### Layout

```css
/* CSS Grid + named areas = maximum readability */
.layout {
  display: grid;
  grid-template-areas:
    "header header"
    "sidebar main"
    "footer footer";
  grid-template-columns: 240px 1fr;
  grid-template-rows: auto 1fr auto;
}

/* Subgrid for aligning card content */
.card { display: grid; grid-template-rows: subgrid; }
```

### Visual Effects

```css
/* Designed scrollbar */
* { scrollbar-width: thin; scrollbar-color: #666 transparent; }

/* Glassmorphism (use sparingly) */
.glass {
  backdrop-filter: blur(20px) saturate(150%);
  background: color-mix(in oklch, white 70%, transparent);
}

/* View Transitions API for smooth page changes */
@view-transition { navigation: auto; }
```

### Interaction

```css
/* :has() selector makes conditional styles easy */
.card:has(img) { padding-top: 0; } /* cards with images get no top padding */

/* container queries for truly responsive components */
@container (min-width: 500px) { ... }

/* new color-mix function */
.button:hover {
  background: color-mix(in oklch, var(--primary) 85%, black);
}
```

## Decision Quick Reference: When You're Unsure

- Want to add a gradient? → Probably don't
- Want to add an emoji? → Don't
- Want rounded card + border-left accent? → Don't; find another approach
- Want to draw an SVG hero illustration? → Don't; use a placeholder
- Want to add a decorative quote? → Ask the user if they have a real quote first
- Want to add a row of icon features? → Ask first whether icons are even needed; probably not
- Using Inter? → Switch to something more distinctive
- Using purple gradient? → Switch to a color choice with real reasoning

**When you feel "adding this would look better" — that's usually a sign of AI slop**. Start with the simplest version; only add when the user asks for it.
