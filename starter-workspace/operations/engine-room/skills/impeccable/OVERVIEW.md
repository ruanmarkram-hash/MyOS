# Impeccable Design Skills -- Routing Guide

Read this file FIRST. Do NOT load individual skill files until you know which ones you need. Each skill is a focused tool -- pick only what the task requires.

## How to use

1. Read this overview to identify which skills match your task
2. Load ONLY the skill files you need from `skills/`
3. For deep guidance on a specific topic, load the matching file from `reference/`
4. Always load the main `SKILL.md` first -- it contains core design principles and the anti-pattern list that all sub-skills depend on

## Sub-skills (skills/)

### Planning
- **shape** -- Plan UX/UI before coding. Runs a discovery interview, produces a design brief. Use at the START of any design work.

### Visual design
- **colorize** -- Add strategic color to monochromatic or dull designs. Trigger: "needs more color", "too gray", "dull", "lacking warmth".
- **typeset** -- Fix font choices, hierarchy, sizing, weight, readability. Trigger: "fonts look off", "text hierarchy", "readability".
- **layout** -- Fix spacing, visual rhythm, grids, hierarchy. Trigger: "layout feels off", "crowded", "spacing issues", "alignment".
- **bolder** -- Amplify bland/safe designs for more visual impact. Trigger: "too generic", "bland", "lacks personality".
- **quieter** -- Tone down overstimulating designs. Trigger: "too bold", "overwhelming", "garish", "too loud".

### UX and content
- **clarify** -- Improve UX copy, error messages, labels, microcopy. Trigger: "confusing text", "unclear labels", "bad error messages".
- **delight** -- Add joy, personality, micro-interactions. Trigger: "add polish", "make it fun", "feels lifeless".
- **distill** -- Strip to essence, remove complexity. Trigger: "simplify", "declutter", "too much going on".

### Production readiness
- **harden** -- Edge cases, error states, empty states, i18n, overflow. Trigger: "production-ready", "handle edge cases", "empty states".
- **adapt** -- Responsive design across screen sizes and devices. Trigger: "mobile layout", "breakpoints", "responsive", "cross-device".
- **optimize** -- UI performance: loading, rendering, animations, bundle size. Trigger: "slow", "laggy", "performance", "bundle size".

### Motion
- **animate** -- Purposeful animations, transitions, micro-interactions. Trigger: "add animation", "hover effects", "make it feel alive".
- **overdrive** -- Technically ambitious UI: shaders, spring physics, 60fps. Trigger: "wow factor", "go all-out", "extraordinary".

### Quality assurance
- **audit** -- Technical quality checks (a11y, performance, theming, anti-patterns). Produces scored P0-P3 report. Run BEFORE polish.
- **critique** -- UX evaluation using Nielsen's heuristics, cognitive load analysis, persona testing. Quantitative scoring. Run for design review.
- **polish** -- Final pass: alignment, spacing, consistency, micro-details. Run LAST, right before shipping.

## Reference docs (reference/)

Deep guides on specific design domains. Load when you need detailed rules, not just the sub-skill workflow.

- **color-and-contrast** -- OKLCH color space, contrast ratios, palette construction, dark mode
- **typography** -- Line-height as base unit, vertical rhythm, scale systems, font pairing
- **spatial-design** -- 4pt grid system, spacing tokens, density levels, component spacing
- **responsive-design** -- Mobile-first approach, breakpoint strategy, fluid layouts, container queries
- **motion-design** -- Timing durations, easing curves, animation principles, reduced-motion
- **interaction-design** -- Interactive states (hover, focus, active, disabled), affordances, feedback patterns
- **ux-writing** -- Verb+object button labels, error message patterns, microcopy rules, tone
- **craft** -- Full structured process for building a feature with impeccable quality (shape, implement, review)
- **extract** -- Identifying and extracting reusable patterns, components, and design tokens into a design system

## Common task routing

| Task | Load these |
|------|-----------|
| Full redesign | SKILL.md + shape + colorize + typeset + layout + adapt + audit + polish |
| Quick visual refresh | SKILL.md + colorize + typeset + layout + polish |
| Accessibility pass | SKILL.md + audit + harden + adapt |
| Pre-ship review | SKILL.md + audit + critique + polish |
| Add animations | SKILL.md + animate (+ reference/motion-design for deep guidance) |
| Simplify cluttered UI | SKILL.md + distill + layout + polish |
| Make it pop | SKILL.md + bolder + colorize + delight |
| Production hardening | SKILL.md + harden + adapt + optimize |
