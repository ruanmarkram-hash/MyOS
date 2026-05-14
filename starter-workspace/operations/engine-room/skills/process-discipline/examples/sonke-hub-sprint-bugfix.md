# Example: Debug and Fix Supabase Query Bug

A complete walk-through of systematic-debugging applied to a real custom workflow problem: a Supabase query returning stale data.

This example demonstrates:
- **systematic-debugging** → Find root cause
- **test-driven-development** → Write test to prevent regression
- **code-review** → Review the fix
- **verification-and-closure** → Confirm it's fixed

## The Problem

Users report: "When we update a client's status, it shows the old status until we refresh the page."

## Phase 1: Systematic Debugging

### 1.1 Read Error Messages

No error in console. Data just appears stale. Need to gather evidence.

### 1.2 Reproduce Consistently

Steps to reproduce:
1. Open client detail page for "Alice Smith"
2. Click Edit Status
3. Change status from "Active" to "Inactive"
4. Click Save
5. Status shows "Inactive" ✓
6. Refresh page
7. Status shows "Inactive" ✓ (persisted)

But after step 5, before refresh:
- Database shows "Inactive" ✓
- Page shows "Active" ✗ (stale)
- After page refresh, shows "Inactive" ✓

**So the bug is:** Updated data doesn't reflect on UI until refresh.

### 1.3 Check Recent Changes

```bash
git log --oneline -20 src/

# Recent changes to components and data layer
commit 3a2f1cc - feat: add client status badge
commit 2b5e4aa - refactor: extract client status queries
```

What changed in 3a2f1cc:

```bash
git show 3a2f1cc
```

Shows: New `ClientStatusBadge` component added.

### 1.4 Gather Evidence

Add logging to understand data flow:

**In React component:**
```typescript
// src/components/ClientStatusForm.tsx
const handleStatusUpdate = async (newStatus) => {
  console.log('1. Before update, current status:', currentStatus);
  
  const result = await updateClientStatus(clientId, newStatus);
  console.log('2. After API returns, result:', result);
  
  // Is the result different from what should be?
  console.log('3. Result status:', result.status, 'Expected:', newStatus);
  
  setStatus(result.status);
  console.log('4. State updated to:', result.status);
};
```

**In data layer:**
```typescript
// src/lib/supabase/client.ts
export async function updateClientStatus(id, newStatus) {
  console.log('API: Updating client', id, 'to', newStatus);
  
  const result = await supabase
    .from('clients')
    .update({ status: newStatus })
    .eq('id', id)
    .select()
    .single();
  
  console.log('API: Supabase returned:', result.data);
  return result.data;
}
```

Run the update flow. Check browser console logs.

**Logs show:**
```
1. Before update, current status: Active
2. API: Updating client abc123 to Inactive
API: Supabase returned: { id: 'abc123', name: 'Alice', status: 'Active' }  ← STALE!
3. Result status: Active, Expected: Inactive
4. State updated to: Active
```

**Root cause found:** Supabase query returns old data.

### 1.5 Trace Data Flow Backward

Database is updated (verified in SQL):
```sql
SELECT status FROM clients WHERE id = 'abc123';
-- Returns: Inactive ✓
```

But Supabase query returns `Active`.

**Hypothesis:** Supabase client cache not being invalidated.

**Check Supabase subscriptions:**

```typescript
// src/hooks/useClient.ts
useEffect(() => {
  const subscription = supabase
    .from('clients')
    .on('*', payload => {
      console.log('Real-time update:', payload);
      setClient(payload.new);
    })
    .subscribe();
  
  return () => subscription.unsubscribe();
}, [clientId]);
```

**Check if subscription fires:**

Add logging:
```typescript
.on('*', payload => {
  console.log('Realtime subscription fired:', payload);  ← Add this
  setClient(payload.new);
})
```

Run update. Check if console shows "Realtime subscription fired".

**Result:** NO LOGS. Subscription didn't fire.

**So the real bug:** Supabase real-time subscription not configured, OR not triggering on update.

### Pattern Analysis

Compare to similar code that works:

```typescript
// This works (notes update immediately):
const [notes, setNotes] = useState([]);

useEffect(() => {
  const sub = supabase
    .from('client_notes')
    .on('INSERT', payload => {
      setNotes(prev => [...prev, payload.new]);
    })
    .subscribe();
}, []);

// This doesn't work (status doesn't update):
const [status, setStatus] = useState(null);

useEffect(() => {
  const sub = supabase
    .from('clients')
    .on('*', payload => {  ← Listening to all events
      setStatus(payload.new);
    })
    .subscribe();
}, []);
```

**Difference:** Notes subscription listens to INSERT only. Status listens to all (*).

Check Supabase RLS policies:

```sql
SELECT * FROM pg_policies 
WHERE tablename = 'clients' 
AND policyname LIKE '%realtime%';
```

**Found:** RLS policies don't have `USING` clause for real-time events. Supabase real-time requires specific policy.

**Root cause:** RLS policy missing for UPDATE events on clients table. Supabase can't broadcast update event because RLS denies real-time permission.

### 1.6 Verify Hypothesis

Test: Add RLS policy for real-time UPDATE:

```sql
CREATE POLICY "Enable real-time updates for clients" 
ON clients 
FOR UPDATE 
USING (TRUE)  -- or more specific: auth.uid() = created_by
WITH CHECK (TRUE);
```

Run update again. Check if real-time subscription fires now.

**Result:** Subscription now fires! ✓

**Root Cause Confirmed:** Missing RLS policy for real-time UPDATE events.

---

## Phase 2: Test-Driven Development

### Write Test (RED)

Create test to prevent regression:

```typescript
// tests/integration/client-update-realtime.test.ts
test('should receive real-time update when client status changes', async () => {
  // Arrange
  const clientId = 'test-client-123';
  let receivedUpdate = false;
  let updatedStatus = null;
  
  // Subscribe to real-time updates
  const subscription = supabase
    .from('clients')
    .on('UPDATE', payload => {
      receivedUpdate = true;
      updatedStatus = payload.new.status;
    })
    .subscribe();
  
  // Give subscription time to connect
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Act
  await updateClientStatus(clientId, 'Inactive');
  
  // Give real-time event time to fire
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Assert
  expect(receivedUpdate).toBe(true);
  expect(updatedStatus).toBe('Inactive');
  
  // Cleanup
  subscription.unsubscribe();
});
```

Run test: `npm test -- client-update-realtime.test.ts`

**Result:** FAIL
```
Expected: true
Received: false
(subscription didn't fire)
```

### Write Code (GREEN)

Add RLS policy:

```typescript
// database/migrations/20240315-add-clients-realtime-policy.sql
CREATE POLICY "Enable real-time updates for clients"
ON clients
FOR UPDATE
USING (auth.uid() = created_by OR auth.jwt()->>'role' = 'admin')
WITH CHECK (auth.uid() = created_by OR auth.jwt()->>'role' = 'admin');
```

Run migration: `npm run db:migrate`

Run test: `npm test -- client-update-realtime.test.ts`

**Result:** PASS ✓

### Refactor (Check for Better Solutions)

The fix works, but can we improve it?

**Current:** Subscribe to all UPDATE events, then set state.

**Better:** Use Supabase's built-in `realtime` hook if available, or extract subscription logic.

Refactored version:

```typescript
// src/hooks/useClientRealtime.ts
export function useClientRealtime(clientId) {
  const [client, setClient] = useState(null);
  
  useEffect(() => {
    const channel = supabase
      .channel(`clients:${clientId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'clients', filter: `id=eq.${clientId}` },
        (payload) => {
          setClient(payload.new);
        }
      )
      .subscribe();
    
    return () => {
      channel.unsubscribe();
    };
  }, [clientId]);
  
  return client;
}
```

This is more precise (only listens to changes for specific client) and follows current Supabase patterns better.

Commit:

```bash
git add database/migrations/20240315-add-clients-realtime-policy.sql
git add src/hooks/useClientRealtime.ts
git add tests/integration/client-update-realtime.test.ts
git commit -m "fix: enable real-time updates for client status

- Add RLS policy for UPDATE events on clients table
- Extract real-time subscription logic to useClientRealtime hook
- Add integration test to prevent regression

Fixes: Stale data displayed after client status update until page refresh."
```

---

## Phase 3: Code Review

### Spec Compliance

**Reviewer checks:**
- Does this fix the reported bug? ✓
- Does client status update immediately after change? ✓
- Does real-time subscription work for all client updates? ✓
- Test confirms real-time fires? ✓
- RLS policy secure (limits who can see updates)? ✓

Result: ✓ APPROVED

### Quality Review

**Reviewer checks:**
- RLS policy naming clear? ✓
- Hook properly manages subscription lifecycle (cleanup)? ✓
- Test well-written (Arrange-Act-Assert)? ✓
- More specific filter than old code? ✓ (only listens to specific client)
- Performance: No memory leaks? ✓ (unsubscribe in cleanup)
- Comments explain why? ✓ (policy required for real-time)

Suggestion: Add comment to hook explaining the filter:

```typescript
// Only listen to updates for this specific client.
// Supabase real-time requires RLS policy and specific event filter.
filter: `id=eq.${clientId}`
```

Result: ✓ APPROVED (minor comment added)

---

## Phase 4: Verification and Closure

### Test the Fix

**Happy path:**
1. Open client detail page
2. Click Edit Status
3. Change to Inactive
4. Status updates immediately ✓ (no refresh needed)
5. Refresh page
6. Status still shows Inactive ✓

**Edge cases:**
- Rapid status changes: Updates follow in order ✓
- Multiple tabs: Update in one tab reflects in others ✓
- Disconnect/reconnect: Subscription re-establishes ✓
- Permission denied (non-manager): No update event received ✓

**Tests:**
```bash
npm test
# All tests passing: 45 passed
```

### Verification Checklist

```
Bug Fix: Stale client status after update

Issue: Client status didn't update until page refresh

Root Cause: Missing RLS policy for real-time UPDATE events
           Supabase couldn't broadcast updates without permission

Fix:
  - Added RLS policy for UPDATE events
  - Refactored real-time hook for clarity
  - Added regression test

Verification:
  [✓] Bug reproduces initially
  [✓] Fix resolves bug
  [✓] Real-time updates work
  [✓] Test confirms real-time subscription fires
  [✓] RLS policy secure
  [✓] All tests passing
  [✓] No performance impact
  [✓] Cleanup in useEffect prevents leaks

Result: ✓ APPROVED FOR MERGE

Reviewer: Sage
Date: 2024-03-15 16:30 UTC
Notes: Clean fix, well-tested, security-conscious RLS policy.
```

### Merge

```bash
git checkout main
git pull origin main
git merge bugfix/client-status-realtime
git push origin main
```

### Release Notes

```markdown
# Hotfix: Real-time Client Status Updates

## Issue
Client status didn't update on page until refresh. Now updates immediately.

## What Changed
- Added Supabase RLS policy enabling real-time UPDATE events
- Refactored real-time subscription to useClientRealtime hook
- Added integration test to prevent regression

## Technical Details
Supabase real-time requires RLS policy to broadcast changes. Without policy, 
broadcast fails silently. Added:

```sql
CREATE POLICY "Enable real-time updates for clients"
ON clients FOR UPDATE ...
```

## Testing
- Manual test: Status updates immediately ✓
- Integration test: Real-time subscription fires ✓
- All existing tests: Still passing ✓

## Deployment
No database migration needed (RLS policy only).
No downtime.
Effect: Immediate (users will see live updates next page load).
```

---

## What This Example Shows

✓ Systematic debugging approach (gathering evidence, not guessing)
✓ Root cause analysis (found RLS policy, not subscription code)
✓ TDD to prevent regression (test proves real-time works)
✓ Two-stage review (spec + quality)
✓ Verification before merge
✓ How to debug data layer issues (Supabase-specific)

Real debugging is methodical, not random guessing.
