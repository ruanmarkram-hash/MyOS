# Skill: grill-me

## Purpose
Interview the user relentlessly until the plan is fully understood, then write the PRD from that clarified state.

## Source behavior to preserve
- Ask questions one at a time
- Walk every branch of the design tree in dependency order
- Resolve each answer before moving on
- Provide a recommended answer to each question
- Explore the codebase when the answer can be verified there

## Required branches
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
- Interview notes
- Clarified problem statement
- Full PRD draft
- Modules and interfaces
- Testing decisions
- Out of scope
- Decisions log

## Rules
- Do not batch questions
- Do not skip branches, even if obvious
- Use codebase facts over assumptions
- Match the codebase and workspace conventions
- Continue autonomously between questions unless a real decision boundary needs the user

## Loading rule
Load only for the deeper planning step that needs hands-on control.
