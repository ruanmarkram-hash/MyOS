# Root Cause Tracing: A Detailed Guide

Reference for systematic-debugging skill. This guide walks through the exact process of tracing data flow to find root causes.

## The Principle

**Data flows through your system. Follow it backward. Root cause is where the data breaks.**

```
User sees X (wrong)
  ↑ (trace backward)
Component received X (wrong)
  ↑
API returned X (wrong)
  ↑
Database contains X (wrong) ← ROOT CAUSE
```

Don't stop at symptoms. Trace all the way to where data originates.

## Step 1: Understand the Symptom

What exactly is wrong?

```
Bad: "It doesn't work"
Good: "Client name shows as 'undefined' in detail page"

Bad: "Performance is slow"
Good: "Client list page takes 5+ seconds to load, list has 500 clients"

Bad: "Test fails"
Good: "Test: 'should fetch client' expects result.name = 'Alice', got undefined"
```

Be specific. The more specific, the easier to trace.

## Step 2: Find Where It Breaks

Test at each layer:

```
Layer 1: Database
  SELECT name FROM clients WHERE id = 'abc123';
  Result: ✓ (returns 'Alice')

Layer 2: API
  curl https://app.local/api/clients/abc123
  Result: ✗ (returns { name: undefined })

Layer 3: React Component
  console.log(client.name)
  Result: ✗ (undefined)
```

Found it: Layer 2. The API is broken, not database or component.

## Step 3: Dive Deeper

Once you found the broken layer, trace within it.

**API is broken. Why?**

```
Route handler receives request ✓
  ↓
Queries database ✓ (returns { name: 'Alice' })
  ↓
Builds response object ✗ (returns { name: undefined })
  ↓
Sends to client
```

Now found it: Response building is wrong.

## Step 4: Read the Code

Now look at the exact code at the failure point.

```typescript
// src/api/clients.ts
app.get('/api/clients/:id', async (req, res) => {
  const client = await db.query('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  
  res.json({
    id: client.id,
    name: client.full_name,  ← HERE: client.full_name, not client.name
    email: client.email,
  });
});
```

**Root Cause:** Code accesses `client.full_name` but component expects `name`.

Database has `full_name`. Code accesses it correctly. But response object has wrong key.

## Step 5: Understand the Context

Why is response wrong? Is it a typo or intentional?

```
Check recent commits:
  git log -p src/api/clients.ts | head -50

Check database schema:
  \d clients  (in Postgres)
  -- full_name column exists ✓

Check component expectation:
  // ClientDetail.tsx line 45
  <h1>{client.name}</h1>  ← expects 'name'

Check if transformation exists elsewhere:
  grep -r "full_name" src/
  -- Only in api/clients.ts
```

**Understanding:** Database changed from `name` to `full_name` column. API code updated. Component code didn't update. 

Or: Component is new and doesn't know about the database schema.

## Step 6: Formulate Hypothesis

Based on evidence, what's the most likely root cause?

```
Hypothesis 1: Database column renamed, component not updated
Evidence for:
  - Database has full_name (verified)
  - API code uses full_name (verified)
  - Component uses name (verified)
  - No transformation layer exists
Likelihood: ✓✓✓ Very likely

Hypothesis 2: API doesn't access database
Evidence for:
  - Logs show API returns undefined
Likelihood: ✗ Disproven (logs show correct data from database)

Hypothesis 3: Component receives data wrong
Evidence for:
  - API sends { name: undefined }
  - So API is wrong, not component
Likelihood: ✗ Disproven
```

**Best hypothesis:** Database schema changed, API updated, component not updated.

## Step 7: Test Hypothesis

Don't fix yet. Verify your hypothesis.

```typescript
// Add logging to verify hypothesis
app.get('/api/clients/:id', async (req, res) => {
  const client = await db.query('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  
  console.log('Client from database:', client);
  // Output: { id: 'abc123', full_name: 'Alice', email: '...' }
  
  console.log('Response being sent:', { name: client.full_name });
  // Output: { name: 'Alice' }
  
  res.json({ name: client.full_name });
});
```

Run the endpoint. Check logs.

**Verification:**
- Database returns { full_name: 'Alice' } ✓
- Response is { name: 'Alice' } ✓
- But component receives undefined? ✗

So response from API is correct. Where does it break next?

Add logging in component:

```typescript
// ClientDetail.tsx
useEffect(() => {
  fetch(`/api/clients/${clientId}`)
    .then(res => res.json())
    .then(data => {
      console.log('Component received:', data);
      setClient(data);
    });
}, []);
```

Run page. Check browser console.

**Output:** `Component received: { name: undefined }`

So API is sending `{ name: undefined }`, not `{ name: 'Alice' }`.

**Hypothesis wrong!** API isn't correctly accessing database.

## Step 8: Re-trace with Evidence

New evidence: API is not correctly passing data from database.

```typescript
// api/clients.ts
app.get('/api/clients/:id', async (req, res) => {
  const client = await db.query('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  console.log('Database result:', client);
  
  // What is client actually?
  // { id: 'abc123', full_name: 'Alice', email: '...' }
  
  // Then why send undefined?
  res.json({
    id: client.id,
    name: client.name,  ← WAIT. Should be client.full_name
    email: client.email,
  });
});
```

**Oh!** API code has `client.name` but database column is `client.full_name`.

That's the bug.

## Step 9: Confirm and Fix

**Confirmed root cause:** API accesses `client.name` but database has `client.full_name`.

**Fix:** Change API to use correct column name.

```typescript
res.json({
  id: client.id,
  name: client.full_name,  ← Changed
  email: client.email,
});
```

Or: Add transformation in API

```typescript
const response = {
  id: client.id,
  name: client.full_name,  // Transform database column to API field
  email: client.email,
};
res.json(response);
```

## Tracing Patterns

### Pattern 1: Data Passes Through Layers

```
Database → API → Component

Check each layer independently:
  - Database has correct data?
  - API receives correct data?
  - API sends correct data?
  - Component receives correct data?

Find where it breaks.
```

### Pattern 2: Caching Issues

```
You updated database, but component shows old data.

Trace:
  - Database has new data? ✓
  - API returns new data? ✗ (returns cached)
  - Browser cache has old data? (maybe)
  - Redux/Zustand has old state? (maybe)
```

### Pattern 3: Schema Mismatch

```
Code expects field 'name', database has 'full_name'.

Trace:
  - Database schema: SELECT * FROM clients;
    → Shows: full_name, not name
  - API code: client.name
    → Wrong field
  - Component: client.name
    → Expects what API sends (undefined)
```

### Pattern 4: Permission Issues

```
User can't see data, even though it exists.

Trace:
  - Data exists in database? ✓
  - Query is correct? ✓
  - RLS policy blocks query? ✗ (Supabase specific)
  - User has right role? ✗

Root cause: RLS policy denies permission.
```

### Pattern 5: Race Conditions

```
Data is correct sometimes, wrong sometimes.

Trace:
  - Race between two updates?
  - Subscription not fires before component mounts?
  - Async operation completes out of order?
  - Parallel requests conflict?
```

## Common Mistakes

### Stopping Too Early

```
Wrong:
  Component shows undefined
  → "Component has a bug"
  
Right:
  Component shows undefined
  → API sends undefined
  → API gets wrong field from database
  → Database has field_name, code uses field_wrong
  → ROOT CAUSE: Schema mismatch
```

Keep tracing.

### Tracing Forward Instead of Backward

```
Wrong (tracing forward):
  1. Component renders
  2. Component fetches data
  3. API receives request
  4. Where's the bug?

Right (tracing backward):
  1. Component shows wrong result
  2. What did component receive from API?
  3. What did API send?
  4. What did API get from database?
  5. What does database have?
```

Work backward from the symptom.

### Assuming Instead of Testing

```
Wrong:
  "It's probably a cache issue"
  → Don't test, just clear cache
  → Doesn't help

Right:
  "It might be a cache issue"
  → Clear cache, run again
  → Does it help? Yes/no
  → If no, move to next hypothesis
```

Test your hypotheses.

### Mixing Multiple Hypotheses

```
Wrong:
  "Let me fix the cache AND update the API AND reload the page"
  → If it works, which fix was it?
  → Can't tell

Right:
  "Let me clear the cache first"
  → Test
  → "If that doesn't work, I'll check the API"
  → Test one thing at a time
```

Change one thing. Test. Verify. Next.

## custom workflow Examples

### Example 1: Client Not Found

```
Symptom: User gets error "Client not found"

Trace backward:
  - getClient(id) threw error?
  - Check: ID is correct format?
  - Check: Client actually exists in database?
  - Check: RLS policy allows user to see it?
  - Check: User authenticated?

Root causes to test:
  1. Client doesn't exist (delete client, try fetching)
  2. ID wrong (print ID being used)
  3. RLS policy blocks it (check policy)
  4. User not authenticated (check auth token)
```

### Example 2: Slow Page Load

```
Symptom: Client list page takes 10 seconds to load

Trace:
  - Database query slow? (EXPLAIN ANALYZE)
  - API slow? (measure endpoint time)
  - Component rendering slow? (React DevTools profiler)
  - Network slow? (browser dev tools)

Root causes to test:
  1. 500 clients loading (need pagination)
  2. Missing index on filtered column
  3. Component re-rendering on every keystroke
  4. Large bundle size
```

### Example 3: RLS Denies Permission

```
Symptom: Non-manager user can't see billing rate

Trace:
  - Billing rate in database? ✓
  - Query syntax correct? ✓
  - RLS policy exists? (SELECT * FROM pg_policies)
  - Policy allows SELECT? Check USING clause

Root cause:
  Policy might have wrong role check:
  
  CREATE POLICY bad_policy ON billing_rates
  FOR SELECT
  USING (auth.jwt()->>'role' = 'owner')  ← Wrong role name
  
  Should be 'manager', not 'owner'
```

## Checklists

### Data Layer Debugging

- [ ] Database has correct data (SELECT * verify)
- [ ] Query syntax correct (copy query to database tool, run)
- [ ] RLS policy allows query (check pg_policies)
- [ ] Indexes present on filtered columns
- [ ] Types match (INT query with VARCHAR column?)
- [ ] NULLs handled correctly
- [ ] Join foreign keys exist

### API Debugging

- [ ] Route handler exists (curl the endpoint)
- [ ] Request parameters correct (log req.params)
- [ ] Database query executes (query database directly)
- [ ] Response format correct (log res before sending)
- [ ] Authentication required (user logged in?)
- [ ] Authorization checked (user has role?)
- [ ] Error handling present (what if database fails?)

### Component Debugging

- [ ] Component mounts (log in useEffect)
- [ ] API called (network tab in DevTools)
- [ ] Response received (log it)
- [ ] State updated (log in setState)
- [ ] Component re-renders (React DevTools)
- [ ] Props changed (check prop values)
- [ ] Subscription active (real-time working?)

## Tools

```bash
# Database inspection
\d table_name              # Schema in Postgres
SELECT * FROM table LIMIT 1;  # Check data

# API debugging
curl -v https://api.local/endpoint  # Verbose request/response
curl -H "Authorization: Bearer TOKEN" ...  # With auth

# Browser debugging
DevTools → Network tab      # See API calls
DevTools → Console          # Logs
React DevTools             # Component state/props
```

## Summary

**Root cause tracing is detective work:**

1. Find where data breaks
2. Trace backward to the source
3. Form hypothesis based on evidence
4. Test hypothesis
5. Confirm root cause
6. Fix at the source, not the symptom

Never fix without finding root cause. Otherwise, you'll fix the symptom and the bug will come back.
