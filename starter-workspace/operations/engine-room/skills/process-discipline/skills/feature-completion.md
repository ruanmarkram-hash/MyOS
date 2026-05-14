# Feature Completion: Merge or Discard

Activate this when: Feature is fully implemented, tested, reviewed, and verified.

Decide: merge to main, create pull request, or discard.

## Decision Tree

```
Feature verified and approved?
  YES → Ready to merge
  NO → Go back to sprint-execution or rework
  
Should this merge to main?
  YES → Merge
  NO → Create PR (for review before merge)
  
Feature still needed?
  YES → Proceed
  NO → Discard
```

## Merge to Main

If feature is approved, tested, reviewed:

```bash
# Update main
git checkout main
git pull origin main

# Merge feature branch
git merge feature/client-billing

# Push to production
git push origin main

# Delete branch
git branch -d feature/client-billing
git push origin --delete feature/client-billing
```

Document completion:
```
Feature merged: Client Billing Rates
Merged by: Sage
Merged at: 2024-03-15 14:23 UTC
Branch: feature/client-billing
Commit: a7981ec

What changed:
  - Added billing_rate to clients table
  - New ClientBillingForm component
  - Updated ClientDetail page

Tests: All passing
Verification: Complete

Users can see this change on next deploy.
```

Update HANDOFF.md with completion status.

## Create Pull Request

If feature needs more eyes before merge:

**When to use PR:**
- Major architectural change
- Touches shared code
- New patterns or dependencies
- Team wants to discuss before shipping

```bash
# Push feature branch
git push origin feature/client-billing

# Create PR on GitHub/GitLab
Title: "feat: add client billing rates"
Description: 
  Implements ability to track and display client billing rates.
  
  What changed:
  - Added billing_rate column to clients
  - New form for editing rates
  - Display in client detail page
  
  Testing:
  - 12 new tests, all passing
  - Verified database persistence
  - Tested edge cases (zero, negative, large values)
  
  Related to: [issue #123]
```

Wait for reviews, address feedback, merge when approved.

## Discard Feature

If feature is no longer needed:

```bash
# Delete local branch
git branch -d feature/client-billing

# Delete remote branch
git push origin --delete feature/client-billing

# Document why
Feature discarded: Client Billing Rates
Reason: Billing handled by accounting system, no longer needed in app
Deleted: 2024-03-15
Commits lost: None (keep on branch, archived locally if needed)
```

## Release Checklist

Before shipping to production:

### Code Quality
- [ ] All tests passing
- [ ] Lint clean (no warnings)
- [ ] Build succeeds
- [ ] Code reviewed and approved

### Documentation
- [ ] README updated
- [ ] Migration notes if needed
- [ ] API docs updated if applicable
- [ ] User-facing changes documented

### Database
- [ ] Migrations are reversible
- [ ] Backups taken
- [ ] Migration tested on staging
- [ ] No data loss expected

### Performance
- [ ] Database queries optimized
- [ ] No memory leaks
- [ ] Load times acceptable

### Security
- [ ] No credentials in code
- [ ] RLS policies enforced (Supabase)
- [ ] Input validation present
- [ ] No obvious vulnerabilities

### Monitoring
- [ ] Logging in place
- [ ] Error tracking configured
- [ ] Alerts set up for failures
- [ ] Dashboard available for monitoring

## Release Notes

Create release notes for users:

```markdown
# Release: [Date]

## New Features
- **Client Billing Rates:** Users can now set and track billing rates per client
  - Set rate in client detail page
  - Rate used in billing calculations
  - Rate history available in reports

## Improvements
- Faster client list loading (added index on status)
- Improved error messages for billing conflicts

## Fixes
- Fixed date format in client notes export

## Migration Notes
- Automatic database migration on deploy
- No data loss
- Rollback available if needed

## Known Issues
- Bulk edit of billing rates coming in next release
- Historical invoices not retroactively updated

## Support
- Questions? Contact: support@sonke.local
- Issues? File in: [issue tracker]
```

## Rollback Plan

If something goes wrong after merge:

**Quick rollback:**
```bash
# Revert the merge commit
git revert -m 1 <merge-commit-sha>
git push origin main
```

**Full rollback:**
```bash
# Go back to before merge
git reset --hard <previous-sha>
git push origin main -f  # Only if no one pushed after merge

# And reset database
migrations/rollback.sh  # If applicable
```

Keep rollback scripts updated.

## Done When

- [ ] Feature verified and approved
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Merged or PR created
- [ ] Branch deleted
- [ ] Release notes written
- [ ] Monitoring configured
- [ ] Rollback plan ready
- [ ] Handoff notes updated

## Related Skills

- **verification-and-closure** — Precedes this, confirms feature works
- **sprint-execution** — Completes when feature-completion finishes

## custom workflow Specifics

### Database Schema Changes

After merging Forge's schema branch:

```
1. Run migrations on staging
2. Test all queries still work
3. Verify performance
4. Run full test suite
5. Merge to main
6. Deploy migrations to production
```

### Multiple Agent Handoff

When Forge (schema) and Mason (UI) both merge:

```
Order matters:
  1. Forge's PR merged first (schema)
  2. Mason's PR merged second (depends on schema)
  3. Both now in main
```

Ensure Forge is merged before Mason so CI doesn't break.

## Example

See `examples/sonke-hub-sprint-schema.md` for complete example of feature completion.
