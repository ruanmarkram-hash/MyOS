# Design Philosophy Showcases — Sample Asset Index

> 8 scenes x 3 styles = 24 prebuilt design samples
> Used during Phase 3 style direction recommendations to show concretely what each style looks like in practice.

## Style Guide

| Code | School | Style Name | Visual Character |
|------|--------|-----------|-----------------|
| **Pentagram** | Information Architecture | Pentagram / Michael Bierut | Black-and-white restraint, Swiss grid, strong typographic hierarchy, #E63946 red accent |
| **Build** | Minimalism | Build Studio | Luxury-grade whitespace (70%+), subtle weight range (200-600), #D4A574 warm gold, refined |
| **Takram** | Eastern Philosophy | Takram | Soft-tech aesthetic, natural palette (cream/grey/green), rounded corners, charts as art |

## Scene Quick-Reference

### Content Design Scenes

| # | Scene | Dimensions | Pentagram | Build | Takram |
|---|-------|-----------|-----------|-------|--------|
| 1 | WeChat article cover | 1200x510 | `cover/cover-pentagram` | `cover/cover-build` | `cover/cover-takram` |
| 2 | PPT data slide | 1920x1080 | `ppt/ppt-pentagram` | `ppt/ppt-build` | `ppt/ppt-takram` |
| 3 | Vertical infographic | 1080x1920 | `infographic/infographic-pentagram` | `infographic/infographic-build` | `infographic/infographic-takram` |

### Website Design Scenes

| # | Scene | Dimensions | Pentagram | Build | Takram |
|---|-------|-----------|-----------|-------|--------|
| 4 | Personal homepage | 1440x900 | `website-homepage/homepage-pentagram` | `website-homepage/homepage-build` | `website-homepage/homepage-takram` |
| 5 | AI directory site | 1440x900 | `website-ai-nav/ainav-pentagram` | `website-ai-nav/ainav-build` | `website-ai-nav/ainav-takram` |
| 6 | AI writing tool | 1440x900 | `website-ai-writing/aiwriting-pentagram` | `website-ai-writing/aiwriting-build` | `website-ai-writing/aiwriting-takram` |
| 7 | SaaS landing page | 1440x900 | `website-saas/saas-pentagram` | `website-saas/saas-build` | `website-saas/saas-takram` |
| 8 | Developer docs | 1440x900 | `website-devdocs/devdocs-pentagram` | `website-devdocs/devdocs-build` | `website-devdocs/devdocs-takram` |

> Each entry has both a `.html` (source) and a `.png` (screenshot) file.

## Usage Notes

### Referencing During Phase 3 Recommendations
After recommending a style direction, show the prebuilt screenshot for the relevant scene:
```
"Here's what the Pentagram style looks like for a WeChat cover → [show cover/cover-pentagram.png]"
"This is how Takram handles a PPT data slide → [show ppt/ppt-takram.png]"
```

### Scene Matching Priority
1. User's requested scene has an exact match → show that scene directly
2. No exact match but type is similar → show the closest scene (e.g. "product website" → show the SaaS landing page)
3. No match at all → skip prebuilt samples, go straight to Phase 3.5 live generation

### Side-by-Side Comparison
All 3 styles for the same scene work well displayed in parallel to help the user compare visually:
- "Here is the same WeChat cover implemented in all 3 styles"
- Display order: Pentagram (rational, restrained) → Build (luxurious minimalism) → Takram (soft, warm)

## Content Details

### WeChat Article Cover (cover/)
- Content: Claude Code Agent workflow — 8-agent parallel architecture
- Pentagram: oversized red "8" + Swiss grid lines + data bars
- Build: ultra-light-weight "Agent" floating in 70% whitespace + warm gold hairline
- Takram: 8-node radial flow diagram as artwork + cream background

### PPT Data Slide (ppt/)
- Content: GLM-4.7 open-source model coding capability breakthrough (AIME 95.7 / SWE-bench 73.8% / t2-Bench 87.4)
- Pentagram: 260px "95.7" anchor + red/grey/light-grey contrasting bar chart
- Build: three groups of 120px ultra-thin numbers floating + warm gold gradient contrast bars
- Takram: SVG radar chart + three-color overlay + rounded data cards

### Vertical Infographic (infographic/)
- Content: AI memory system CLAUDE.md optimized from 93KB to 22KB
- Pentagram: oversized "93->22" numbers + numbered blocks + CSS data bars
- Build: extreme whitespace + soft-shadow cards + warm gold connector lines
- Takram: SVG ring chart + organic curve flowchart + frosted-glass cards

### Personal Homepage (website-homepage/)
- Content: Portfolio homepage for independent developer Alex Chen
- Pentagram: 112px large name + Swiss grid columns + editorial numbers
- Build: glassmorphism nav + floating stat cards + ultra-thin weight
- Takram: paper texture + small circular avatar + hairline dividers + asymmetric layout

### AI Directory Site (website-ai-nav/)
- Content: AI Compass — directory of 500+ AI tools
- Pentagram: square-cornered search box + numbered tool list + uppercase category labels
- Build: rounded search box + refined white tool cards + pill labels
- Takram: organic offset card layout + soft category labels + chart-style connections

### AI Writing Tool (website-ai-writing/)
- Content: Inkwell — AI writing assistant
- Pentagram: 86px large headline + wireframe editor mockup + grid feature columns
- Build: floating editor card + warm gold CTA + luxurious writing experience
- Takram: poetic serif headline + organic editor + flowchart

### SaaS Landing Page (website-saas/)
- Content: Meridian — business intelligence analytics platform
- Pentagram: black-and-white split layout + structured dashboard + 140px "3x" anchor
- Build: floating dashboard cards + SVG area chart + warm gold gradient
- Takram: rounded bar chart + flow nodes + soft earth tones

### Developer Docs (website-devdocs/)
- Content: Nexus API — unified AI model gateway
- Pentagram: left sidebar nav + square-cornered code blocks + red string highlighting
- Build: centered floating code card + soft shadow + warm gold icons
- Takram: cream code blocks + flowchart connections + dashed feature cards

## File Count

- HTML source files: 24
- PNG screenshots: 24
- Total assets: 48 files

---

**Version**: v1.0
**Created**: 2026-02-13
**For use in**: design-philosophy skill Phase 3 recommendation stage
