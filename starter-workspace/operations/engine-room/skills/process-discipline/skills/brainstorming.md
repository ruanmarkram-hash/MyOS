# Brainstorming: Refine Ideas Into Designs

Activate this when: You have a rough feature idea but unclear scope, requirements, or design.

Do NOT write code. Do NOT scaffold projects. Do NOT start implementation. Get clarity first.

## Why This Matters

The most expensive mistakes happen in brainstorming. A 10-minute conversation that clarifies ambiguity saves 3 hours of rework. An assumption written as code becomes debt.

This skill forces the hard thinking before fingers hit keyboard.

## The Process

### 1. Explore Project Context (read existing code)

Before asking questions, read:
- Recent commits (what was just worked on?)
- Related files (what patterns exist?)
- Open issues or PRs (what's known to be broken?)
- Architecture docs (how does this fit in?)

This gives you context. Don't skip it. A 2-minute read prevents 20 minutes of redundant questions.

### 2. Assess Scope

Is this one feature or multiple?

**Red flag:** "Build X with A, B, C, and D" where A-D are independent systems (chat, billing, analytics, exports).

**If multiple independent subsystems:** Flag it. Decompose into sub-projects. Each gets its own brainstorm → plan → build cycle.

**If single-focused feature:** Proceed to clarifying questions.

### 3. Ask Clarifying Questions (one at a time)

**Goal:** Understand purpose, constraints, success criteria.

**Rules:**
- One question per message
- Wait for answer before next question
- Prefer multiple choice when possible, but open-ended is fine
- Focus on what, why, and how it matters

**Example questions:**
- "What's the main goal here? (users can do X / reduce time spent on Y / improve Z metric)"
- "Who uses this? (specific roles or everyone)"
- "What happens if this doesn't work? (deal breaker, nice-to-have, medium priority)"
- "What constraints matter most? (time, code quality, performance, learning curve)"

**Don't ask:**
- "How should we build this?" (that's design, not requirements)
- "What tech stack?" (wait until design phase)
- Multiple questions at once

### 4. Propose 2-3 Approaches

Once you understand requirements, show options with trade-offs.

**Format per approach:**
- What it does
- Key trade-offs (speed vs complexity, coverage vs simplicity, etc.)
- Why you recommend it (or don't)

**Example:**
```
Approach A: Extend existing user table with new columns
  - Pro: Simple, reuses existing patterns
  - Con: Mixes concerns, column bloat over time
  
Approach B: New linked table with FK relationship
  - Pro: Clean separation, easier to iterate later
  - Con: Slightly more complex queries, new migration
  
Approach C (recommended): New linked table, but with denormalized cache column in users
  - Pro: Clean separation AND performant queries
  - Con: Cache invalidation adds complexity
```

Pick your recommendation and explain why.

### 5. Present Design (section by section)

Now paint the full picture. Scale each section to its complexity:
- Simple concept? 2-3 sentences.
- Complex with trade-offs? 150-300 words.
- Multiple options? Show each with diagrams if visual.

**Design sections cover:**
- **Architecture:** How do the pieces fit together?
- **Data flow:** What data moves where?
- **User experience:** What does the user see/do?
- **Error handling:** What breaks, how do we recover?
- **Performance:** Any concerns? How are they addressed?
- **Testing:** How do we verify it works?

**After each section:** "Does that look right?" Wait for feedback.

### 6. Write Design Document

Save the approved design to:
```
docs/superpowers/specs/YYYY-MM-DD-<feature-name>-design.md
```

**Format:**
```markdown
# [Feature Name] Design

## Goal
One sentence: what does this accomplish?

## Requirements
- [requirement 1]
- [requirement 2]

## Architecture
[2-3 paragraphs describing approach]

## Data Model
[Tables, fields, relationships]

## User Experience
[Screenshots or descriptions of user-facing behavior]

## Error Handling
[What can break, how we handle it]

## Success Criteria
- [How we know it works]
- [Performance targets if any]
- [Testing approach]

## Out of Scope
[What we're explicitly NOT doing]
```

Commit the design doc to git:
```bash
git add docs/superpowers/specs/YYYY-MM-DD-<feature-name>-design.md
git commit -m "design: add <feature-name> spec"
```

### 7. Spec Self-Review (fix inline, no re-review)

Before showing the user, review your own work:

**Placeholder scan:** Any TBD, TODO, or vague "we'll handle this later"? Fix it.

**Consistency check:** Do sections contradict? Does architecture match the features described?

**Scope check:** Is this tight enough for one implementation plan? If not, decompose.

**Ambiguity check:** Could any requirement be read two ways? Be explicit.

Fix issues inline. No need to re-review after fixes.

### 8. User Reviews Spec

Share the spec file:

> Spec written and committed to `docs/superpowers/specs/YYYY-MM-DD-<feature-name>-design.md`. Please review it and let me know if anything needs to change before we start the implementation plan.

Wait for review. If changes requested, update and self-review again. Repeat until approved.

### 9. Transition to Planning

Once approved, invoke **planning** skill:

> Design approved. Now I'm using the planning skill to break this into detailed implementation tasks.

The planning skill reads this design and outputs a task list. That's the next step.

## Key Patterns

### Decomposing Large Features

If the design naturally breaks into independent parts, say so:

> This could be built as three separate sprints:
> 1. Client data model + migrations
> 2. Import workflow
> 3. Verification and reporting
>
> Should we build them in sequence (1 then 2 then 3) or would you prefer to combine any of them?

Each gets its own brainstorm → plan → build cycle.

### Exploring Alternatives

Always show at least 2 approaches. This isn't extra work — it's the difference between a solid design and an "oh we should have done it differently" later.

### When to Loop Back

If user feedback contradicts earlier requirements:

> You mentioned earlier that performance was less important than simplicity, but this constraint suggests otherwise. Should we prioritize differently?

Don't assume — ask.

## Anti-Patterns

### "This Is Too Simple For A Design"

Every feature gets a design. Todo lists, config changes, single-function utilities — all of them.

"Simple" features are where assumptions hide. A 5-minute conversation surfaces them.

**What you think:** "Just add a button."
**What the user meant:** "Add a button that only admins see, appears after client approval, and triggers a complex workflow."

Brainstorm every time.

### Skipping Context

You don't know the codebase the way the user does. Read the relevant files first. It takes 5 minutes and prevents 20 minutes of "wait, we already do that" conversations.

### Multiple Questions At Once

Users answer the first question and ignore the rest. Ask one at a time. Wait for response. Then ask the next.

### Presenting 10 Options

2-3 approaches, with reasoning. More than that creates decision paralysis.

### Designing "To Be Perfect"

Your design will be incomplete. That's fine. It should be *clear* and *internally consistent*, but not airtight. The details emerge during implementation.

If you find yourself writing "TBD" sections, you're designing in too much detail. Step back.

## Done When

- [ ] You've explored project context
- [ ] Scope is clear (one feature or explicit list of sub-projects)
- [ ] Questions answered, requirements documented
- [ ] 2-3 approaches proposed with trade-offs
- [ ] Design presented and discussed section by section
- [ ] Design document written and committed
- [ ] Design document self-reviewed (no placeholders, no ambiguity)
- [ ] User approved the spec
- [ ] Planning skill is next

## Related Skills

- **planning** — Follows this. Takes design, outputs task list.
- **skill-selection** — Helps you identify when brainstorming is appropriate
- **writing-skills** — If you need to create a new skill, you brainstorm its design first

## Example

See `examples/sonke-hub-sprint-schema.md` for a complete brainstorming walkthrough on adding client billing to custom workflow.
