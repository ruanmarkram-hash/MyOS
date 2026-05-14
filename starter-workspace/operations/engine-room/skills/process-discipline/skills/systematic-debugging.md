# Systematic Debugging: Find Root Causes

Activate this when: Something is broken and you need to fix it.

The iron law: **Find root cause before attempting any fix.**

## Why This Matters

Random fixes waste time and create new bugs. A "quick patch" hides underlying issues that bite you later.

Systematic debugging forces you to understand what's actually broken, not just what you see.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1 (Root Cause Investigation), you cannot propose fixes.

## The Four Phases

### Phase 1: Root Cause Investigation

#### 1.1 Read Error Messages Carefully

Don't skip error output. Read the entire stack trace.

**Look for:**
- What function failed?
- What line number?
- What was the input?
- What was expected?

```
Example error:
TypeError: Cannot read property 'name' of undefined
  at getClientName (src/lib/supabase/client.ts:23:15)
  at ClientCard (src/components/ClientCard.tsx:45:8)

What it says:
- getClientName tried to access .name on undefined
- Happened at line 23 of client.ts
- Called from ClientCard at line 45

Root cause lead: client.ts is receiving undefined when it shouldn't
```

#### 1.2 Reproduce Consistently

Can you trigger it reliably?

```
Questions:
- What exactly triggers the error?
- Do you get it every time, or randomly?
- Does it happen on fresh data, old data, both?
- Is it reproducible in test? In production?
```

**If not reproducible:** Gather more data before moving on.

```
Add logging:
console.log('Input to getClientName:', input);
console.log('Client object:', client);
```

Run again, capture logs. Now you have evidence.

**If reproducible:** You can test your fix later.

#### 1.3 Check Recent Changes

What changed that could cause this?

```bash
# What changed in the relevant file?
git log --oneline src/lib/supabase/client.ts | head -5

# What did the latest commit change?
git show HEAD

# What changed between here and main?
git diff origin/main..HEAD
```

Look for:
- New function signatures (client.name → client.fullName?)
- New database columns (migrated, but not in code?)
- Environment variables changed?
- Dependencies updated?

#### 1.4 Gather Evidence in Multi-Layer Systems

**If system has multiple components** (frontend → API → database):

Add logging at each boundary:

```
Frontend → API: What data is being sent?
API → Database: What query is being built?
Database → API: What data is returned?
API → Frontend: What's in the response?
```

```typescript
// Frontend
console.log('Sending to API:', JSON.stringify(payload, null, 2));

// API
app.post('/api/clients', (req, res) => {
  console.log('Received:', JSON.stringify(req.body, null, 2));
  
  const result = await db.query('SELECT * FROM clients WHERE id = ?', [req.body.id]);
  console.log('Database returned:', result);
  
  res.json(result);
});

// Run the action once
// Examine logs to see where data breaks
```

This reveals **which layer is failing**.

#### 1.5 Trace Data Flow Backward

Once you know which layer, trace backward:

```
ERROR: "Cannot read .name of undefined" in getClientName

Work backward:
  - What does getClientName receive? (Check logs)
  - Who called getClientName? (Check stack trace)
  - What did the caller expect to pass? (Check code)
  - Who created that data? (Check line before caller)
  - Is that creation wrong, or is the expectation wrong?
```

Keep tracing up until you find the source.

```
Tracing for client.name error:

ClientCard.tsx line 45: calls getClientName(client)
  ← client comes from Props
  
Props come from ClientDetail page at line 120
  ← client = await getClient(id)

getClient() in supabase/client.ts line 20
  ← returns result from database
  
Database query at line 18
  ← SELECT * FROM clients WHERE...

Wait: database result doesn't have 'name' column?
  
Check schema:
  ← clients table has 'full_name', not 'name'

ROOT CAUSE FOUND: Code expects 'name', database column is 'full_name'
```

### Phase 2: Pattern Analysis

Once you know what's broken, find the pattern.

#### 2.1 Find Working Examples

Locate similar code that works:

```
Broken: getClientName() tries to access client.name
Working: getClientBillingRate() tries to access client.billing_rate

Compare:
- getClientBillingRate uses 'billing_rate'
- getClientName uses 'name'
- Database has 'full_name', not 'name'

Pattern: Column names don't match variable names
```

#### 2.2 Compare Against Reference

If implementing a pattern, read reference implementation:

```typescript
// Reference: how other code accesses client data
const rate = client.billing_rate;  // ← Pattern: matches database column name
const status = client.account_status;  // ← Pattern: matches database column name

// Broken: how you wrote it
const name = client.name;  // ← Doesn't match database 'full_name'
```

#### 2.3 Identify Differences

List every difference between working and broken:

```
Working:                        Broken:
client.billing_rate      ←→     client.name
database column: billing_rate   database column: full_name
getters consistent                getters don't match schema
```

Don't assume "that can't matter". It probably does.

#### 2.4 Understand Dependencies

What else depends on this code?

```
getClientName() is used in:
  - ClientCard component (UI)
  - ClientBio section (UI)
  - Email templates (backend)

If we change how getClientName works:
  - All three places need to work
  - Tests for all three need to pass
```

### Phase 3: Hypothesis and Testing

#### 3.1 Form Single Hypothesis

```
HYPOTHESIS: client.name doesn't exist because database column is client.full_name

Evidence:
  - Error: Cannot read .name of undefined
  - Database schema shows: full_name, not name
  - Similar getters use exact column names
  - No transformation layer currently exists

Test plan:
  - Confirm database column name
  - Check if transformation exists elsewhere
  - If not, add transformation or change code
```

#### 3.2 Test the Hypothesis (Not Fix Yet)

**Don't write a fix yet.** Test the hypothesis.

```typescript
// Test: Is the column really named full_name?
const client = await db.query('SELECT * FROM clients LIMIT 1');
console.log('Columns in client:', Object.keys(client));
// Output: [ 'id', 'full_name', 'email', 'status' ]

// Confirms: column is 'full_name', not 'name'
```

Confirming the hypothesis is different from fixing the bug.

#### 3.3 Examine Related Code

Before fixing, check:

```
If we change client.name → client.full_name:
  - Does getClientName() exist for a reason?
  - Should we keep the abstraction?
  - Are there other places that use client.name?

If we create a transformation:
  - Do other getters transform too?
  - Should this be in a data layer or in component?
```

### Phase 4: Fix (Only After Root Cause Confirmed)

Now you fix, based on understanding.

**Option A: Change the code**
```typescript
// getClientName now matches database
export function getClientName(client) {
  return client.full_name;  // Changed from client.name
}
```

**Option B: Create transformation layer**
```typescript
// Add transformation so component API stays clean
const clientWithName = {
  ...client,
  name: client.full_name  // Transform on read
};
```

**Option C: Migration + code**
```typescript
// Rename database column to match code expectations
ALTER TABLE clients RENAME COLUMN full_name TO name;

// Then code stays as-is
export function getClientName(client) {
  return client.name;  // Now correct
}
```

**Pick the one that makes sense.** You understand the system now. The fix will be right.

## Key Patterns

### "It Works on My Machine"

Environment differences are often root causes.

Check:
```
- Database version?
- Node version?
- Environment variables?
- Cached data (browser, Redis)?
- Different test data?
```

```typescript
// Add diagnostic logging
console.log('Node version:', process.version);
console.log('DATABASE_URL:', process.env.DATABASE_URL?.substring(0, 30) + '...');
console.log('System timezone:', new Date().getTimezoneOffset());
```

### Silent Failures

Some bugs don't error, they just return wrong data.

```
No error, but:
  - Empty list when shouldn't be
  - Stale data in UI
  - Missing fields in response

Add assertions:
  expect(result.length).toBeGreaterThan(0);
  expect(result).toHaveProperty('name');
```

### Heisenbug (Only Happens When Not Looking)

Timing-dependent bugs, concurrency issues.

```
Debug approach:
  - Add logging to track state changes
  - Run repeatedly to see if it's random
  - Check for race conditions
  - Look for shared mutable state
```

### Search Strategically

If you're lost, search the codebase:

```bash
# Where is this function defined?
grep -r "getClientName" src/

# Who calls this function?
grep -r "getClientName(" src/

# What database tables exist?
grep "CREATE TABLE" database/migrations/

# What environment variables are used?
grep "process.env" src/lib/
```

## custom workflow Examples

### Example 1: Supabase Query Fails

```
Error: "Row not found"
Where: Fetching client notes

Root cause investigation:
  - Check error message → "No client with ID 123"
  - Check code → SELECT * FROM clients WHERE id = ?
  - Check logs → What ID is being passed?
  - Check data → Does client 123 exist?
  
Tracing reveals:
  - Code passes client.id = "123" (string)
  - Database expects id INT
  - Query fails because "123" != 123
  
Fix: parseInt(clientId) before query
```

### Example 2: React Component Doesn't Update

```
Error: UI shows old data after client update

Root cause investigation:
  - Check React logs → is state updating?
  - Check API → is update API returning new data?
  - Check Supabase → is data actually updated?
  - Check component → is it re-rendering?

Tracing reveals:
  - Update API works
  - Component doesn't re-render
  - onSuccess callback not called
  
Fix: Check if fetch was aborted, retry logic broken, or event listener missing
```

## Done When

- [ ] Error reproduced consistently
- [ ] All error messages read
- [ ] Recent changes reviewed
- [ ] Evidence gathered from logs
- [ ] Root cause identified (not symptom)
- [ ] Pattern analyzed (how should this work?)
- [ ] Hypothesis formed and tested
- [ ] Ready for fix (you understand the system now)
- [ ] Fix will be targeted and correct

## Related Skills

- **test-driven-development** — After fix, write test to prevent regression
- **code-review** — Review the fix, ensure it's correct
- **verification-and-closure** — Confirm fix actually resolves the issue

## Example

See `examples/sonke-hub-sprint-bugfix.md` for a complete debugging walkthrough.

## Common Mistakes

### Guessing and Patching

```
Bad: "Maybe this will work?" [randomly changes code]
Good: "Let me understand what's happening first"
```

### Fixing the Symptom

```
Bad: [Error on line 23] → Comment out line 23 → No error → "Fixed!"
Good: [Error on line 23] → Understand why line 23 is wrong → Fix root cause
```

### Not Reproducing

```
Bad: "I think I know what's wrong" [writes fix without testing]
Good: "Let me reproduce it first" [run tests, confirm fix works]
```

### Ignoring Related Issues

```
Bad: Fix one bug, ship, find related bug later
Good: Fix one bug, look for similar patterns, prevent both
```
