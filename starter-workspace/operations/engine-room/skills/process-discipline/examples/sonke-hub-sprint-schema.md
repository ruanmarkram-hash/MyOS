# Example: Add Client Billing Rates (Schema + UI)

A complete walk-through of the process-discipline framework applied to a real custom workflow feature: adding the ability to track client billing rates.

This example demonstrates:
- **brainstorming** → Design the feature
- **planning** → Break into tasks
- **sprint-execution** → Dispatch Forge (schema), then Mason (UI)
- **test-driven-development** → TDD within each task
- **code-review** → Two-stage review for each task
- **verification-and-closure** → Confirm it works
- **feature-completion** → Merge and ship

## Phase 1: Brainstorming

### Initial Idea
[YOUR NAME]: "Let's add the ability to track what we charge clients. Right now we have nothing."

### Design Conversation

**Sage runs brainstorming skill.**

**Charter (Research Agent):** Let me clarify a few things.

**Question 1:** What's the main goal here? Are you trying to:
- Track actual invoices/payments?
- Just have a rate we can reference for reporting?
- Use it to auto-calculate something?

**[YOUR NAME]:** Just a rate we can reference. Invoices are still done in the accounting system. This is so we know what we're charging each client.

**Question 2:** Who sees this? Is it:
- Support workers need to know for reference?
- Managers only?
- Everyone?

**[YOUR NAME]:** Managers and the lead support worker for each client.

**Question 3:** Can the rate change over time?

**[YOUR NAME]:** Yes, we might give discounts. And historical rates matter for reporting.

Charter: OK, so you need:
- A current rate per client
- History of rate changes
- Role-based visibility (managers + lead worker only)
- Reference in reports

### Design Document

Charter creates `docs/superpowers/specs/2024-03-15-client-billing-design.md`:

```markdown
# Client Billing Rates Design

## Goal
Track what we charge each client so managers and lead workers can reference it for reporting and customer communication.

## Requirements
- Store current billing rate per client
- Track rate changes over time (history)
- Display rate in client detail page
- Allow managers to set/edit rate
- Restrict visibility to managers and lead worker for that client
- Include rate in billing exports

## Architecture

### Data Model
```
clients table:
  - billing_rate_id (FK to billing_rates)
  - billing_rate_effective_date

billing_rates table:
  - id (primary key)
  - client_id (FK)
  - rate (DECIMAL(10,2))
  - start_date (DATE)
  - end_date (DATE, nullable)
  - created_by (user_id)
  - created_at
```

Reasons:
- Separate table allows full history tracking
- Enables rate change audit trail
- Foreign key maintains referential integrity
- Decimal(10,2) handles currency precisely

### User Experience
- Client detail page: Show "Current rate: $50/hour" under client name
- Edit button (for managers): Opens form with current rate
- Form allows: Enter new rate, confirm effective date (today or future)
- Change recorded with timestamp and user who made change

### Error Handling
- Invalid rate (negative, too large): Reject with clear message
- Deleting client: Keep rate history for reporting
- Can't set future rate that overlaps: Prevent conflicts
- Managers-only: Non-managers see rate but can't edit

## Success Criteria
- Users can set billing rate for any client
- Rate persists to database
- Rate displays in client detail page
- Rate changes are audited (history preserved)
- Unauthorized users cannot edit
- Reports can access rate (via join)
- All tests pass

## Out of Scope
- Bulk rate changes
- Automatic rate adjustments
- Rate templates
- Invoice generation from rate (handled elsewhere)
```

**[YOUR NAME]:** Looks good. Let's build it.

---

## Phase 2: Planning

### Plan Breakdown

**Sage runs planning skill.**

**Mason (Dev Agent)** creates `docs/superpowers/plans/2024-03-15-client-billing-plan.md`:

This will be built in two parallel streams:
1. **Forge (Database Agent):** Schema and data layer
2. **Mason (Dev Agent):** UI and component layer

Since they're dependent (Mason needs Forge's columns), Forge completes first, then Mason starts.

**Plan for Forge:**

```markdown
# Client Billing Rates — Database Schema Implementation Plan

> **For Forge:** Use test-driven-development for each task. Each task includes the actual SQL/code needed.

**Goal:** Create billing rates table, add relationships, write data access functions.

**Architecture:** Separate billing_rates table with full audit trail.

**Tech Stack:** Supabase (PostgreSQL), TypeScript, Vitest for tests.

**Total Tasks:** 4

---

### Task 1: Create billing_rates table migration

**Files:**
- Create: `database/migrations/20240315-create-billing-rates.sql`
- Test: `tests/unit/database/billing-rates.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
test('billing_rates table exists with correct schema', async () => {
  const result = await db.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'billing_rates'
  `);
  
  const columns = result.rows.map(r => r.column_name);
  expect(columns).toContain('id');
  expect(columns).toContain('client_id');
  expect(columns).toContain('rate');
  expect(columns).toContain('start_date');
  expect(columns).toContain('end_date');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/unit/database/billing-rates.test.ts`
Expected: FAIL — "relation \"billing_rates\" does not exist"

- [ ] **Step 3: Create migration**

```sql
-- database/migrations/20240315-create-billing-rates.sql
CREATE TABLE IF NOT EXISTS billing_rates (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  rate DECIMAL(10, 2) NOT NULL CHECK (rate >= 0),
  start_date DATE NOT NULL,
  end_date DATE,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_billing_rates_client_id ON billing_rates(client_id, end_date);
CREATE POLICY billing_rates_managers_read ON billing_rates 
  FOR SELECT USING (
    auth.jwt()->>'role' IN ('manager', 'admin')
  );
```

- [ ] **Step 4: Run migration**

Run: `npm run db:migrate`
Expected: Migration succeeds, table created

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test tests/unit/database/billing-rates.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add database/migrations/20240315-create-billing-rates.sql tests/unit/database/billing-rates.test.ts
git commit -m "feat: add billing_rates table with schema migration"
```

### Task 2: Add billing_rate_id to clients table

[Similar structure: write test, migrate, verify]

### Task 3: Write getBillingRate() data access function

[Similar structure: test, implement, commit]

### Task 4: Write updateBillingRate() with audit trail

[Similar structure: test, implement, commit]
```

**Plan for Mason:**

```markdown
# Client Billing Rates — React UI Implementation Plan

> **For Mason:** Forge's schema must be complete first. Use these exact column names from Forge:
> - clients.billing_rate_id
> - billing_rates.rate, start_date, end_date, created_by

**Goal:** Create UI for displaying and editing billing rates.

**Architecture:** New ClientBilling component, integrated into ClientDetail page.

**Tech Stack:** React, TypeScript, Supabase client, React Hook Form.

---

### Task 1: Write failing test for ClientBillingRate component

[Test that component displays rate]

### Task 2: Implement ClientBillingRate display component

[Shows current rate with formatting]

### Task 3: Write failing test for edit form

[Test form submission, validation]

### Task 4: Implement ClientBillingRateForm

[Form with submit, error handling]

### Task 5: Integrate into ClientDetail page

[Add component to page layout]

### Task 6: Add RLS permission check

[Verify user can edit]
```

**[YOUR NAME]:** Perfect. Let's build it.

---

## Phase 3: Sprint Execution

### Forge Runs First

**Sage briefs Forge:**

> Sprint: Add client billing rates
> Skill: sprint-execution with Forge leading (schema first)
> Plan: docs/superpowers/plans/2024-03-15-client-billing-plan.md (Forge section)
> Branch: feature/client-billing-schema
> 
> Task 1 of 4: Create billing_rates table
> 
> Instructions:
> 1. Read the full plan from [path]
> 2. Implement Task 1 exactly as described
> 3. Run migration and tests
> 4. When done, I'll dispatch review agents
> 
> Questions? Ask now.

**Forge works through tasks 1-4**, each with:
1. Test written (RED)
2. Test fails (verified)
3. Code/migration written (GREEN)
4. Test passes (verified)
5. Commit made

After Task 4 complete, Forge writes:

> Task 4 complete. Migration and all functions implemented and tested.
> Latest commit: a7981ec (feat: add updateBillingRate with audit)
> Ready for review.

### Spec Review (Task 4 Example)

**Sage dispatches spec reviewer:**

> Task 4 review: Spec compliance
> Plan: docs/superpowers/plans/.../client-billing-plan.md, Task 4
> Task name: Write updateBillingRate() with audit trail
> Code: [git log commits]
> 
> Verify:
> 1. Function signature matches spec?
> 2. Audit trail created (created_by, created_at recorded)?
> 3. Rate validation present (>= 0)?
> 4. Tests cover success and error cases?
> 
> Result: [Approve/Fix]

Reviewer returns: "✓ APPROVED. Function signature matches, audit trail implemented, error handling complete."

### Quality Review

**Sage dispatches quality reviewer:**

> Task 4 review: Code quality
> Code: [git log commits]
> 
> Standards: references/code-review-checklist.md
> 
> Check:
> 1. Function naming clear?
> 2. Tests well-written and maintainable?
> 3. Error messages helpful?
> 4. Performance OK (indexes present)?
> 
> Result: [Approve/Fix]

Reviewer returns: "✓ APPROVED. Clean implementation, tests readable, indexes look good."

### Then Mason's Turn

Once Forge completes all 4 tasks and passes both reviews:

**Sage briefs Mason:**

> Sprint: Add client billing rates (UI phase)
> Skill: sprint-execution with Mason
> Plan: docs/superpowers/plans/2024-03-15-client-billing-plan.md (Mason section)
> Branch: feature/client-billing-ui
> Base: feature/client-billing-schema (Forge's completed branch)
> 
> Important: Use these exact names from Forge's implementation:
> - clients.billing_rate_id (FK)
> - billing_rates.rate (DECIMAL)
> - billing_rates.start_date (DATE)
> - billing_rates.created_by (UUID)
> 
> Task 1 of 6: Write failing test for ClientBillingRate component
> 
> Instructions:
> 1. Read both plans
> 2. Checkout Forge's feature/client-billing-schema branch
> 3. Create your branch from there
> 4. Implement Task 1
> 5. When ready, spec and quality reviewers will check each task

Mason implements tasks 1-6, each with same review cycle.

### Checkpoint

After Forge's 4 tasks + Mason's 6 tasks all complete:

```
Sprint checkpoint: feature/client-billing
Phase: Complete (all 10 tasks)
Completed tasks: 10/10 (100%)
Commits: 20 (Forge: 4 commits, Mason: 16 commits)
Branch: feature/client-billing-ui
Latest commit: 3df7661
Blockers: None
Status: Ready for verification
```

---

## Phase 4: Test-Driven Development (Within Each Task)

### Example: Task 2 (Forge)

Task 2: Add billing_rate_id to clients table

**RED:** Write failing test
```typescript
test('clients table has billing_rate_id column', async () => {
  const result = await db.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'clients' AND column_name = 'billing_rate_id'
  `);
  expect(result.rows.length).toBe(1);
});
```

Run: `npm test` → FAIL (column doesn't exist)

**GREEN:** Write migration
```sql
ALTER TABLE clients ADD COLUMN billing_rate_id BIGINT 
  REFERENCES billing_rates(id) ON DELETE SET NULL;
```

Run: `npm run db:migrate` → Migration succeeds

Run: `npm test` → PASS (column exists)

**REFACTOR:** No changes needed, migration is clean.

Commit: `git commit -m "feat: add billing_rate_id FK to clients"`

All tasks follow RED-GREEN-REFACTOR.

---

## Phase 5: Code Review

### Spec Compliance Review Example

Task 3 (Forge): Write getBillingRate() function

**Spec reviewer checks:**
- Does getBillingRate(clientId) exist? ✓
- Does it query billing_rates table? ✓
- Does it return current rate (where end_date IS NULL)? ✓
- Does it handle "no rate found"? ✓
- Tests cover success and error? ✓

Result: ✓ APPROVED

### Quality Review Example

**Quality reviewer checks:**
- Function name clear? ✓ (`getBillingRate` is obvious)
- Tests maintainable? ✓ (Arrange-Act-Assert pattern)
- Error handling helpful? ✓ (Throws meaningful error)
- Performance? ✓ (Uses indexed columns)
- Comments needed? Edge case on line 12 could use a comment:

```typescript
// Handle case where no active rate exists (new client)
const rate = result.rows[0]?.rate || null;
```

Result: ✓ APPROVED (with minor comment suggestion)

---

## Phase 6: Verification and Closure

### Verification Checklist

```
Feature: Client Billing Rates

Success Criteria:
  [✓] Users can set billing rate for any client
  [✓] Rate persists to database
  [✓] Rate displays in client detail page
  [✓] Rate changes are audited
  [✓] Unauthorized users cannot edit
  [✓] All tests pass

Testing:
  [✓] Happy path: Set rate, display, edit, history
  [✓] Edge cases: Zero rate, future rate, delete client
  [✓] Error cases: Validation, permission denied
  [✓] Database: Correct columns, types, constraints
  [✓] Tests: 22 new tests, all passing
  [✓] Build: npm run build ✓
  [✓] Lint: npm run lint ✓

Documentation:
  [✓] README updated (Billing Rates section)
  [✓] Code comments explain audit logic
  [✓] Migration documented

Verification Result: ✓ APPROVED FOR MERGE

Reviewer: Sage
Date: 2024-03-15 15:45 UTC
Notes: Feature works end-to-end, tests comprehensive, no issues.
```

---

## Phase 7: Feature Completion

### Merge to Main

```bash
# Forge's branch merges first
git checkout main
git pull origin main
git merge feature/client-billing-schema
git push origin main

# Then Mason's branch
git checkout main
git pull origin main
git merge feature/client-billing-ui
git push origin main

# Clean up
git branch -d feature/client-billing-schema
git branch -d feature/client-billing-ui
```

### Release Notes

```markdown
# Release 2024-03-15

## New Features

**Client Billing Rates**
- Managers can now set and track billing rates for each client
- Rate accessible in client detail page
- Full history of rate changes maintained
- Rate visible only to managers and lead worker for client

## What Changed

- New `billing_rates` table in database
- New `clients.billing_rate_id` column (foreign key)
- New React components: `ClientBillingRate`, `ClientBillingRateForm`
- Updated `ClientDetail` page to display rate
- New data access functions: `getBillingRate()`, `updateBillingRate()`

## Migration

Automatic database migration on deploy. No data loss. Rollback available if needed.

## Testing

- 22 new tests added
- Full feature tested end-to-end
- Permission controls verified

## Known Limitations

- Bulk rate updates not yet supported (coming in next release)
- Historical rates not included in current invoice exports (handled separately)
```

### Handoff Notes

```
Feature: Client Billing Rates
Status: DEPLOYED
Deployed: 2024-03-15 16:00 UTC

What users see:
- Billing rate field in client detail page
- Managers can edit rate
- Rate history available in admin section

What to monitor:
- No errors on getBillingRate() queries
- Permission checks working (non-managers can't edit)
- Rate displays correctly for all client types

Known issues: None
Next steps: Bulk edit feature in next sprint (ticket #245)
```

---

## What This Example Shows

✓ Complete workflow from rough idea → shipped feature
✓ Two-stage review (spec + quality) for each task
✓ Sequential agent dispatch (Forge then Mason)
✓ TDD within each task (RED-GREEN-REFACTOR)
✓ Clear handoff between agents (exact column names)
✓ Verification before merge
✓ Merge and release

This is the full process-discipline framework in action.
