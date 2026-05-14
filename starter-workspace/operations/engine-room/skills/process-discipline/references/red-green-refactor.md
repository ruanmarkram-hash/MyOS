# RED-GREEN-REFACTOR Detailed Reference

Complete reference for the TDD cycle used in test-driven-development skill.

## The Cycle

```
RED (Test fails)
  ↓
GREEN (Test passes)
  ↓
REFACTOR (Improve code)
  ↓
Commit
  ↓
Repeat
```

## RED Phase (Write Failing Test)

### Goal

Create a test that proves the desired behavior doesn't exist yet.

### Rules

1. **Write one test** — One behavior per test
2. **Make it fail** — You must see the test fail
3. **Keep it simple** — Use real code, not mocks
4. **Make it clear** — Test name describes what it tests

### Structure

```typescript
test('should [expected behavior]', () => {
  // Arrange: Set up test data
  const input = ...;
  
  // Act: Do the thing
  const result = myFunction(input);
  
  // Assert: Verify result
  expect(result).toBe(...);
});
```

### Example

```typescript
test('should format date as YYYY-MM-DD', () => {
  const result = formatDate(new Date('2024-03-15'));
  expect(result).toBe('2024-03-15');
});
```

### Verification

Run the test. You must see:
```
FAIL formatDate
  ✕ should format date as YYYY-MM-DD
    ReferenceError: formatDate is not defined
```

If test passes immediately, you're testing existing code. Delete it, delete the code, start over.

## GREEN Phase (Write Minimal Code)

### Goal

Write the simplest code that makes the test pass.

### Rules

1. **Make test pass** — That's the only goal
2. **Keep it simple** — No extra features, no optimization
3. **No architecture** — Don't design yet, just code
4. **No edge cases yet** — Only handle what test requires

### Example

```typescript
function formatDate(date) {
  return date.toISOString().split('T')[0];
}
```

That's it. Simple. Passes the test.

### Anti-Patterns

```typescript
// DON'T: Over-engineer
function formatDate(date, options = {}) {
  const locale = options.locale || 'en-US';
  const timezone = options.timezone || 'UTC';
  // 20 lines of code for something simple
}

// DO: Keep it simple
function formatDate(date) {
  return date.toISOString().split('T')[0];
}
```

### Verification

Run the test:
```
PASS formatDate
  ✓ should format date as YYYY-MM-DD
```

If test still fails, fix the code, not the test.

## REFACTOR Phase (Improve Code)

### Goal

Improve code while keeping tests passing.

### Rules

1. **Keep tests passing** — Run after every change
2. **Don't add behavior** — No new features
3. **Improve readability** — Better names, structure
4. **Extract helpers** — Remove duplication
5. **No premature optimization** — Make it work first

### Example

**Original (works, but could be better):**
```typescript
function formatDate(date) {
  return date.toISOString().split('T')[0];
}
```

**Refactored (same behavior, clearer intent):**
```typescript
function formatDate(date) {
  const dateOnly = date.toISOString().split('T')[0];
  return dateOnly;
}

// Or even better, using built-in method:
function formatDate(date) {
  return date.toLocaleDateString('en-CA'); // en-CA uses YYYY-MM-DD
}
```

### When to Refactor

Refactor when you see:
- **Duplication** — Same logic appears twice
- **Poor names** — Variable or function name is unclear
- **Long functions** — Function does too many things
- **Nested complexity** — Too many levels of nesting
- **Magic numbers** — Unexplained constants

### When NOT to Refactor

Don't refactor when:
- **Tests aren't green** — Only refactor after test passes
- **You're adding features** — Refactoring + features = can't isolate bugs
- **You're optimizing prematurely** — Make it clear first
- **You don't understand the code** — Write test first, then refactor

## Commit After Each Cycle

```bash
# After RED + GREEN + REFACTOR:
git add tests/date-format.test.ts src/date-format.ts
git commit -m "feat: add date formatting function

- Write test for YYYY-MM-DD format
- Implement formatting using toLocaleDateString
- Handles timezone correctly (en-CA locale)"
```

One commit per complete cycle.

## Multiple Tests, One Cycle

For more complex features:

```
Test 1: Basic case
  RED → GREEN → REFACTOR

Test 2: Error case
  RED → GREEN → REFACTOR

Test 3: Edge case
  RED → GREEN → REFACTOR
```

Each test gets its own cycle.

### Example: Client Validation

**Test 1: Valid client**
```typescript
test('should create valid client', () => {
  const result = createClient({ name: 'Alice', email: 'alice@example.com' });
  expect(result.id).toBeDefined();
});
// RED → implement simple create → GREEN → no refactor needed
```

**Test 2: Missing name**
```typescript
test('should reject client without name', () => {
  expect(() => createClient({ email: 'alice@example.com' }))
    .toThrow('Name required');
});
// RED → add name validation → GREEN → refactor validation logic
```

**Test 3: Invalid email**
```typescript
test('should reject invalid email', () => {
  expect(() => createClient({ name: 'Alice', email: 'not-an-email' }))
    .toThrow('Invalid email');
});
// RED → add email validation → GREEN → extract validation
```

## Common Mistakes

### Skipping RED

```
Wrong:
  1. Write code
  2. Write test (test passes immediately)
  3. Done

Right:
  1. Write test (fails)
  2. Write code
  3. Test passes
  4. Refactor
  5. Done
```

Always verify test fails first.

### Writing Too Much in GREEN

```
Wrong (too much):
test('should validate client', () => {
  const result = createClient({
    name: 'Alice',
    email: 'alice@example.com',
    phone: '555-1234',
    address: '123 Main St',
    company: 'Acme',
    role: 'Manager',
  });
  expect(result).toBeDefined();
});
// Implementation has 50 lines of validation

Right (one thing):
test('should create client with name', () => {
  const result = createClient({ name: 'Alice' });
  expect(result.name).toBe('Alice');
});
// Implementation: { name }
```

Then add one test per field.

### Refactoring Too Much

```
Wrong:
GREEN (test passes)
  ↓
Refactor (now redesigning architecture)
  ↓
Tests start failing
  → What changed?

Right:
GREEN (test passes)
  ↓
Refactor (improve names, extract helpers)
  ↓
Run tests after every change
  ↓
Tests still pass ✓
```

Refactor incrementally, verify tests still pass.

### Testing Implementation, Not Behavior

```
Wrong:
test('should call database insert', () => {
  const mock = jest.fn();
  createClient({ name: 'Alice' }, mockDb);
  expect(mockDb.insert).toHaveBeenCalled();
});

Right:
test('should create client in database', () => {
  const result = createClient({ name: 'Alice' });
  // Verify it actually works
  expect(result.id).toBeDefined();
  expect(result.created_at).toBeDefined();
});
```

Test behavior. Don't mock your own code.

## Real Examples

### Example 1: Simple Function

```typescript
// RED
test('should convert fahrenheit to celsius', () => {
  expect(fahrenheitToCelsius(32)).toBe(0);
  expect(fahrenheitToCelsius(212)).toBe(100);
});

// GREEN
function fahrenheitToCelsius(f) {
  return (f - 32) * 5 / 9;
}

// REFACTOR
function fahrenheitToCelsius(fahrenheit) {
  return (fahrenheit - 32) * 5 / 9;
}
// No refactor needed, it's already clear

// Commit
// git commit -m "feat: add temperature conversion"
```

### Example 2: Data Layer Function

```typescript
// RED
test('should fetch client by ID', async () => {
  const created = await db.insert('clients', { name: 'Alice' });
  const result = await getClient(created.id);
  expect(result.name).toBe('Alice');
});

// GREEN
async function getClient(id) {
  return await db.query('SELECT * FROM clients WHERE id = ?', [id]);
}

// REFACTOR
async function getClient(id) {
  const result = await db.query('SELECT * FROM clients WHERE id = ?', [id]);
  if (!result) {
    throw new Error(`Client ${id} not found`);
  }
  return result;
}
// Better: Now handles error case

// Commit
// git commit -m "feat: add getClient function with error handling"
```

### Example 3: React Component

```typescript
// RED
test('should display client name', () => {
  const client = { id: 1, name: 'Alice' };
  render(<ClientCard client={client} />);
  expect(screen.getByText('Alice')).toBeInTheDocument();
});

// GREEN
function ClientCard({ client }) {
  return <div>{client.name}</div>;
}

// REFACTOR
function ClientCard({ client }) {
  return (
    <div className="client-card">
      <h2>{client.name}</h2>
    </div>
  );
}
// Better structure, clearer intent

// Commit
// git commit -m "feat: add ClientCard component"
```

## When to Break the Rules

You can skip RED-GREEN-REFACTOR when:

1. **Fixing a bug:** Write failing test first (RED), then fix (GREEN), then refactor
2. **Refactoring existing code:** Keep tests green first, then refactor
3. **Trivial change:** Adding a constant or renaming doesn't need TDD

But the default is **always RED-GREEN-REFACTOR**.

## Summary

```
RED:      Test fails (proves desired behavior doesn't exist)
GREEN:    Test passes (proves behavior now exists)
REFACTOR: Improve code (without breaking tests)
COMMIT:   Save work (one cycle = one commit)
REPEAT:   Next feature
```

That's TDD. Master it, and your code will be more reliable and easier to maintain.
