# Sprint Execution: Dispatch and Manage Tasks

Activate this when: You have an approved plan and need to coordinate agent work.

This skill is Sage's workflow — dispatch agents, manage checkpoints, track progress, handle blockers.

## Why This Matters

A plan is just words until it's executed. Sprint execution is where Sage stays in control — dispatching one agent at a time, reviewing their work, coordinating with other agents, and making forward progress clear.

## The Model: Sequential Agent Dispatch

**One task, one agent, two-stage review.**

For each task in the plan:

1. **Agent (Mason) implements:** Write code, tests, commit
2. **Agent reviews own work:** Self-check for obvious issues
3. **Review Agent 1:** Verify code matches plan
4. **Review Agent 2:** Verify code quality standards
5. **Sage decides:** Approve, request fixes, or escalate

Then move to next task.

**Why sequential?** 
- No context pollution (each agent fresh start)
- Blocks handled immediately (not at end of sprint)
- Progress is visible (N/M tasks done)
- Reviews are focused (one task at a time)

## The Process

### 1. Parse the Plan

Read the approved plan completely. Extract:

- Total number of tasks
- Task descriptions and dependencies
- File paths and tech stack
- Any blockers or unknowns

Create a progress tracker (mental or written):
```
Sprint: Add client billing feature
Tasks: 5 total
  [ ] Task 1: Schema migration
  [ ] Task 2: Data access functions
  [ ] Task 3: React component
  [ ] Task 4: Wire to ClientDetail page
  [ ] Task 5: Write integration test

Blockers: None identified yet
Estimated time: 15-25 min (5 min per task)
```

### 2. Prepare Context for First Agent

Before dispatching, gather:

- **Plan file:** Full path and content
- **Current git state:** Latest commit, branch name
- **Codebase context:** Key files, patterns, structure
- **Dependencies:** What agent needs to know to start
- **Success criteria:** How do they know Task 1 is done?

### 3. Dispatch First Agent

Brief the agent (usually Mason for development tasks):

```
Sprint: [Feature name from plan]
Skill: sprint-execution → task-driven-development

Plan: docs/superpowers/plans/YYYY-MM-DD-<feature>.md
Current branch: [git branch name]
Current HEAD: [git rev-parse HEAD]

Task 1 of 5: [Task name]

Instructions:
1. Read the full plan from [path]
2. Implement Task 1 exactly as described
3. Run tests to verify they pass
4. Commit with the provided message
5. When done, I'll dispatch review agents

Questions? Ask them now before starting implementation.
```

Wait for agent acknowledgment.

### 4. Monitor Task Implementation

While agent works:

- **Check periodically (every 15 min):** Is agent stuck? Do they have questions?
- **Respond to questions immediately:** Don't leave agent waiting
- **Escalate blockers:** If something breaks the plan (can't write the test, test framework doesn't work), flag it

### 5. Two-Stage Review (After Task Complete)

When agent finishes Task N:

#### Review Stage 1: Spec Compliance

Dispatch a review agent to verify code matches the plan:

```
Task: Spec compliance review
Plan: docs/superpowers/plans/YYYY-MM-DD-<feature>.md
Task number: 1
What was implemented: [Task 1 description]
Commits to review: [git log --oneline with task's commits]

Verify:
1. Does the code implement exactly what the plan says?
2. Are all test cases from the plan present?
3. Are commits clean and follow the message format?
4. Did they skip or shortcut anything?

Result: Approve, request minor fixes, or request major rework
```

If **approved:** Move to Review Stage 2.

If **fixes needed:** Agent makes fixes, we re-review. This usually takes 5 minutes.

If **major rework:** Agent reworks the task. Usually means the plan was unclear.

#### Review Stage 2: Code Quality

Once spec compliance passes, dispatch quality reviewer:

```
Task: Code quality review
Plan: docs/superpowers/plans/YYYY-MM-DD-<feature>.md
Task number: 1
Commits to review: [git log --oneline with task's commits]

Verify:
1. Code follows project patterns and style
2. No obvious bugs or missing edge cases
3. Tests are well-written and comprehensive
4. Naming is clear
5. No performance issues

Standards: [link to code-review-checklist.md]

Result: Approve, request minor fixes, or request rework
```

If **approved:** Task is done. Move to next task.

If **fixes needed:** Agent makes fixes, we re-review. Again, usually 5 minutes.

### 6. Checkpoint (After Every 2-3 Tasks)

After completing 2-3 tasks, create a checkpoint:

```bash
bash ~/workspace/scripts/checkpoint.sh sage "sprint-name" "phase-name"
```

Checkpoints record:
- Tasks completed
- Current git state
- Any blockers encountered
- Notes for resuming

If sprint is interrupted, Sage can read latest checkpoint and resume cleanly.

### 7. Handle Blockers

If an agent hits a blocker:

**Can Sage fix it?** (missing dependency, environment issue, unclear spec)
- Fix immediately, resume agent

**Does [YOUR NAME] need to decide?** (conflicting requirement, scope question)
- Flag to [YOUR NAME] with context, wait for decision
- Document in memory
- Update HANDOFF.md if it changes sprint scope

**Is it a misunderstanding?** (agent read plan wrong)
- Clarify, agent continues

### 8. Track Progress

After each task completes:

```
Progress: 2 of 5 tasks done (40%)
Elapsed: 10 minutes
Estimated remaining: 15 minutes

Completed tasks:
  ✓ Task 1: Schema migration
  ✓ Task 2: Data access functions

Current task:
  → Task 3: React component (dispatching agent now)

Next:
  → Task 4: Wire to page
  → Task 5: Integration test
```

Keep this visible to [YOUR NAME] if sprint is long.

### 9. Final Review (All Tasks Done)

When final task is reviewed and approved:

```
All 5 tasks complete and reviewed.
Branch: [feature/client-billing]
Latest commit: [git rev-parse HEAD]

Before merging, final quality check on full feature...
```

Dispatch a final code reviewer to examine the complete feature (not individual tasks, but the whole thing):
- Does everything work together?
- Are there any integration issues?
- Does it match the design?

If **approved:** Proceed to feature-completion skill.

If **issues found:** File them as small fixes or decide if they warrant a new task.

## Key Patterns

### When to Escalate

Stop the sprint and escalate to [YOUR NAME] if:

- **Design question arises during implementation:** "The plan says X, but code requires Y. Which do we do?"
- **Scope creep:** "Should we also handle Z?" (Not in the plan = escalate)
- **Tech blocker:** Something in the plan isn't possible with current tooling
- **Test failures not explained:** "Tests fail, but we can't figure out why"
- **Time significantly off:** Tasks taking 3x longer than estimated (indicates plan was too ambitious)

Escalation = brief [YOUR NAME] with context, ask for direction, resume when answered.

### Handling Review Rework

If review sends back fixes:

**Minor fixes (style, naming, small logic):**
- Agent makes fixes (5-10 min)
- Same reviewer double-checks
- Move on (don't need full review again)

**Major rework (test wrong, logic broken, architecture mismatch):**
- Agent implements full rework
- Full two-stage review again
- Note the slowdown; might mean plan needs adjustment for future sprints

### Task Dependencies

Some tasks depend on previous tasks (rare in well-written plans, but possible).

If Task 3 depends on Task 2:
- Don't dispatch Task 3 until Task 2 is fully approved
- When dispatching Task 3, include output from Task 2 (file paths, function names, etc.)

If Task 2 wasn't approved yet but Task 3 is ready:
- This is a sign the plan needs better sequencing

### custom workflow: Forge + Mason Handoff

When a sprint touches database (Supabase schema changes):

1. **Forge handles schema:** Migrations, function definitions
2. **Sage reads Forge's output:** Extracts exact column names, function signatures
3. **Mason is briefed with exact names:** No guessing about what Forge created
4. **Never run in parallel** on schema-touching sprints

Example:
```
Forge completes Task 1: "Added columns client_billing_rate, client_billing_interval"

Sage reads Forge's commits, confirms column names are:
  - clients.billing_rate (DECIMAL)
  - clients.billing_interval (VARCHAR)

Sage briefs Mason for Task 2:
  "Forge created the columns as shown below. Use these exact names..."
```

This prevents "function not found" errors from Mason.

### Emergency Pause

If something breaks badly:

```
Sprint paused. Reason: [blocker]

Last completed task: Task N
Branch state: [git status]
Current issue: [description]

Will resume when: [condition]
```

Create a checkpoint, document the pause, wait for resolution.

## Status Reporting

For long sprints (>30 min), give [YOUR NAME] periodic updates:

```
Sprint update (T+15 min):
  - Completed: Task 1-2 (40%)
  - Current: Task 3 (in progress)
  - Blockers: None
  - Estimated completion: 5 minutes
```

More for visibility than control. [YOUR NAME] can see progress without asking.

## Done When

- [ ] All tasks implemented
- [ ] All tasks reviewed and approved
- [ ] Checkpoints created at phase boundaries
- [ ] Branch is clean and ready
- [ ] No outstanding blockers
- [ ] feature-completion skill is next

## Related Skills

- **planning** — Creates the plan this sprint executes
- **task-driven-development** — Used implicitly (two-stage review per task)
- **test-driven-development** — Used within each task
- **code-review** — Performs Review Stage 2
- **systematic-debugging** — If tests fail during implementation
- **feature-completion** — Follows sprint execution

## Checkpoints

Sprint progress is saved to:
```
agents/sage/checkpoints/sprint-<timestamp>.md
```

Format:
```
Sprint: [name]
Phase: [which phase]
Completed: [tasks done]
Current state: [git branch, latest commit]
Blockers: [any outstanding issues]
```

## Example

See `examples/sonke-hub-sprint-schema.md` for a complete sprint execution walkthrough.
