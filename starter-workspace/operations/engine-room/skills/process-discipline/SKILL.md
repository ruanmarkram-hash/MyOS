---
name: process-discipline
description: "Complete process discipline framework for Sage sprints. Enables structured feature development, debugging, and code quality through composable skills that activate based on task context. Routes to brainstorming, planning, implementation, testing, debugging, review, and deployment workflows."
---

# Process Discipline Framework

A complete, composable skill system for Sage sprints that turns ad-hoc work into structured, repeatable workflows. Superpowers-based (MIT, obra/superpowers) adapted for Sage's sequential agent model and custom workflow development patterns.

## What This Is

Process Discipline is not a single skill. It's a **framework of 11 interconnected skills** that automatically activate based on what you're working on. Each skill has:

- **Trigger conditions:** When does it activate?
- **Required inputs:** What does it need to work?
- **Output:** What does it produce?
- **Next skill:** What activates after it?

Think of it as a **workflow router** — you tell Sage what you're building or fixing, and the right skill sequence activates automatically.

## Core Principles

**Systematic > Intuitive.** Evidence over guessing. Process over heroics.

**Composable > Monolithic.** Each skill stands alone. They chain naturally without circular dependencies.

**Sage-native > Generic.** Uses Sage's terminology: sprints, checkpoints, agents, subagents, Mason (dev agent), Forge (database agent).

**Non-prescriptive > Rigid.** Skills are *activated* by trigger patterns, not *enforced*. You can always work without them. The framework makes it easier to do things right.

## The 11 Skills

### Foundation
- **brainstorming** — Refine rough ideas into validated designs before any code
- **planning** — Break designs into bite-sized, testable tasks
- **systematic-debugging** — Find root causes before attempting fixes

### Execution (Sage-native)
- **sprint-execution** — Dispatch agents sequentially, manage checkpoints, track progress
- **task-driven-development** — One agent per task, two-stage review (spec compliance, then code quality)

### Quality
- **test-driven-development** — RED-GREEN-REFACTOR for all new code (critical for custom workflow, which has 0 tests)
- **code-review** — Structured pre-commit review against plan and quality standards
- **verification-and-closure** — Confirm it works before marking done

### Workflow
- **git-workflow** — Branch strategy, commit patterns, worktree management
- **feature-completion** — Decide merge/PR/discard, clean up, transition to next phase

### Meta
- **skill-selection** — Determine which skills activate for your current task
- **writing-skills** — Create new skills following process-discipline patterns

## Quick Start: What Activates When?

### You're building something new
```
"Let's build X feature"
↓ brainstorming (refine the idea)
↓ planning (break into tasks)
↓ sprint-execution (dispatch agents)
↓ test-driven-development (for each task)
↓ code-review (before merge)
↓ feature-completion (finish the branch)
```

### You're fixing a bug
```
"Debug: why is X broken?"
↓ systematic-debugging (find root cause)
↓ [implement fix using task-driven-development]
↓ test-driven-development (test the fix)
↓ code-review (verify it's good)
↓ verification-and-closure (confirm it's actually fixed)
```

### You're refactoring
```
"Let's improve X code quality"
↓ brainstorming (why? what's the goal?)
↓ planning (what changes, in order)
↓ sprint-execution (implement)
↓ test-driven-development (keep all tests green)
↓ code-review (check for regressions)
```

## How Skills Chain

Each skill has an **explicit next step**. No guessing. No looping back.

Example (brainstorming → planning → execution):

1. **Brainstorming** outputs a validated design document
2. **Planning** reads that design, outputs a detailed task list
3. **Sprint Execution** reads the plan, dispatches agents for each task
4. **Test-Driven Development** runs during each task (sub-skill)
5. **Code Review** runs after task completion (sub-skill)
6. **Feature Completion** cleans up and decides what's next

## Activation by Context

Skills activate based on **what you're working on**, not who you are.

| If you say | Activates |
|------------|-----------|
| "Let's build X" (new feature, unclear scope) | brainstorming |
| "Let me plan this" (after approved design) | planning |
| "Let's code this" (with plan, independent tasks) | sprint-execution |
| "Why is X broken?" (unexpected behavior) | systematic-debugging |
| "Let's write tests" (existing code) | test-driven-development |
| "Review this work" (before merge) | code-review |
| "How do we know this is done?" | verification-and-closure |

See `config/skill-triggers.json` for complete trigger patterns.

## Sage-Native Adaptations

### Sequential Agent Model

Superpowers was built for Claude Code (solo agent). Sage uses **one agent per task, two-stage review**:

1. **Mason** (developer agent) implements task: writes code, tests, commits
2. **Review Agent 1** (Spec Reviewer) confirms code matches plan
3. **Review Agent 2** (Quality Reviewer) confirms code meets quality standards
4. **Sage** decides next action or spawns next agent

This happens automatically via **task-driven-development** skill.

### custom workflow Context

custom workflow currently has **0 tests**. The **test-driven-development** skill is **high-priority** for adoption.

Skills include custom workflow-specific examples:
- Debugging why a Supabase query fails
- Adding tests for client onboarding flow
- Reviewing database schema changes (Forge + Mason handoff)
- Refactoring a large React component

### Forge + Mason Handoff

When a sprint touches Supabase schema or database:

1. **Forge** runs first, completes schema changes
2. Sage reads Forge's work, extracts exact function/column names
3. **Mason** is briefed with those exact names
4. Never run them in parallel on schema-touching sprints

See `examples/sonke-hub-sprint-schema.md` for a full walkthrough.

## File Structure

```
skills/process-discipline/
├── SKILL.md                          ← You are here
├── skills/
│   ├── brainstorming.md              ← Refine ideas into designs
│   ├── planning.md                   ← Design → tasks
│   ├── sprint-execution.md           ← Task dispatch & checkpoints
│   ├── task-driven-development.md    ← Agent → review → merge
│   ├── test-driven-development.md    ← RED-GREEN-REFACTOR (critical for custom workflow)
│   ├── code-review.md                ← Pre-commit review
│   ├── systematic-debugging.md       ← Root cause → fix
│   ├── verification-and-closure.md   ← Confirm done
│   ├── git-workflow.md               ← Branch & commit strategy
│   ├── feature-completion.md         ← Merge/PR/discard decision
│   └── skill-selection.md            ← Determine which skill activates
├── config/
│   └── skill-triggers.json           ← Trigger conditions (patterns that activate skills)
├── examples/
│   ├── sonke-hub-sprint-schema.md    ← Full example: adding Supabase columns + React UI
│   ├── sonke-hub-sprint-bugfix.md    ← Full example: debugging a Supabase query
│   ├── sonke-hub-sprint-testing.md   ← Full example: test-driven development for custom workflow
│   └── README.md                     ← Index of examples
└── references/
    ├── red-green-refactor.md         ← TDD cycle explained
    ├── root-cause-tracing.md         ← Debugging technique: backward trace
    ├── code-review-checklist.md      ← Review standards
    └── git-patterns.md               ← Common git workflows for Sage sprints
```

## Integration Points

### With AGENTS.md
- **available_skills** section lists all 11 skills and their trigger patterns
- **skill selection logic** determines which skill a sprint uses

### With sprint briefing
- When Sage spawns Mason for a sprint, brief references the activated skill
- Example: "Sprint: Add client notes feature | Skill: brainstorming → planning → sprint-execution"

### With memory
- Each completed sprint is logged to `memory/YYYY-MM-DD.md`
- Format: task name | activated skill | outcome | blockers

## Using This Framework

### As a Developer
Pick a skill based on what you're doing:

1. **Building something new?** Start with `brainstorming.md`
2. **Have a design, need to code it?** Jump to `planning.md`
3. **Fixing a bug?** Start with `systematic-debugging.md`
4. **Writing tests?** Use `test-driven-development.md`
5. **About to merge?** Use `code-review.md` then `feature-completion.md`

Each skill is self-contained. Read the one you need, follow the steps, move to the next skill it points to.

### As Sage
When [YOUR NAME] describes work:

1. Use `skill-selection.md` to determine which skill activates
2. Read that skill's file
3. Brief the appropriate agent with the skill's requirements
4. After agent completes, read the skill's "next step" and brief accordingly

Example: [YOUR NAME] says "Let's add client billing to custom workflow." Sage reads `skill-selection.md`, determines "brainstorming" activates, briefs Charter (research agent) to validate the feature scope, waits for output, then briefs Mason with the design.

## No Dogma

Skills are **tools, not religion**.

- Prototyping? Skip the full design phase if it's truly exploratory.
- Emergency patch? Debug systematically, but maybe skip the full code review cycle.
- Config change? No need for TDD for JSON edits.

But the default case — building features, fixing bugs, refactoring — should use the full skill chain. They're there to make you faster and more reliable, not slower.

## Learning Path

**First time?** Read in this order:
1. This file (foundational overview)
2. `skill-selection.md` (determine your starting point)
3. The specific skill you need

**Building something complex?** Read:
1. `brainstorming.md` (validate the design)
2. `planning.md` (break into tasks)
3. `sprint-execution.md` (manage the build)
4. `test-driven-development.md` (write tests)
5. `code-review.md` (catch issues)
6. `feature-completion.md` (finish cleanly)

**Debugging?** Read:
1. `systematic-debugging.md` (find the root cause)
2. The implementation skill for your fix
3. `verification-and-closure.md` (confirm it's actually fixed)

**custom workflow context?** Read:
1. `examples/sonke-hub-sprint-schema.md` (Supabase + React handoff)
2. `examples/sonke-hub-sprint-testing.md` (building test practices)
3. `examples/sonke-hub-sprint-bugfix.md` (real debugging scenario)

## Credits

Process Discipline is adapted from **Superpowers** (MIT license), built by Jesse Vincent and the Prime Radiant team: https://github.com/obra/superpowers

Adapted for Sage in April 2026.

---

**Next:** Read `skill-selection.md` to determine which skill your current task needs.
