# Git Workflow: Branch and Commit Strategy

Activate this when: Starting a new sprint or feature branch.

Clear git workflow prevents merge conflicts and keeps history clean.

## Branch Strategy

### Feature Branches

```
Main branch: main
Feature branches: feature/<feature-name>
Bug branches: bugfix/<bug-name>
Release branches: release/<version>
```

Example:
```bash
# Start a feature
git checkout main
git pull origin main
git checkout -b feature/client-billing

# Work on the feature
git add .
git commit -m "feat: add billing rate field"
git commit -m "feat: display billing info in UI"

# Merge when done
git checkout main
git pull origin main
git merge feature/client-billing
git push origin main

# Clean up
git branch -d feature/client-billing
```

### Never Commit Directly to Main

Main should only receive commits from:
1. **Pull requests** (preferred, includes review)
2. **Hotfixes** (emergency only, includes review after merge)

Never `git push origin main` from local branch.

## Commit Message Format

```
<type>: <subject>

<body (optional)>
```

Types:
- `feat:` — New feature
- `fix:` — Bug fix
- `refactor:` — Code improvement, no behavior change
- `test:` — Add or update tests
- `docs:` — Documentation
- `chore:` — Build, dependencies, tooling
- `perf:` — Performance improvement

Examples:
```
feat: add client billing rate field
fix: correct date format in client notes
test: add tests for client billing queries
refactor: extract client query helper
perf: add index on client name for faster lookup
```

### Commit Scope and Atomicity

One logical change per commit. Not one file per commit, but one behavior.

```
Good: "feat: add billing rate field and display in UI" (two related things)
Good: "feat: add billing rate field" then "feat: display in UI" (separate concerns)

Bad: "feat: add billing, fix unrelated bug, clean up imports" (three things)
```

### Commit Frequency

Commit after each passing test:

```
git add tests/billing.test.ts
git commit -m "test: add billing rate calculation test"
[test fails]
git add src/billing.ts
git commit -m "feat: implement billing rate calculation"
[test passes]
```

Not one commit at end with all changes. Frequent small commits.

## Merge Strategy

### Before Merging

1. **Pull latest main**
   ```bash
   git checkout main
   git pull origin main
   git checkout feature/my-feature
   ```

2. **Rebase on main** (cleaner history)
   ```bash
   git rebase main
   ```
   Or **merge main** (if shared branch)
   ```bash
   git merge main
   ```

3. **Run all tests**
   ```bash
   npm test
   npm run build
   ```

4. **Push to feature branch**
   ```bash
   git push origin feature/my-feature -f  # -f because rebase
   ```

### Create Pull Request

Use GitHub/GitLab to create PR. Include:
- What the feature does
- Link to the plan document
- Any known issues or TODOs

### Code Review

Reviewer uses code-review skill. No merge until approved.

### Merge

Once approved:
```bash
# Option A: Squash merge (cleaner history, lose commit detail)
git checkout main
git pull origin main
git merge --squash feature/my-feature
git commit -m "feat: add client billing feature"

# Option B: Regular merge (keep commit history)
git checkout main
git pull origin main
git merge feature/my-feature
git commit (auto-message)

# Option C: Rebase + fast-forward (linear history)
git rebase main feature/my-feature
git checkout main
git merge --ff feature/my-feature
```

For custom workflow, use **Option B** (regular merge) to preserve commit history.

### Delete Branch

```bash
git branch -d feature/my-feature
git push origin --delete feature/my-feature
```

## Handling Merge Conflicts

If rebase/merge causes conflicts:

```bash
# Conflicts appear
git status  # Shows conflicted files

# Edit conflicted files, resolve conflicts
# VS Code will highlight them

git add resolved-file.ts
git rebase --continue  # or git merge --continue
```

Example conflict:
```typescript
<<<<<<< HEAD
export function getRate(client) {
  return client.billing_rate * 1.1;  // Our change
}
=======
export function getRate(client) {
  return client.billing_rate * 2;    // Their change
}
>>>>>>> feature/new-rates
```

Decide which version is correct, keep it:
```typescript
export function getRate(client) {
  return client.billing_rate * 1.1;  // Resolved
}
```

Add, continue rebase/merge.

## Reverting Commits

If a commit breaks things:

```bash
# Revert the commit (creates new commit that undoes it)
git revert <commit-sha>

# Or reset to before the commit (loses commit history)
git reset --hard <previous-commit-sha>
```

Use `revert` for shared branches. Use `reset` for local branches.

## Viewing History

```bash
# See recent commits
git log --oneline -10

# See what changed in a commit
git show <commit-sha>

# See what changed in a file
git log -p src/billing.ts

# See commits on feature branch not on main
git log main..feature/my-feature
```

## For custom workflow

### Schema Changes (Forge)

When Forge creates database schema:

```bash
# Create separate branch for schema
git checkout -b feature/schema-add-billing

# Migrate and commit schema
npm run db:migrate
git add database/migrations/*
git commit -m "feat: add client billing columns"

# Push for review
git push origin feature/schema-add-billing
```

Then Mason's branch depends on Forge's:
```bash
# Mason's branch based on Forge's
git checkout -b feature/client-billing-ui
git rebase feature/schema-add-billing  # Starts from Forge's schema

# Implement UI
# Commits have Forge's schema available
```

### Never Force Push to Main

```bash
# NEVER do this
git push origin main -f

# This loses history and breaks other people's branches
```

Only force push to feature branches.

## custom workflow Specific Patterns

### Multi-Agent Handoff

When Forge and Mason work on same feature:

```
1. Forge branch: feature/schema-billing
   - Creates migration
   - Commits and pushes
   
2. Mason creates branch: feature/billing-ui
   - Branches from feature/schema-billing
   - Implements UI on top of Forge's schema
   
3. Both merge to main
   - Forge's PR first (schema)
   - Mason's PR second (UI)
```

### Checking Out Forge's Branch

```bash
# Mason can use Forge's branch directly
git fetch origin feature/schema-billing
git checkout feature/schema-billing
git checkout -b feature/billing-ui  # Branches from Forge's branch
```

## Done When

- [ ] Feature branch created from main
- [ ] Commits are atomic and well-messaged
- [ ] Branch is up-to-date with main
- [ ] All tests pass
- [ ] PR created and reviewed
- [ ] Code approved
- [ ] Merged to main
- [ ] Branch deleted

## Related Skills

- **sprint-execution** — Manages feature branch lifecycle
- **code-review** — Reviews before merge
- **feature-completion** — Decides merge vs discard

## Common Mistakes

### Committing to Main Directly

Never push directly to main. Always create a feature branch, PR, review, merge.

### Unclear Commit Messages

```
Bad: "update stuff" "fix things" "working now"
Good: "feat: add billing calculation" "fix: handle negative rates"
```

### Giant Monolithic Commits

```
Bad: 50 changed files, 1000 lines in one commit
Good: 5 focused commits, each with one logical change
```

### Forgetting to Pull Before Pushing

```bash
# WRONG
git commit -m "feat: ..."
git push  # Fails because remote is ahead

# RIGHT
git pull
# Resolve conflicts if any
git push
```

### Force Pushing to Shared Branches

```bash
# NEVER
git push origin main -f

# If you need to undo, use revert
git revert <bad-commit>
```

## Tools

```bash
# See branch status
git branch -v

# See unpushed commits
git log origin/main..HEAD

# See what would merge
git diff --stat main..HEAD
```
