# Operations index

Lazy-loaded skills and workflows. Read these on demand only when relevant -- do NOT load proactively. Each agent's CLAUDE.md has pointers to skills they own.

## Skills (~/workspace/operations/engine-room/skills/)

- **agent-browser** -- Interactive browser automation using the agent-browser CLI. Clicking buttons, filling forms, login flows, scraping dynamic pages, UI testing.
  - Path: `~/workspace/operations/engine-room/skills/agent-browser/SKILL.md`
  - Available to: all agents
- **impeccable** -- Comprehensive frontend design skill system. Core design principles, anti-patterns, and 17 sub-skills for UI work (animate, audit, critique, layout, polish, etc.).
  - **Start here:** `~/workspace/operations/engine-room/skills/impeccable/OVERVIEW.md` (routing guide -- tells you which skills to load without reading them all)
  - Core: `~/workspace/operations/engine-room/skills/impeccable/SKILL.md`
  - Sub-skills: `~/workspace/operations/engine-room/skills/impeccable/skills/` (adapt, animate, audit, bolder, clarify, colorize, critique, delight, distill, harden, layout, optimize, overdrive, polish, quieter, shape, typeset)
  - Reference docs: `~/workspace/operations/engine-room/skills/impeccable/reference/` (color-and-contrast, craft, extract, interaction-design, motion-design, responsive-design, spatial-design, typography, ux-writing)
- **ui-ux-pro-max** -- CSV databases of styles, colors, fonts, UX guidelines, charts across 15+ tech stacks. Python search engine included.
  - Path: `~/workspace/operations/engine-room/skills/ui-ux-pro-max/` (no SKILL.md -- entry via `templates/base/skill-content.md`)
  - Data: `~/workspace/operations/engine-room/skills/ui-ux-pro-max/data/` (styles.csv, colors.csv, typography.csv, ux-guidelines.csv, charts.csv, + stacks/)
  - Search: `~/workspace/operations/engine-room/skills/ui-ux-pro-max/scripts/search.py`
- **process-discipline** -- Sprint framework with 11 composable sub-skills for feature development, debugging, review, and deployment.
  - Path: `~/workspace/operations/engine-room/skills/process-discipline/SKILL.md`
- **improve-codebase-architecture** -- Evidence-led architecture improvement workflow for refactors, boundary cleanup, technical debt reduction, root-cause fixes, and structural code reviews.
  - Path: `~/workspace/operations/engine-room/skills/improve-codebase-architecture/SKILL.md`
  - Exposed to: MyOS runtime (`~/HQ/skills/`), Claude CLI (`~/.claude/skills/`), Codex (`~/.codex/skills/`)
- **supabase** -- Supabase setup, schema management, auth, RLS policies, and data migration.
  - Path: `~/workspace/operations/engine-room/skills/supabase/SKILL.md`
- **workflow-designer** -- Generates standardized workflow briefs for agent execution via a 6-question interview.
  - Path: `~/workspace/operations/engine-room/skills/workflow-designer/SKILL.md`

## Workflows (~/workspace/operations/)

- **new-project-workflow** -- Multi-step workflow for shaping any new project. Includes template, dry-run examples, and 7 sub-skills (shape, grill-me, prd-to-issues, triage-issue, write-a-prd, ralph, prd-to-plan, tdd).
  - Entry point: `~/workspace/operations/new-project-workflow/template.md`
  - Process map: `~/workspace/operations/new-project-workflow/process-map.md`
  - Sub-skills: `~/workspace/operations/new-project-workflow/skills/`

## TODO

- `process-discipline/skills/sprint-execution.md` references `scripts/checkpoint.sh` which is OpenClaw-specific. Resolve when porting Phase 5 operational scripts (Mason owns).
