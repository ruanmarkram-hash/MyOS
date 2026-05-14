# Code Review: Pre-Commit Quality Gates

Activate this when: Before merging to main or pushing to production.

Two review types: **Spec Compliance** (does code match plan?) and **Quality** (is code well-written?).

## Why This Matters

Code review catches bugs before they hit production. More importantly, it distributes knowledge — reviewers understand the codebase better, and implementers learn from feedback.

Process-Discipline uses **two-stage review** (spec then quality) because they're different tasks. Mixing them creates confusion.

## The Two-Stage Model

### Stage 1: Spec Compliance Review

Verify: Does the code implement exactly what the plan says?

**Reviewer's checklist:**
- [ ] All test cases from plan are implemented?
- [ ] Code does what plan describes (no shortcuts)?
- [ ] Commits follow the task structure?
- [ ] Message format is clear?
- [ ] Nothing was added to the plan?
- [ ] All dependencies resolved?

**Decision:**
- **Approve:** Proceed to Stage 2
- **Minor fixes:** Change function name, add comment, fix typo (5-10 min rework)
- **Major rework:** Logic is wrong, test wrong, or doesn't match plan (send back to implementer)

Spec compliance is **objective**. Either it matches the plan or it doesn't.

### Stage 2: Quality Review

Verify: Is code well-written and maintainable?

**Reviewer's checklist:**
- [ ] Follows project style and patterns?
- [ ] Names are clear (functions, variables, files)?
- [ ] No obvious bugs or edge cases?
- [ ] Reasonable performance (no n² loops for small data)?
- [ ] Tests are well-written (clear, maintainable)?
- [ ] No dead code?
- [ ] Comments explain *why*, not *what*?

**Decision:**
- **Approve:** Ready to merge
- **Minor fixes:** Rename variable, add comment, remove unused import (5-10 min)
- **Request improvements:** Design pattern better, tests insufficient, error handling weak (rework)

Quality is **subjective** (within bounds). Reviewer should explain trade-offs, not just say "I don't like it."

## The Review Process

### For Sage Sprints

Sage dispatches review agents after each task:

```
Task 1 complete → Dispatch Spec Reviewer → Approve/Fix → Dispatch Quality Reviewer → Approve/Fix → Task 2
```

Each task is reviewed independently. Focused. Fast.

### For Manual Code Review

You're doing the review:

**1. Get the commits:**
```bash
git log origin/main..HEAD --oneline
```

**2. Read the plan:**
```
docs/superpowers/plans/YYYY-MM-DD-<feature>.md
```

**3. Review Stage 1 (Spec Compliance):**

For each commit, read code against the plan:
- What was supposed to happen?
- Did it happen?
- Are there deviations?

If deviations are intentional (plan was incomplete, better approach emerged), note them. Don't automatically reject.

```
Spec Review: ✓ Approved

Code matches plan for Tasks 1-3.
Task 4 has additional error handling not in plan, but it's reasonable.
Ready for quality review.
```

**4. Review Stage 2 (Quality):**

Read code for maintainability:
- Clear names?
- Tests comprehensive?
- Patterns consistent?
- Any obvious bugs?

Leave comments for each concern:

```
Line 23: Why does this function need to validate input?
         The plan doesn't mention validation.
         
Line 45: Consider extracting this logic to a helper.
         Similar code appears on line 120 in another file.

Line 67: Performance concern: this loop is O(n²).
         For 1000 items, might be slow. Any plans to optimize?
```

Suggest, don't demand. Explain reasoning.

## Code Review Checklist

See `references/code-review-checklist.md` for detailed review standards.

Quick version:

### Spec Compliance (Objective)

- [ ] Implements everything in the plan?
- [ ] No extra features added?
- [ ] Tests match plan?
- [ ] Commits are clean?

### Code Quality (Subjective but Standards-Based)

- [ ] Readable (clear names, good structure)?
- [ ] Tested (comprehensive coverage)?
- [ ] Performant (no obvious inefficiency)?
- [ ] Maintainable (follows patterns, easy to change)?
- [ ] Safe (error handling, edge cases)?

### custom workflow Specifics

#### Database Changes (Supabase)

Review checklist:
- [ ] Migration is reversible?
- [ ] Column types match usage?
- [ ] Constraints defined (NOT NULL, UNIQUE)?
- [ ] Comments explain purpose?
- [ ] No breaking changes?

#### React Components

Review checklist:
- [ ] Props well-typed?
- [ ] Event handlers clear?
- [ ] Accessibility considered?
- [ ] No unnecessary re-renders?
- [ ] Error states handled?

#### Data Access Layer

Review checklist:
- [ ] Error handling present?
- [ ] No SQL injection possible?
- [ ] Queries efficient (indexes relevant)?
- [ ] Return types consistent?

## Handling Review Feedback

### If You're Being Reviewed

**Disagree with feedback?** Say so, with reasoning.

```
Reviewer said: "Don't use arrow functions, use function declarations"
Your response: "Arrow functions are fine per our eslint config. 
               Is there a specific concern about this usage?"
```

**Minor feedback?** Make the change. Takes 5 minutes.

**Major feedback?** Discuss before reworking. Understand the concern first.

**No feedback?** Merge and celebrate.

### If You're Reviewing

**Nitpicky feedback?** Let it go. If it's not in the standards, don't enforce it.

**Genuine issue?** Explain why it matters and what to change.

```
GOOD: "This loop is O(n²) and could be O(n) with a Set lookup. Try this pattern instead: [example]"

BAD: "I don't like this logic"

BAD: "Use .map() instead of for loop" (unless style standards require it)
```

**Unblocking changes?** Approve even if not perfect. Perfect is the enemy of done.

**Test coverage gaps?** Point them out. Don't require 100% coverage, but edge cases matter.

## Turnaround

Reviews should be fast:

- **Spec compliance:** 10-15 minutes per task
- **Quality:** 15-20 minutes per task
- **Total per task:** 25-35 minutes

If review takes longer, something's wrong:
- Plan was too ambitious
- Code is too complex
- Reviewer is being too detailed

## Common Mistakes

### Scope Creep in Review

```
Bad: "While you're here, also refactor this other file"
```

Keep review focused on the PR. Refactoring other code goes in a separate sprint.

### Blocking on Style

```
Bad: "I prefer this function name, rename it before merge"
Good: "This function name is unclear. What specifically does it do?"
```

Use objective standards (style guide, error handling policy) not preferences.

### Not Explaining Trade-offs

```
Bad: "Don't use this database query pattern"
Good: "This query will slow down on large datasets. 
       If we expect <1000 records, it's fine. If more, consider batching."
```

Help the implementer understand *why* the feedback matters.

## When to Override

Reviewer says no. You know it's right. When can you override?

- **Bug fix:** If review is blocking a critical production fix, merge and loop back
- **New learning:** If you find a better approach after review, iterate (in a follow-up sprint, not in this one)
- **Rare patterns:** If code does something unusual but correct, explain and override

These are exceptions. Default is: review suggests → implementer fixes → review approves → merge.

## Related Skills

- **sprint-execution** — Dispatches review agents after each task
- **test-driven-development** — Tests are reviewed as part of quality check
- **code-review.md** — Full code review standards
- **feature-completion** — Final review before merge

## Done When

- [ ] Spec compliance stage passed
- [ ] Quality review stage passed
- [ ] Feedback addressed or explicitly discussed
- [ ] Reviewer signed off
- [ ] Ready to merge

## Examples

See `references/code-review-checklist.md` for detailed standards.
