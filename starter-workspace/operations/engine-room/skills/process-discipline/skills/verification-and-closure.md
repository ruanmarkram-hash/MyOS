# Verification and Closure: Confirm It's Done

Activate this when: A task or feature is complete and you need to confirm it works.

## Why This Matters

"Done" means different things to different people. Verification ensures everyone agrees on what "done" means, and the work actually achieves that.

## The Process

### 1. Read Success Criteria

From the design or plan:

```
Success criteria (from plan):
  - Users can add client billing rate
  - Billing rate displays in client detail page
  - Billing rate persists to database
  - Billing rate can be edited
```

This is your checklist.

### 2. Test Happy Path

Go through the normal flow:

```
1. Open client detail page
2. Click "Add billing rate"
3. Enter rate: 50.00
4. Click Save
5. Verify rate displays below client name
6. Refresh page
7. Verify rate still shows (persistence)
8. Click Edit
9. Change rate to 75.00
10. Save
11. Verify new rate displays
```

Does each step work? Yes or no.

### 3. Test Edge Cases

Beyond the happy path:

```
Edge cases:
  - Enter 0 as rate → Should it work? Plan says yes/no
  - Enter negative number → Rejected with error
  - Enter very large number → Works or truncates?
  - Leave field blank → Error or optional?
  - Delete client → Billing rate gone too? Check foreign keys
```

Check each against the design.

### 4. Check Database State

```bash
# If data layer changed, verify database
SELECT * FROM clients WHERE id = 'test-client-123';

# Is billing_rate column there?
# Is it populated correctly?
# Type correct (DECIMAL not STRING)?
```

### 5. Run Full Test Suite

```bash
npm test
npm run lint
npm run build
```

Everything passes? If not, fix or document.

### 6. Verify Logging and Monitoring

If feature has observability:

```
Did we add logging?
  - Log rate updates
  - Log errors
  
Can we monitor it?
  - Alert on errors
  - Dashboard for usage
```

### 7. Documentation Updated

Check:
- README.md mentions the feature?
- Code has comments explaining why?
- Migration documented?
- Any breaking changes noted?

### 8. Decide: Merge, Rework, or Discard

**Merge:** Feature meets all success criteria, tests pass, ready for users.

**Rework:** Something doesn't work or doesn't match design. Don't merge yet.

**Discard:** Feature isn't needed or never will be. Delete the branch.

Document the decision:

```
Verification result: APPROVED FOR MERGE

All success criteria met:
  ✓ Users can add billing rate
  ✓ Rate persists
  ✓ Rate can be edited
  ✓ Tests pass
  ✓ Database clean
  ✓ No logging errors

Ready to merge to main.
```

### 9. Create Handoff Notes

If this goes to operations or other team:

```
Feature: Client Billing Rates
Status: Ready for production
Deployed to: (will be, after merge)

What users should know:
  - New field on client page
  - Can edit any time
  - Affects billing calculations

What ops should monitor:
  - No error spikes in logs
  - Database query performance
  - Usage adoption

Known limitations:
  - Bulk edit not yet supported
  - Doesn't affect historical invoices
```

## Edge Cases by Type

### Database Changes

```
Verify:
  - Migration runs cleanly
  - Migration can be rolled back
  - Columns have right types
  - Constraints enforced (NOT NULL, UNIQUE)
  - Indexes exist where needed
  - No unexpected slowdowns
```

### API Changes

```
Verify:
  - Endpoint returns expected schema
  - Error cases handled and return right status codes
  - Authentication/authorization checked
  - Rate limiting works if applicable
  - Backward compatible or deprecation documented
```

### UI Changes

```
Verify:
  - Responsive on mobile/tablet/desktop
  - Accessible (keyboard nav, screen readers)
  - Dark mode if applicable
  - No console errors
  - Performance acceptable (<1s load)
```

### Performance Changes

```
Verify:
  - Benchmark before/after
  - Database queries use indexes
  - No n² loops
  - Memory usage reasonable
```

## custom workflow Specifics

### Client Features

Verify:
- [ ] Data displays in client list
- [ ] Data persists across page refreshes
- [ ] Can be edited by authorized roles
- [ ] Exports include the field
- [ ] Reports reflect new data

### Supabase Integration

Verify:
- [ ] RLS policies allow/deny correctly
- [ ] Real-time subscriptions work if needed
- [ ] Foreign keys don't break inserts
- [ ] Migrations include correct types

### React Components

Verify:
- [ ] Component renders without errors
- [ ] Props documented
- [ ] Error states handled
- [ ] Loading states present
- [ ] Accessibility checked (Tab, Enter, Screen readers)

## Verification Checklist

```
Feature: [name]

Success Criteria:
  [ ] Criterion 1
  [ ] Criterion 2
  [ ] Criterion 3

Testing:
  [ ] Happy path works
  [ ] Edge cases handled
  [ ] Error cases clear
  [ ] Database state correct
  [ ] Tests pass (npm test)
  [ ] Build succeeds (npm run build)
  [ ] Lint passes (npm run lint)

Documentation:
  [ ] README updated
  [ ] Code comments explain why
  [ ] Migrations documented
  [ ] Breaking changes noted

Verification Result:
  [ ] APPROVED FOR MERGE
  [ ] NEEDS REWORK
  [ ] DISCARD

Reviewer: [name]
Date: [date]
Notes: [any additional context]
```

## When Verification Fails

### Issue Found But Small

```
Scenario: Button text is unclear

Decision: Fix in same sprint
  1. Rename button
  2. Run tests
  3. Re-verify
  4. Merge
```

### Issue Found And Big

```
Scenario: Feature doesn't work on mobile

Decision: Rework required
  1. File issue
  2. Create new task
  3. Assign to next sprint
  4. Don't merge this feature yet
```

### Issue Found, Unfixable

```
Scenario: Requirement no longer makes sense

Decision: Discard
  1. Delete branch
  2. Document why
  3. Close the issue/task
```

## Done When

- [ ] All success criteria verified
- [ ] Happy path works
- [ ] Edge cases handled
- [ ] Tests pass
- [ ] Database/API/UI state correct
- [ ] Documentation updated
- [ ] Decision made (merge/rework/discard)
- [ ] Handoff notes created if needed
- [ ] Feature completion skill is next (if merging)

## Related Skills

- **sprint-execution** — Dispatches verification after implementation
- **test-driven-development** — Tests verify behavior
- **feature-completion** — Follows verification for merge/release

## Example

See `examples/sonke-hub-sprint-schema.md` for complete verification example.
