# Skill: shape

## Purpose
Turn a rough idea into a complete PRD by walking the full decision tree yourself, without interactive grilling.

## Source behavior to preserve
- Self-walk the full decision tree
- Self-answer every branch using boring, testable, codebase-aligned defaults
- Stream the Q&A live so the user can override bad assumptions
- Keep the output in the same PRD format as write-a-prd
- Continue through the tree autonomously until a real decision, blocker, or ambiguity needs the user

## Decision tree
For each branch, generate the questions a thorough engineer would ask, then answer each one yourself.
Do not skip branches.

### Required branches
- Actors and user stories
- Happy path flow
- Edge cases
- Data model and schema
- Module boundaries
- API contracts
- Testing strategy
- Security
- Observability
- Out of scope
- Dependencies and blockers

## Output contract
- Problem statement
- Solution
- Long numbered list of user stories
- Implementation decisions
- Testing decisions
- Out of scope
- Further notes
- Decisions log

## Rules
- Ask once for the rough idea if not already supplied
- Then proceed without further interaction until the PRD is written or a real decision boundary appears
- Use codebase facts over generic best practices
- Prefer deep, stable modules and public interfaces
- Keep behavior aligned with the target repo and workspace
- Do not stop at each milestone if the next step is already clear

## Loading rule
Load only for the discovery step that needs fast but complete PRD formation.
