# Planning: Design Into Tasks

Activate this when: You have an approved design and need to break it into implementation tasks.

Do NOT start coding yet. Create a detailed plan that a junior developer with zero context can follow.

## Why This Matters

A clear plan is a force multiplier. Instead of "go build this", you have "do step 1, then step 2, then test step 3."

For Sage sprints, this is where you define which agents handle which tasks. The plan becomes the contract between Sage and Mason (or other agents).

## The Process

### 1. Read the Approved Design

Read the spec from brainstorming completely. Understand:
- What the feature does
- How it fits in the system
- What constraints matter
- Success criteria

Don't skim. You're about to explain this to someone with no context.

### 2. Map File Structure

Before breaking into tasks, decide which files will be created or modified.

**Think about:**
- Separation of concerns (each file has one clear responsibility)
- Code you can hold in context at once (prefer smaller focused files)
- Files that change together should live together
- Follow existing codebase patterns (if it uses large files, don't unilaterally split them)

**Example (client notes feature for custom workflow):**
```
Files to create:
  - database/migrations/20240403-add-client-notes.sql (schema)
  - src/lib/supabase/client-notes.ts (data access)
  - src/components/ClientNotes.tsx (React component)
  - tests/unit/client-notes.test.ts (tests)

Files to modify:
  - src/pages/ClientDetail.tsx (add notes section)
  - database/schema.sql (update comments)
```

For each file, note:
- What does it do?
- What does it depend on?
- How do other files use it?

Clear boundaries = fewer bugs.

### 3. Break Into Bite-Sized Tasks

Each task = one action (2-5 minutes of work):
- "Write failing test" — task
- "Write implementation code" — task
- "Run tests" — task
- "Commit" — task
- "Refactor for clarity" — task

**NOT:**
- "Build the entire feature" (too big)
- "Handle all edge cases" (too vague)
- "Make it production-ready" (includes too many implicit steps)

**Why small?** When tasks are tiny, they're testable independently. A junior dev can complete one without getting lost.

### 4. Write Task Structure

For each task, specify:

```
### Task N: [Clear Name]

**Files:**
- Create: `path/to/new/file.ts`
- Modify: `path/to/existing.ts:123-145` (line range if large file)
- Test: `tests/path/to/test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Full test code here, not "write a test"
test('should parse client notes with timestamps', () => {
  const result = parseClientNote('2024-03-15 | User noted X');
  expect(result.date).toEqual(new Date('2024-03-15'));
  expect(result.text).toEqual('User noted X');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/path/to/test.ts`
Expected output: `FAIL - parseClientNote is not defined`

Do NOT expect it to pass. If it does, you're testing existing code, not new behavior.

- [ ] **Step 3: Write minimal implementation**

```typescript
export function parseClientNote(entry: string) {
  const [dateStr, text] = entry.split(' | ');
  return {
    date: new Date(dateStr),
    text: text,
  };
}
```

Keep it simple. Add only what makes the test pass. No edge cases. No performance optimization. Just the minimum.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/path/to/test.ts`
Expected output: `PASS - 1 test passed`

All other tests still pass? If not, something broke. Fix before moving on.

- [ ] **Step 5: Commit**

```bash
git add tests/path/to/test.ts src/path/to/file.ts
git commit -m "feat: parse client notes with date extraction"
```

Clear commit message. Reference the task number if it helps.
```

### 5. Dependencies and Order

Some tasks depend on others. Make this explicit.

```
### Task 1: Database schema (no dependencies)
### Task 2: Data access functions (depends on Task 1)
### Task 3: React component (depends on Task 2)
### Task 4: Add component to page (depends on Task 3)
```

Within a sprint, tasks execute in order. Sequential execution is fine — Sage will dispatch agents one at a time.

### 6. Plan Document Structure

Save to:
```
docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md
```

**Format:**
```markdown
# [Feature Name] Implementation Plan

> **For agents:** Use task-driven-development skill. Implement each task sequentially. For each task:
> 1. Implementer agent: write code, run tests, commit
> 2. Spec reviewer: verify code matches plan
> 3. Quality reviewer: verify code quality
> 4. Sage: dispatch next task

**Goal:** [One sentence: what this accomplishes]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key libraries/patterns]

**Total Tasks:** [N]

**Estimated Time:** [2-5 minutes per task = N * 3-5 minutes total]

---

### Task 1: [Name]
[Full task content as above]

### Task 2: [Name]
[Full task content as above]

...
```

### 7. Review Plan for Completeness

Before showing to user:

**Granularity check:** Is each step 2-5 minutes of actual work? If longer, split it.

**Concreteness check:** Is every step CONCRETE? No "TBD", "implement error handling", "handle edge cases."

Every step shows actual code. Code blocks include real, executable examples.

**Scope check:** Does this implement the full design? Check against approved spec.

**Clarity check:** Could a junior dev follow this without asking questions?

**Tech accuracy:** Are commands correct? Do imports match the actual project structure?

Fix issues before showing to user.

### 8. User Reviews Plan

Share the plan:

> Plan written and committed to `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`. Please review it and let me know:
> 1. Does it cover everything in the design?
> 2. Does the order make sense?
> 3. Any tasks too big or unclear?

Wait for feedback. If changes requested, update and self-review. Repeat until approved.

### 9. Transition to Sprint Execution

Once user approves:

> Plan approved. Transitioning to sprint-execution skill to dispatch agents for each task.

The sprint-execution skill reads this plan and dispatches Mason (or another agent) for each task, managing reviews and progress.

## Key Patterns

### Dependency Ordering

Some tasks must come first:
- Schema migrations before data access functions
- Data access functions before React components
- Core logic before UI

Make this explicit in the plan:
```
### Task 1: Schema migration
[Content]

> **Depends on:** Nothing
> **Blocks:** Tasks 2, 3

### Task 2: Data access functions
[Content]

> **Depends on:** Task 1
> **Blocks:** Task 3
```

### Handling Unknowns

During planning, you might realize something is unclear in the design.

**If small uncertainty:** Include the question in the plan:

```
- [ ] **Step 1: Create database migration**

Question for review: Should the `notes_at` timestamp be UTC or client timezone?
For now, assuming UTC.
```

**If big uncertainty:** Stop. Go back to brainstorming. Clarify with user first.

### custom workflow Specifics

#### Adding Supabase Columns

Start with the schema migration:
```
### Task 1: Add client billing columns

- [ ] **Step 1: Create migration file**

```sql
-- migrations/20240403-add-client-billing.sql
ALTER TABLE clients ADD COLUMN billing_rate DECIMAL(10,2);
ALTER TABLE clients ADD COLUMN billing_interval VARCHAR(20);
ALTER TABLE clients ADD COLUMN billing_start_date DATE;
```

- [ ] **Step 2: Run migration**

Run: `npm run db:migrate`
Expected: No errors, schema updated

...
```

Then data access layer (Forge or Mason handles this):
```
### Task 2: Data access for billing info

- [ ] **Step 1: Write failing test for billing lookup**

```typescript
test('should fetch client billing info', async () => {
  const result = await getClientBillingInfo(testClientId);
  expect(result).toHaveProperty('rate');
  expect(result).toHaveProperty('interval');
});
```

...
```

Then React component:
```
### Task 3: Billing section in ClientDetail

[Depends on Task 2]
```

This ordering ensures each layer is built on solid foundation.

#### Testing Strategy for custom workflow

custom workflow has 0 tests. Use this plan to build testing practices gradually:

- Task 1: Core logic with full test coverage
- Task 2: Data access with integration tests
- Task 3: React component with snapshot tests
- Task 4: E2E test for full workflow

This spreads test adoption across the sprint.

### Refactoring Plans

When refactoring (not new features), the plan is different:

```
### Task 1: Add comprehensive tests for existing code
[Don't change code yet, just test it]

### Task 2: Refactor with tests green
[Change code, ensure tests stay green]

### Task 3: Clean up tests if needed
[If test quality improved, update them]
```

This keeps existing behavior stable while improving code quality.

## Common Mistakes

### "Add Error Handling" as a Task

Too vague. Instead:

```
- [ ] **Step 1: Write test for missing client scenario**

test('should throw NotFoundError when client missing', () => {
  expect(() => getClient(-1)).toThrow(NotFoundError);
});

- [ ] **Step 2: Implement error handling**

```typescript
export function getClient(id: number) {
  if (id < 1) throw new NotFoundError(`Client ${id} not found`);
  return clients[id];
}
```
```

Concrete, testable, small.

### Tasks That Are Too Big

If a task takes more than 5 minutes, it's too big. Split it:

Bad:
```
Task 2: Implement API and React component
```

Good:
```
Task 2: API endpoint for fetching client
Task 3: React component for client display
Task 4: Wire component to page
```

### Placeholders

Never write:
- "TBD" — what should this be?
- "Handle edge cases" — which ones? How?
- "Implement validation" — what validates? How?
- "Follow patterns in codebase" — show the pattern

Every step should be copy-paste ready.

## Done When

- [ ] File structure is clear
- [ ] Tasks are bite-sized (2-5 minutes each)
- [ ] Each task has concrete code examples
- [ ] Dependencies are explicit and ordered correctly
- [ ] Plan document is written and committed
- [ ] Plan self-reviewed (no placeholders, no ambiguity)
- [ ] User approved the plan
- [ ] Sprint execution skill is next

## Related Skills

- **brainstorming** — Creates the design this plan implements
- **sprint-execution** — Follows this. Takes plan, dispatches agents
- **test-driven-development** — Used within each task
- **code-review** — Reviews completed tasks against this plan

## Example

See `examples/sonke-hub-sprint-schema.md` for a complete plan for adding client billing to custom workflow.
