# Skill: git-guardrails-codex

## Purpose
Block dangerous git commands before Codex executes them.

## Source behavior to preserve
- Intercept git push variants
- Intercept git reset --hard
- Intercept git clean -f / -fd
- Intercept git branch -D
- Intercept git checkout . / git restore .
- Present a clear blocked message when unsafe commands are attempted

## Output contract
- Safe operation only
- Explicit blocked message for dangerous git actions

## Rules
- Maintain the hook-based safety model
- Keep the blocked list editable if needed
- Test the block path with a representative command
- Keep the safety behavior consistent with our workspace and shell conventions

## Loading rule
Load only where git operations are possible.
