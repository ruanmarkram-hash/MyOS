# Code Review Checklist

Use this as a reference when reviewing code during the code-review skill.

## Pre-Review

- [ ] Code builds without errors
- [ ] All tests pass locally
- [ ] Author ran linter (no style issues)
- [ ] Branch is up-to-date with main
- [ ] Tests are included

## Stage 1: Spec Compliance (Objective)

Does code match the plan?

### Requirements
- [ ] All requirements from plan are implemented
- [ ] No requirements were skipped or partially done
- [ ] No extra features added (scope creep)
- [ ] Behavior matches design spec

### Testing
- [ ] All test cases from plan exist
- [ ] Tests verify spec requirements
- [ ] Tests cover happy path
- [ ] Tests cover documented error cases
- [ ] Edge cases from spec are tested

### Commits
- [ ] Commits follow task structure
- [ ] Commit messages are clear and descriptive
- [ ] Commits are atomic (one logical change per commit)
- [ ] No large "dump everything" commits

### Integration
- [ ] All dependencies resolved
- [ ] No broken imports
- [ ] No integration bugs with existing code
- [ ] Migration is reversible (if database change)

**Decision:** Approve / Request fixes / Send back

---

## Stage 2: Code Quality (Subjective, Standards-Based)

Is code well-written and maintainable?

### Readability
- [ ] Variable names are clear and descriptive
- [ ] Function names clearly describe what they do
- [ ] Logic is easy to follow
- [ ] Complex sections have comments explaining *why*
- [ ] No misleading or cryptic code

### Structure
- [ ] Functions are appropriately sized (not too long)
- [ ] No excessive nesting
- [ ] Related code is grouped together
- [ ] Separation of concerns is clear
- [ ] No duplicate code (DRY principle)

### Error Handling
- [ ] Error cases are handled
- [ ] Error messages are helpful
- [ ] Invalid input is rejected
- [ ] No silent failures
- [ ] Stack traces would be useful for debugging

### Performance
- [ ] No obvious performance issues
- [ ] Database queries are efficient (indexes used)
- [ ] No n² loops on large data
- [ ] No unnecessary API calls
- [ ] No synchronous operations blocking UI

### Security
- [ ] No credentials in code
- [ ] Input is validated
- [ ] SQL injection not possible
- [ ] Authentication/authorization checked
- [ ] No XSS vulnerabilities
- [ ] Sensitive data not logged

### Testing (Quality)
- [ ] Tests are readable
- [ ] Test names describe what they test
- [ ] Tests are independent (no cross-dependencies)
- [ ] Setup/teardown is clean
- [ ] No flaky tests
- [ ] Tests focus on behavior, not implementation

### Style & Conventions
- [ ] Follows project coding standards
- [ ] Consistent with existing code patterns
- [ ] Type annotations where appropriate
- [ ] No unused imports
- [ ] Proper indentation and formatting

### Documentation
- [ ] Public functions have comments
- [ ] Comments explain *why*, not *what*
- [ ] Complex algorithms are explained
- [ ] Type signatures are clear
- [ ] README updated if necessary
- [ ] Breaking changes documented

**Decision:** Approve / Request improvements / Send back

---

## custom workflow Specific

### Database Changes (Supabase)

**Additional checks:**
- [ ] Migration creates new columns (doesn't modify existing)
- [ ] Column types are correct (DECIMAL for money, not INT)
- [ ] NOT NULL constraints documented (why is it required?)
- [ ] Foreign keys prevent orphaned records
- [ ] Indexes added for join/filter columns
- [ ] RLS policies updated if applicable
- [ ] Migration is tested on staging
- [ ] Rollback plan documented

### React Components

**Additional checks:**
- [ ] Props are properly typed
- [ ] Event handlers don't bind in render
- [ ] No unnecessary re-renders
- [ ] Dependencies array is complete (useEffect)
- [ ] Keyboard navigation works
- [ ] Error boundary/fallback UI present
- [ ] Loading states shown to users
- [ ] Accessibility tested (screen reader, tab navigation)

### Data Access Layer

**Additional checks:**
- [ ] RLS policies enforced
- [ ] No hardcoded user IDs or roles
- [ ] Error messages don't leak data
- [ ] Queries are parameterized (not string concatenated)
- [ ] Timestamps/dates handled consistently
- [ ] NULL values handled correctly

---

## Handling Feedback

### When You're the Reviewer

**Give constructive feedback:**

```
GOOD: "This query will be slow on large datasets. Consider adding an index on status_id, or use pagination."

BAD: "This is inefficient"
BAD: "I don't like this approach"
```

**Explain the reasoning:**

```
GOOD: "Async/await is clearer than Promise chaining in this case"

BAD: "Use async/await"
```

**Distinguish between rules and preferences:**

```
GOOD: "Our style guide requires spaces around operators"
BAD: "I prefer spaces around operators"
```

### When You're Being Reviewed

**Disagree respectfully:**

```
Reviewer: "Use const instead of let"
You: "This variable needs to be reassigned on line 45, so let is correct here"

Reviewer: "Ah, I missed that. Approved."
```

**Ask for clarification:**

```
Reviewer: "This is inefficient"
You: "Can you explain what the concern is? Is it about database performance or runtime performance?"

Reviewer: [explains] "Ah, I see. Here's how I addressed it: [explanation]"
```

**Fix or explain:**

```
Reviewer: "Should this validate email addresses?"
You: "Yes, good catch. Added validation on line 30."

OR

You: "Email validation happens elsewhere in the auth layer, so not needed here."
```

---

## Common Issues to Watch For

### Hidden Assumptions
```
Bad: Code assumes user role is never null
Review: "What if role is null? Can this be?"
```

### Edge Cases
```
Bad: Code works for normal data, breaks on edge case
Review: "What if there's only one item? Empty list? 1000 items?"
```

### Silent Failures
```
Bad: Query runs but returns empty list when should error
Review: "Should this throw if no results found?"
```

### Type Safety
```
Bad: Function accepts 'any' type
Review: "Can we be more specific about what types are accepted?"
```

### Testing Gaps
```
Bad: Happy path tested, error case not
Review: "What if the API fails? Database down? Authentication fails?"
```

---

## Turnaround Times

Aim for:
- **Spec compliance review:** 10-15 minutes
- **Quality review:** 15-20 minutes
- **Total per task:** 25-35 minutes

If review takes longer:
- Plan might be too ambitious
- Code might be too complex (refactor?)
- Need to delegate part of review

---

## When to Override

You don't have to follow every suggestion. But know why:

```
"This feedback is out of scope for this task"
"That's handled in a separate PR"
"It's not in the style guide, so not blocking"
```

Just be deliberate and communicate.

---

## Red Flags (Block Merge)

```
- Security vulnerability (SQL injection, XSS, auth bypass)
- Test failure
- Broken code (doesn't compile/run)
- Missing error handling
- Migration that can't be rolled back
- Spec not met
```

These require fixes before merge.

---

## Yellow Flags (Request Improvements)

```
- Unclear variable names (minor fix)
- Missing comment on complex logic (minor)
- Potential performance issue (discuss first)
- Test coverage < 80% (why?)
- Style inconsistency (unless critical)
```

These should be addressed before merge, but discuss if necessary.

---

## Green Flags (Nice to See)

```
- Tests cover happy path and errors
- Clear variable/function names
- Comments explain design decisions
- Performance considered
- Security thought through
- RLS policies configured
- Database migration tested
```

These are what great code looks like.
