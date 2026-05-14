<sub>🌐 <a href="README.en.md">English</a> · <b>Chinese</b></sub>

<div align="center">

# Huashu Design

> *"Type. Hit enter. A finished design lands in your lap."*

[![License](https://img.shields.io/badge/License-Personal%20Use%20Only-orange.svg)](LICENSE)
[![Agent-Agnostic](https://img.shields.io/badge/Agent-Agnostic-blueviolet)](https://skills.sh)
[![Skills](https://img.shields.io/badge/skills.sh-Compatible-green)](https://skills.sh)

<br>

**Say one sentence in your agent, get back a deliverable design.**

<br>

In 3 to 30 minutes, you can ship a **product launch animation**, a clickable App prototype, an editable slide deck, or a print-quality infographic.

Not "pretty good for AI" quality — quality that looks like it came from a big-company design team. Give the skill your brand assets (logo, colour palette, UI screenshots) and it reads your brand sensibility; give it nothing and the built-in library of 20 design philosophies will still keep output well clear of AI slop.

**Every animation you see in this README was made by huashu-design itself.** Not Figma, not AE — just a one-line prompt and the skill running end to end. Need a promo video for your next product launch? Now you can make one too.

```
npx skills add alchaincyf/huashu-design
```

Works across agents — Claude Code, Cursor, Codex, OpenClaw, Hermes all supported.

[See demos](#demo-gallery) · [Install](#install-and-go) · [What it can do](#what-it-can-do) · [Core mechanics](#core-mechanics) · [Relationship to Claude Design](#relationship-to-claude-design)

</div>

---

<p align="center">
  <img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/hero-animation-v10-en.gif" alt="huashu-design Hero · Type → Choose direction → Gallery ripple → Focus → Brand reveal" width="100%">
</p>

<p align="center"><sub>
  ▲ 25 sec · Terminal → 4 directions → Gallery ripple → 4× Focus → Brand reveal<br>
  👉 <a href="https://www.huasheng.ai/huashu-design-hero/">View the interactive HTML version with sound effects</a> ·
  <a href="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/hero-animation-v10-en.mp4">Download MP4 (with BGM+SFX · 10MB)</a>
</sub></p>

---

## Install and Go

```bash
npx skills add alchaincyf/huashu-design
```

Then just talk to Claude Code directly:

```
"Make a presentation deck on AI psychology, suggest 3 style directions for me to choose from"
"Build an AI Pomodoro timer iOS prototype with 4 core screens that are actually clickable"
"Turn this logic into a 60-second animation, export MP4 and GIF"
"Do a 5-dimension expert critique of this design"
```

No buttons, no panels, no Figma plugins.

---

## Star History

<p align="center">
  <a href="https://star-history.com/#alchaincyf/huashu-design&Date">
    <img src="https://api.star-history.com/svg?repos=alchaincyf/huashu-design&type=Date" alt="huashu-design Star History" width="80%">
  </a>
</p>

---

## What It Can Do

| Capability | Deliverable | Typical time |
|------------|-------------|-------------|
| Interactive prototype (App / Web) | Single-file HTML · Accurate iPhone bezel · Clickable · Playwright-verified | 10–15 min |
| Presentation slides | HTML deck (browser presentation) + editable PPTX (text boxes preserved) | 15–25 min |
| Timeline animation | MP4 (25fps / 60fps interpolated) + GIF (palette optimised) + BGM | 8–12 min |
| Design variants | 3+ side-by-side comparisons · Tweaks live parameter adjustment · Cross-dimension exploration | 10 min |
| Infographic / visualisation | Print-quality layout · Exportable as PDF/PNG/SVG | 10 min |
| Design direction advisor | 5 schools × 20 design philosophies · Recommends 3 directions · Parallel demo generation | 5 min |
| 5-dimension expert critique | Radar chart + Keep/Fix/Quick Wins · Actionable fix list | 3 min |

---

## Demo Gallery

### Design Direction Advisor

The fallback when requirements are vague: pick 3 differentiated directions from 5 schools × 20 design philosophies, generate 3 Demos in parallel for you to choose from.

<p align="center"><img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/w3-fallback-advisor.gif" width="100%"></p>

### iOS App Prototype

Accurate iPhone 15 Pro chassis (Dynamic Island / status bar / Home Indicator) · State-driven multi-screen switching · Real images pulled from Wikimedia/Met/Unsplash · Playwright automated click testing.

<p align="center"><img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/c1-ios-prototype.gif" width="100%"></p>

### Motion Design Engine

Stage + Sprite timeline model · `useTime` / `useSprite` / `interpolate` / `Easing` — four APIs covering all animation needs · Export MP4 / GIF / 60fps interpolated / finished film with BGM in one command.

<p align="center"><img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/c3-motion-design.gif" width="100%"></p>

### HTML Slides → Editable PPTX

HTML deck for browser presentation · `html2pptx.js` reads the DOM's computedStyle and translates each element into a PowerPoint object · The exported file has **real text boxes** — double-click to edit directly in PPT.

<p align="center"><img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/c2-slides-pptx.gif" width="100%"></p>

### Tweaks · Live Variant Switching

Colour scheme / typeface / information density and other parameters · Side panel switching · Pure frontend + `localStorage` persistence · Survives page refresh.

<p align="center"><img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/c4-tweaks.gif" width="100%"></p>

### Infographic / Data Visualisation

Magazine-quality layout · CSS Grid precise column splits · `text-wrap: pretty` typographic detail · Real data driven · Exportable as vector PDF / PNG 300dpi / SVG.

<p align="center"><img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/c5-infographic.gif" width="100%"></p>

### 5-Dimension Expert Critique

Philosophy consistency · Visual hierarchy · Detail execution · Functionality · Innovation — each scored 0–10 · Radar chart visualisation · Outputs Keep / Fix / Quick Wins list.

<p align="center"><img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/c6-expert-review.gif" width="100%"></p>

### Junior Designer Workflow

No diving straight into the big piece: write assumptions + placeholders + reasoning first, show it to you early, then iterate. Catching a misunderstanding early is 100× cheaper than catching it late.

<p align="center"><img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/w2-junior-designer.gif" width="100%"></p>

### Brand Asset Protocol — 5-Step Hard Process

Enforced whenever a specific brand is involved: ask → search → download (three fallbacks) → grep colour values → write `brand-spec.md`.

<p align="center"><img src="https://github.com/alchaincyf/huashu-design/releases/download/v2.0/w1-brand-protocol.gif" width="100%"></p>

---

## Showcase · Real-World Examples

### "Let's Talk Skills" · PM After-Party Presentation Deck

> **Live demo · [https://skill-huasheng.vercel.app](https://skill-huasheng.vercel.app)**

13-page HTML deck, **built entirely with huashu-design**:

- Black-background minimalist serif visual system (cover / about / hook / what / why / closing)
- 2 cinematic demos with BGM + SFX, each 22 seconds (Nuwa skill workflow + Darwin skill workflow), each using a **completely independent visual language**:
  - **Nuwa**: 3D knowledge orbit + Pentagon extraction + SKILL.md typewriter + "21 minutes" hero reveal
  - **Darwin**: autoresearch loop spin + v1/v5 side-by-side diff + Hill-Climb full-screen curve + Ratchet gear lock
- Each cinematic defaults to showing the **full static workflow dashboard** (audience can always see how the skill runs), clicking play triggers the animation, which fades back to the dashboard when done
- Embedded huasheng.ai 25-second hero animation (with local iframe fallback)
- Real data: 14,495 stargazers real curve (pulled via gh API) + DeepSeek V4 real specs (verified via WebSearch)
- Real AI assets: ran `huashu-gpt-image` for a 4×2 grid image, `extract_grid.py` cut out 8 individual transparent PNGs for the 3D orbit float

**Pages worth referencing**:
- `/slides/slide-04b-nuwa-flow.html` · Static dashboard + cinematic overlay dual-layer architecture
- `/slides/slide-06b-darwin-flow.html` · Contrast example with a completely independent visual language
- `/slides/slide-03b-deepseek-cover.html` · AI slop vs. real designer perspective comparison page

Detailed cinematic patterns: `references/cinematic-patterns.md`.

---

## Core Mechanics

### Brand Asset Protocol

The hardest rule in the skill. When a specific brand is involved (Stripe, Linear, Anthropic, your own company, etc.), five steps are enforced:

| Step | Action | Purpose |
|------|--------|---------|
| 1 · Ask | Does the user have brand guidelines? | Respect existing resources |
| 2 · Search official brand page | `<brand>.com/brand` · `brand.<brand>.com` · `<brand>.com/press` | Grab authoritative colour values |
| 3 · Download assets | SVG file → full official website HTML → screenshot colour sampling | Three fallbacks — if the first fails, move immediately to the next |
| 4 · grep colour values | Extract all `#xxxxxx` from assets, rank by frequency, filter out black/white/grey | **Never guess brand colours from memory** |
| 5 · Lock in spec | Write `brand-spec.md` + CSS variables, all HTML references `var(--brand-*)` | Not locking in = forgetting |

A/B test (v1 vs v2, 6 agents each): **v2 stability variance is 5× lower than v1**. The stability of stability — that's the skill's real moat.

### Design Direction Advisor (Fallback)

Triggered when user requirements are too vague to start from:

- Don't force it based on generic intuition — enter Fallback mode
- Recommend 3 differentiated directions from 5 schools × 20 design philosophies — **must come from different schools**
- Each direction includes representative works, mood keywords, representative designers
- Generate 3 visual Demos in parallel for the user to choose from
- After selection, enter the main Junior Designer workflow

### Junior Designer Workflow

The default working mode, applied to all tasks:

- Before starting, show the full question list to the user in one go and wait for all answers before proceeding
- Write assumptions + placeholders + reasoning comments in HTML first
- Show it to the user early (even if it's just grey rectangles)
- Show the user again at each of the three steps: fill in real content → variations → Tweaks
- Run through the browser with Playwright for a visual check before delivering

### Anti-AI-Slop Rules

Avoid the visual lowest common denominator that screams AI (purple gradients / emoji icons / rounded corners + left border accent / SVG faces / Inter for display). Use `text-wrap: pretty` + CSS Grid + carefully chosen serif display fonts and oklch colours.

---

## Relationship to Claude Design

I'll openly admit: the philosophy behind the brand asset protocol was taken from a prompt that circulated out of Claude Design. That prompt repeatedly emphasised that **good high-fidelity design doesn't start from a blank page — it grows from existing design context**. That principle is the dividing line between a 65-point piece and a 90-point piece.

Positioning differences:

| | Claude Design | huashu-design |
|---|---|---|
| Form | Web product (used in browser) | Skill (used in Claude Code) |
| Quota | Subscription quota | API consumption · parallel agents not quota-limited |
| Deliverables | In-canvas + exportable Figma | HTML / MP4 / GIF / editable PPTX / PDF |
| Interaction | GUI (click, drag, edit) | Conversation (talk, wait for agent to finish) |
| Complex animation | Limited | Stage + Sprite timeline · 60fps export |
| Cross-agent | Exclusive to Claude.ai | Compatible with any skill-enabled agent |

Claude Design is **a better graphics tool**; huashu-design is **making that graphics tool layer disappear**. Two paths, different audiences.

---

## Limitations

- **No layer-level editable PPTX-to-Figma**. Output is HTML — screenshottable, recordable, exportable as image, but you can't drag text positions around in Keynote.
- **No Framer Motion-level complex animations**. 3D, physics simulation, and particle systems are outside the skill's scope.
- **Designing a completely blank brand from scratch will drop quality to 60–65 points**. Drawing hi-fi from nothing is always a last resort.

This is an 80-point skill, not a 100-point product. For someone who doesn't want to open a graphics interface, an 80-point skill beats a 100-point product.

---

## Repository Structure

```
huashu-design/
├── SKILL.md                 # Main document (read by agent)
├── README.md                # This file (read by users)
├── assets/                  # Starter Components
│   ├── animations.jsx       # Stage + Sprite + Easing + interpolate
│   ├── ios_frame.jsx        # iPhone 15 Pro bezel
│   ├── android_frame.jsx
│   ├── macos_window.jsx
│   ├── browser_window.jsx
│   ├── deck_stage.js        # HTML slide engine
│   ├── deck_index.html      # Multi-file deck assembler
│   ├── design_canvas.jsx    # Side-by-side variant display
│   ├── showcases/           # 24 pre-built examples (8 scenarios × 3 styles)
│   └── bgm-*.mp3            # 6 scene-specific background music tracks
├── references/              # Sub-documents to read per task
│   ├── animation-pitfalls.md
│   ├── design-styles.md     # Detailed library of 20 design philosophies
│   ├── slide-decks.md
│   ├── editable-pptx.md
│   ├── critique-guide.md
│   ├── video-export.md
│   └── ...
├── scripts/                 # Export toolchain
│   ├── render-video.js      # HTML → MP4
│   ├── convert-formats.sh   # MP4 → 60fps + GIF
│   ├── add-music.sh         # MP4 + BGM
│   ├── export_deck_pdf.mjs
│   ├── export_deck_pptx.mjs
│   ├── html2pptx.js
│   └── verify.py
└── demos/                   # 9 capability demos (c*/w*), bilingual GIF/MP4/HTML + hero v10
```

---

## Origin

The day Anthropic released Claude Design I played with it until 4am. A few days later I realised I hadn't opened it since — not because it's bad (it's the most mature product in this space right now) — but because I'd rather have the agent do the work in the terminal than open any graphics interface.

So I had the agent deconstruct Claude Design itself (including the system prompt circulating in the community, the brand asset protocol, the component mechanics), distilled it into a structured spec, and wrote it as a skill to install into my own Claude Code.

Thanks to Anthropic for writing Claude Design's prompt so clearly. This kind of secondary creation inspired by another product is a new form of open-source culture in the AI era.

---

## License

**Free and open for personal use** — learning, research, creative work, building things for yourself, writing articles, side projects, posting on social media — use it however you like, no need to ask.

**Commercial use prohibited** — any company, team, or profit-driven organisation that wants to integrate this skill into a product, external service, or client deliverables **must contact Huasheng first for authorisation**. This includes but is not limited to:
- Using the skill as part of a company's internal toolchain
- Using skill outputs as the primary means of producing external deliverables
- Building a commercial product on top of the skill
- Using it in client commercial projects

**Commercial licensing enquiries**: contact via the social platforms below.

---

## Connect · Huasheng (Huashu)

Huasheng is an AI Native Coder, indie developer, and AI content creator. Notable works: Kitten Fill Light (AppStore paid ranking Top 1), *Master DeepSeek in One Book*, Nuwa .skill (GitHub 12000+ stars). 300,000+ followers across all social platforms.

| Platform | Handle | Link |
|---|---|---|
| X / Twitter | @AlchainHust | https://x.com/AlchainHust |
| WeChat Official Account | Huashu | Search "Huashu" on WeChat |
| Bilibili | Huashu | https://space.bilibili.com/14097567 |
| YouTube | Huashu | https://www.youtube.com/@Alchain |
| Xiaohongshu | Huashu | https://www.xiaohongshu.com/user/profile/5abc6f17e8ac2b109179dfdf |
| Official site | huasheng.ai | https://www.huasheng.ai/ |
| Developer page | bookai.top | https://bookai.top |

Commercial licensing, collaboration enquiries, media commissions → DM Huasheng on any of the above platforms.
