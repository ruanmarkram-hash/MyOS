# Skill Selection: Determine Your Starting Point

Activate this when: You have work to do but unsure which skill to start with.

This skill is the **router** for the entire framework. It determines which skill activates based on what you're working on.

## The Decision Tree

```
What are you doing?

├─ "I have a rough idea I want to build"
│  └─ → brainstorming.md
│     (Refine into validated design)
│
├─ "I have an approved design"
│  └─ → planning.md
│     (Break into tasks)
│
├─ "I have a plan, ready to build"
│  └─ → sprint-execution.md
│     (Dispatch agents, manage progress)
│
├─ "Something is broken"
│  └─ → systematic-debugging.md
│     (Find root cause, then implement fix)
│
├─ "I'm writing new code or fixing code"
│  ├─ → test-driven-development.md
│  │  (RED-GREEN-REFACTOR for every task)
│  │
│  └─ Before committing:
│     → code-review.md
│     (Two-stage review)
│
├─ "Code is done and tested"
│  └─ → verification-and-closure.md
│     (Confirm it works, decide next step)
│
├─ "Verified and ready to ship"
│  └─ → feature-completion.md
│     (Merge or discard)
│
├─ "Working with git"
│  └─ → git-workflow.md
│     (Branch strategy, commits)
│
└─ "Creating a new skill"
   └─ → [outside this framework]
      (Use skill-creator skill)
```

## By Task Type

### Building a New Feature

Sequence:
```
brainstorming → planning → sprint-execution → test-driven-development (within tasks) 
→ code-review (for each task) → verification-and-closure → feature-completion
```

### Fixing a Bug

Sequence:
```
systematic-debugging → [implement fix using test-driven-development] 
→ code-review → verification-and-closure → feature-completion
```

### Refactoring Code

Sequence:
```
[optional: brainstorming if big refactor] → planning (if complex) 
→ test-driven-development (keep tests green) → code-review → verification-and-closure
```

### Running a Sprint

Sequence:
```
[brainstorming and planning already done] → sprint-execution 
→ [coordinate test-driven-development and code-review] → verification-and-closure
```

## Quick Reference

| Situation | Skill |
|-----------|-------|
| "Let's build X" (unclear scope) | brainstorming |
| "I understand what to build" | planning |
| "I have a plan, let's code" | sprint-execution |
| "X is broken, need to fix it" | systematic-debugging |
| "Writing code, need structure" | test-driven-development |
| "Before I merge this" | code-review |
| "Is this done?" | verification-and-closure |
| "Time to ship" | feature-completion |
| "Creating branches, committing" | git-workflow |
| "How do I decide which skill?" | skill-selection (this file) |

## custom workflow Context

### Common custom workflow Tasks

**Adding a field to client record:**
```
brainstorming (why this field, what does it affect?)
→ planning (schema migration, data access, UI)
→ sprint-execution (Forge for schema, Mason for UI)
```

**Fixing a Supabase query:**
```
systematic-debugging (why is query wrong?)
→ test-driven-development (write failing test)
→ code-review
→ verification-and-closure
```

**Redesigning a React page:**
```
brainstorming (what should change, why?)
→ planning (which components, what state?)
→ sprint-execution (implement components)
```

**Adding tests to existing code:**
```
test-driven-development (write tests for existing behavior)
→ code-review
→ verification-and-closure
```

## Edge Cases

### "I'm stuck on a problem"

If you're mid-sprint and hit a blocker:

1. Switch to **systematic-debugging**
2. Find root cause
3. Back to **sprint-execution** with solution

You don't leave the sprint. You interrupt it briefly to debug.

### "I don't know if this is done"

Use **verification-and-closure** to answer "is this done?"

It will tell you if you need to rework or if it's ready to merge.

### "Should we do this feature?"

Use **brainstorming** to explore the idea, not just plan it.

If unsure whether feature makes sense, brainstorm first. This avoids building the wrong thing.

### "This needs a bigger refactor"

If refactor is major (multiple files, new patterns):

```
brainstorming (why refactor, what's the goal?)
→ planning (which files, in what order)
→ sprint-execution
```

If refactor is minor (one function, one component):

```
test-driven-development (write tests first)
→ code-review
```

Skip full brainstorm/plan for small refactors.

## Integration with Sage

When you ([YOUR NAME]) describe work to Sage:

Sage uses this skill to determine which skill to activate:

```
[YOUR NAME]: "Let's add client emergency contacts"

Sage runs skill-selection:
  - What are you doing? Building new feature
  - Is scope clear? Not fully (needs discussion)
  - Decision: Activate brainstorming
  
Sage briefs Charter: "Brainstorm emergency contacts feature with [YOUR NAME]..."

Charter returns: "Feature validated, design documented"

Sage runs skill-selection again:
  - What's next? Have design, need tasks
  - Decision: Activate planning
  
Sage briefs Mason: "Create implementation plan for emergency contacts..."
```

Skill selection happens at each phase boundary.

## Decision Criteria

### Start with Brainstorming If:

- Scope is unclear
- Requirements are uncertain
- You're designing a new area
- Multiple approaches possible
- Stakeholders disagree on approach

### Start with Planning If:

- Design is already approved
- Requirements are clear
- You know what to build
- Ready to create task list

### Start with Sprint Execution If:

- Plan is already written
- Tasks are clear
- Ready to dispatch agents
- Multiple independent tasks

### Start with Systematic Debugging If:

- Something doesn't work
- Error is clear or reproduction steps known
- Need to find root cause
- Fix will come after investigation

### Start with Test-Driven Development If:

- Writing new code
- Fixing specific bug
- Improving existing code
- Working within a task

### Start with Code Review If:

- Task implementation is done
- Tests pass locally
- Ready for second opinion
- Before merging

### Start with Verification If:

- Implementation complete
- Reviews done
- Tests passing
- Need to confirm it works
- Ready to decide merge/rework/discard

## The Loop

```
For each sprint:
  1. skill-selection (what are we doing?)
  2. [activated skill] (do the thing)
  3. [next skill] (what's next?)
  4. Repeat until feature-completion
  
Repeat for next sprint
```

## Done When

You've identified your starting skill and read its file. That's all skill-selection does.

## Related Skills

All skills link back to this for determining what comes next.

## When to Override

You don't need to follow the exact sequence. Skills are **tools, not rules**.

If you skip a step, know why:

```
"Let's skip brainstorming because:"
- We already know the design (it's in an issue)
- It's a small, obvious feature
- We prototyped it already

"Let's skip code review because:"
- It's a config file change (minimal risk)
- Emergency hotfix (we'll review after)
- Solo sprint (no blockers)
```

Just be deliberate. Don't skip because you're in a hurry.

## Example

```
[YOUR NAME]: "Let's improve the client import performance."

Sage (skill-selection):
  - Rough idea? Yes
  - Scope clear? Maybe (could be one problem or many)
  - Decision: brainstorming first

Charter (brainstorming):
  - What specifically is slow?
  - Is it the UI, the database query, or the import logic?
  - What's the goal? (10x faster, or just "noticeable improvement"?)

Result: "Import is slow because we load all clients on page load, 
         even though we only show 10. Goal: Load only visible clients,
         lazy-load the rest."

Sage (skill-selection again):
  - Design approved? Yes
  - Ready to plan? Yes
  - Decision: planning next

Mason (planning):
  - Break into tasks:
    1. Paginate client list query
    2. Update React component to paginate
    3. Add tests for pagination
    4. Verify performance

And so on...
```

This is the decision-making process, run at each phase.
