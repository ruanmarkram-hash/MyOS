# Skill: prd-to-plan

## Purpose
Turn a locked PRD into a multi-phase implementation plan using tracer-bullet vertical slices.

## Source behavior to preserve
- Ensure the PRD is already present
- Explore the codebase if needed
- Identify durable decisions that are unlikely to change
- Break the PRD into thin vertical slices
- Keep each slice end-to-end and demoable
- Preserve dependencies and blocked-by relationships
- Iterate on phase granularity until the user approves

## Output contract
- Plan header with durable decisions
- Numbered phase list
- User stories covered for each phase
- Consistent vertical-slice criteria

## Rules
- Prefer many thin slices over thick ones
- Do not include unstable file-level implementation details
- Keep route, schema, model, and auth decisions explicit where relevant
- Keep planning autonomous until a real dependency, blocker, or decision boundary appears

## Loading rule
Load only when a phased plan is needed from a PRD.
