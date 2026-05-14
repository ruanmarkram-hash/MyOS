# Test-Driven Development: RED-GREEN-REFACTOR

Activate this when: Writing any new code or fixing bugs.

**CRITICAL FOR SONKE HUB:** custom workflow currently has 0 tests. Adopting TDD is the highest-priority quality improvement.

## Why This Matters

Testing after coding is catching problems. Testing before coding is *designing* with evidence.

TDD flips this: write the test first, watch it fail, write minimal code to pass, refactor. This catches bugs early, creates better designs, and gives you confidence that code actually works.

**The single rule:** If you didn't watch the test fail, you don't know if you're testing the right thing.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

No exceptions:
- Don't write code first and test it later
- Don't skip the "watch it fail" step
- Don't "adapt" code while writing tests
- If you wrote production code before the test, DELETE IT and start over

This isn't ideology. It's evidence-based practice. Tests written after code often test existing behavior, not desired behavior.

## RED-GREEN-REFACTOR Cycle

```
RED (write test, watch fail) 
  ↓
GREEN (write minimal code to pass) 
  ↓
REFACTOR (clean up, improve, extract) 
  ↓
RED (next test)
```

Repeat for every feature.

### Phase 1: RED — Write Failing Test

Write one small test showing what should happen:

```typescript
test('should format client date as YYYY-MM-DD', () => {
  const result = formatClientDate(new Date('2024-03-15'));
  expect(result).toBe('2024-03-15');
});
```

**Rules for good test:**
- One behavior per test ("should format date", not "should format date and validate input")
- Real code, not mocks (unless unavoidable)
- Clear name describing what it tests
- Obvious assertion (easy to read what should happen)

**What not to do:**
```typescript
// Bad: vague name, unclear what it tests
test('dates work', () => {
  expect(formatClientDate(new Date())).toBeTruthy();
});

// Bad: tests mock, not code
test('format called', () => {
  const mock = jest.fn();
  formatClientDate(new Date());
  expect(mock).toHaveBeenCalled();
});

// Bad: multiple behaviors
test('dates format and validate', () => {
  expect(formatClientDate(new Date())).toBe('2024-03-15');
  expect(formatClientDate(null)).toThrow();
});
```

Keep tests small. One behavior. Clear assertion.

### Phase 2: Verify RED — Watch It Fail

**MANDATORY. Never skip. Never assume.**

Run the test:
```bash
npm test tests/unit/date-format.test.ts
```

Confirm:
- Test **fails** (not errors)
- Failure message says what's expected ("formatClientDate is not defined")
- Fails for the right reason (missing function, not typo)

**If test passes:** You're testing existing code. Delete the test, fix it, or delete the code and start over.

**If test errors:** You have a syntax error or something broken. Fix the test setup, not the production code.

### Phase 3: GREEN — Write Minimal Code

Write the simplest code that makes the test pass. No more.

```typescript
export function formatClientDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
```

**What this is NOT:**
- Configuration options (YAGNI)
- Error handling for edge cases (not tested yet)
- Internationalization (not tested yet)
- Performance optimization (not tested yet)

Just enough to pass the test. That's it.

### Phase 4: Verify GREEN — Watch It Pass

**MANDATORY.**

Run the test:
```bash
npm test tests/unit/date-format.test.ts
```

Confirm:
- Test passes
- All other tests still pass (didn't break anything)
- Build succeeds (no warnings, no errors)

**If test still fails:** Your code doesn't do what it should. Fix it.

**If other tests fail:** You broke something. Fix before moving on.

### Phase 5: REFACTOR — Clean Up

Now that test passes, improve the code:

```typescript
export function formatClientDate(date: Date): string {
  return date.toLocaleDateString('en-CA'); // Already YYYY-MM-DD in Canadian locale
}
```

Or extract a helper:
```typescript
const padZero = (n: number) => String(n).padStart(2, '0');

export function formatClientDate(date: Date): string {
  return [
    date.getFullYear(),
    padZero(date.getMonth() + 1),
    padZero(date.getDate()),
  ].join('-');
}
```

**Rules for refactoring:**
- Keep tests green (run after every change)
- Don't add behavior (no new features during refactor)
- Don't optimize prematurely (make it work first, make it fast later)
- Do improve names, extract helpers, remove duplication

### Phase 6: Repeat

Next test for next behavior.

```typescript
test('should handle invalid dates gracefully', () => {
  const result = formatClientDate(new Date('invalid'));
  expect(result).toBe('Invalid Date');
});
```

Back to RED. Write test, watch fail, write code, watch pass, refactor.

## Writing Good Tests

### Test Structure: Arrange-Act-Assert

```typescript
test('should increment client visit count', () => {
  // Arrange: set up test data
  const client = { id: 1, visit_count: 5 };
  
  // Act: do the thing
  const updated = incrementVisits(client);
  
  // Assert: verify result
  expect(updated.visit_count).toBe(6);
  expect(updated.id).toBe(1); // unchanged
});
```

Clear sections. Easy to read. Easy to debug.

### Testing Data Layer (Supabase)

For custom workflow, data layer tests are critical:

```typescript
test('should fetch client by ID', async () => {
  // Arrange
  const clientId = 'test-client-123';
  
  // Act
  const result = await getClient(clientId);
  
  // Assert
  expect(result).toBeDefined();
  expect(result.id).toBe(clientId);
  expect(result).toHaveProperty('name');
  expect(result).toHaveProperty('status');
});
```

Use real database for integration tests (not mocks). Mocks hide bugs.

### Testing React Components

For React, test behavior not implementation:

```typescript
test('should display client name', () => {
  const client = { id: 1, name: 'Alice Smith' };
  
  render(<ClientCard client={client} />);
  
  expect(screen.getByText('Alice Smith')).toBeInTheDocument();
});
```

**Not:**
```typescript
test('should create div with className', () => {
  // Tests implementation, not behavior
  expect(container.querySelector('div.client-name')).toBeDefined();
});
```

Test what users see and do, not how components are built.

### Testing Error Cases

Good tests cover happy path AND error cases:

```typescript
test('should return client on success', async () => {
  const result = await getClient(1);
  expect(result.name).toBe('Alice');
});

test('should throw NotFoundError when client missing', async () => {
  expect(() => getClient(-1)).toThrow(NotFoundError);
});

test('should throw on database connection error', async () => {
  mockDatabaseDown();
  expect(() => getClient(1)).toThrow(DatabaseError);
});
```

Happy path. Expected failures. Unexpected failures.

## For custom workflow Adoption

custom workflow has **0 tests**. TDD adoption is the top priority for code quality.

### Phase 1: Core Data Layer (High Priority)

Start with `src/lib/supabase/*.ts` functions. These are:
- High-risk (database is source of truth)
- Reusable (tested once, used everywhere)
- Relatively simple to test

```typescript
// tests/unit/supabase/client-queries.test.ts
test('should fetch clients for support worker', async () => {
  const workerId = 'worker-123';
  const result = await getClientsForWorker(workerId);
  expect(result.length).toBeGreaterThan(0);
  expect(result[0]).toHaveProperty('name');
});
```

### Phase 2: React Components (Medium Priority)

Add tests for components as you modify them:

```typescript
// tests/unit/components/ClientCard.test.tsx
test('should display client status badge', () => {
  const client = { status: 'active' };
  render(<ClientCard client={client} />);
  expect(screen.getByText('Active')).toBeInTheDocument();
});
```

### Phase 3: API Endpoints (High Priority)

If custom workflow has API routes, test them:

```typescript
// tests/integration/api/clients.test.ts
test('GET /api/clients/:id should return client', async () => {
  const res = await request(app).get('/api/clients/1');
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('name');
});
```

## Common Mistakes

### Skipping "Watch It Fail"

You write a test. It passes immediately. You think "great, done."

**No.** If the test passes without your code, it's testing something that already exists.

Always:
1. Write test
2. Run test (should fail)
3. Write code
4. Run test (should pass)

Skip step 2 and you're not practicing TDD.

### Testing Implementation, Not Behavior

```typescript
// Bad: tests implementation
test('should call setClientName', () => {
  const mock = jest.fn();
  Component({ setClientName: mock });
  userEvent.click(screen.getByRole('button'));
  expect(mock).toHaveBeenCalled();
});

// Good: tests behavior
test('should update displayed name when input changes', () => {
  render(<ClientNameForm client={client} />);
  const input = screen.getByRole('textbox');
  userEvent.type(input, 'Alice');
  userEvent.click(screen.getByRole('button', { name: /save/i }));
  expect(screen.getByText('Alice')).toBeInTheDocument();
});
```

Test what users see. Implementation details can change; behavior shouldn't.

### Writing "God Tests"

```typescript
// Bad: tests too much
test('full user flow works', () => {
  // 50 lines of test setup
  // Creates user, logs in, creates client, exports report, ...
  // If anything breaks, which part?
});

// Good: focused test
test('should export client list as CSV', () => {
  const clients = [{ name: 'Alice' }, { name: 'Bob' }];
  const csv = exportClients(clients);
  expect(csv).toContain('name');
  expect(csv).toContain('Alice');
  expect(csv).toContain('Bob');
});
```

One behavior per test. Easy to debug.

### Writing Tests That Are Hard to Maintain

```typescript
// Bad: fragile, testing implementation
test('creates div with exact HTML', () => {
  expect(element.innerHTML).toBe(
    '<div class="client"><span>Alice</span></div>'
  );
});

// Good: tests behavior, flexible to implementation
test('displays client name', () => {
  expect(screen.getByText('Alice')).toBeInTheDocument();
});
```

Tests should survive refactoring. If you change the HTML structure, tests should still pass.

## Test Organization

For custom workflow:

```
src/
  components/
    ClientCard.tsx
  lib/
    supabase/
      client-queries.ts

tests/
  unit/
    components/
      ClientCard.test.tsx
    lib/
      supabase/
        client-queries.test.ts
  integration/
    api/
      clients.test.ts
```

Mirror src structure in tests. Tests live alongside code they test.

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test tests/unit/components/ClientCard.test.tsx

# Run tests matching pattern
npm test --testNamePattern="client"

# Run with coverage
npm test --coverage
```

Coverage is nice. Code coverage > 80% is good. Code coverage > 90% is excellent. 100% coverage is a red flag (means you're testing trivial code).

## Done When

- [ ] Test written (RED phase)
- [ ] Test fails correctly (verified)
- [ ] Code written, test passes (GREEN phase)
- [ ] All tests still pass (verified)
- [ ] Code refactored if needed (REFACTOR phase)
- [ ] No mocks of production code (only external services)
- [ ] Tests are focused (one behavior each)
- [ ] Next feature gets tested

## Related Skills

- **sprint-execution** — Tests run during each task
- **code-review** — Reviewer checks for test coverage and quality
- **systematic-debugging** — When tests fail, debug systematically

## Examples

- `examples/sonke-hub-sprint-testing.md` — Full example adding tests to custom workflow
- References in each project's test directory

## Resources

- Test naming convention: `test('<what it does>', () => { ... })`
- Jest docs: https://jestjs.io/
- React Testing Library: https://testing-library.com/react
- Supabase testing: Use real test database, not mocks
