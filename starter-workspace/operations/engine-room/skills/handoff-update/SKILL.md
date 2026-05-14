---
name: handoff-update
description: |
  Update ~/workspace/memory/HANDOFF.md and file a session log + any locked
  decisions. Use when the user says "update handoff", "/handoff", "close
  session", "wrap up", or before they /newchat / go to bed. This skill writes
  a dense per-session record to the right folder (projects/ or operations/),
  updates HANDOFF.md's current-state sections, auto-archives stale entries,
  and files any locked decisions as separate MD files.
author: your name
version: 1.0.0
---

# Handoff update

Keep `~/workspace/memory/HANDOFF.md` current, file per-session writeups in the
right place, and pull out locked decisions into their own files. Triggered by
the user, runs once per invocation.

## Core rule

When triggered, perform ALL of the following in order. Do not skip steps. If
the user cancels mid-flow, leave the proposed diff in
`~/workspace/scratchpad/handoff-proposed-<timestamp>.md` for next time.

## Step 1. Read the current state

1. Read `~/workspace/memory/HANDOFF.md` in full (it's under 600 lines).
2. Find the `Updated:` timestamp at the top. Anything newer than that is new
   activity since last handoff.
3. If no timestamp is parseable, default to "last 24 hours".

## Step 2. Gather activity since last update

1. Query OB1 for high-importance thoughts since the last update timestamp,
   grouped by project entity:

   ```sql
   SELECT
     coalesce(e.canonical_name, '(no-project)') AS project,
     t.id,
     (t.metadata->>'importance')::numeric AS importance,
     left(t.content, 300) AS content,
     t.created_at
   FROM thoughts t
   LEFT JOIN thought_entities te ON te.thought_id = t.id
   LEFT JOIN entities e ON e.id = te.entity_id AND e.entity_type = 'project'
   WHERE t.created_at > <last_update>
     AND (t.metadata->>'importance')::numeric >= 0.6
   ORDER BY (t.metadata->>'importance')::numeric DESC, t.created_at DESC
   LIMIT 100;
   ```

   Connect via `psql "$OB1_SUPABASE_DB_URL"` (sourcing `~/HQ/.env` first).

2. List any new per-sprint session docs in:
   - `~/workspace/projects/*/sessions/` modified since last update
   - `~/workspace/operations/*/sessions/` modified since last update

3. Check git activity in active worktrees under `~/workspace/sonke-hub*`,
   `~/workspace/pilot-tool*` etc. for branch names and latest commits.

4. Note any unresolved "blocked on X" or "waiting for Y" language from the
   captured thoughts.

## Step 3. Infer primary domain for this session

Decide whether the session being handed off is primarily:
- `projects/<project-name>/` — code/product work on a named project
- `operations/engine-room/` — ClaudeClaw / brain / agents / launchd work
- `operations/<other-domain>/` — marketing, recruitment, compliance, etc.

**Rules:**
1. If the work touched `sonke-hub-app`, `pilot-tool`, `sonke-website`, or any
   other known project repo — goes to `projects/<project>/`.
2. If the work touched `~/HQ/`, `src/`, `scripts/`, `launchd plists`, brain
   services, agents, or the OB1/Supabase stack — goes to
   `operations/engine-room/`.
3. If the work was marketing/recruitment/compliance/support-work — goes to
   `operations/<matching-domain>/`.
4. If the split is genuinely 50/50 and both sides have meaningful volume,
   default to the one with more thoughts captured; write a cross-ref stub in
   the secondary using the template at
   `~/workspace/operations/engine-room/templates/cross-ref-stub.md`.

When unsure, ASK the user: "I'm filing this under X; say 'swap to Y' if
wrong."

## Step 4. Write the session log

1. Copy `~/workspace/operations/engine-room/templates/sprint-handoff.md` into
   the target folder: `<domain-root>/sessions/<YYYY-MM-DD>-<slug>.md`.
2. Fill in the template from the gathered activity. The slug should be a
   short lowercase-kebab description (e.g. `2026-04-23-ob1-migration` or
   `2026-04-24-campaign-launch`).
3. If multiple sessions same day, add a disambiguation suffix:
   `2026-04-24-campaign-launch-afternoon.md`.
4. Keep it dense: branch name, commit SHA, file paths, specific decisions,
   explicit open threads. The template has the shape.

## Step 5. Detect and file locked decisions

1. Scan the captured thoughts for decision-language markers:
   - "locked", "decided", "won't revisit", "canonical", "chose X over Y",
     "non-negotiable", "final", "commit to"
   - Changes to defaults, policies, architecture, env config
2. For each candidate, show the user: "This looks like a locked decision.
   File it? (yes / skip / let me pick which)".
3. For each approved decision, copy
   `~/workspace/operations/engine-room/templates/decision.md` into
   `<domain>/decisions/<YYYY-MM-DD>-<slug>.md`. Fill from the thoughts.
4. Regenerate the relevant `decisions/INDEX.md` file:

   ```markdown
   # <Domain> decisions

   ## <YYYY-MM>
   - [YYYY-MM-DD] [Decision title](./YYYY-MM-DD-slug.md)
   - ...
   ```

## Step 6. Update HANDOFF.md

Rewrite the top sections in place (not the whole file). The structure:

```markdown
# HANDOFF
**Updated:** <current ISO timestamp + one-line session summary>
**Maintained by:** Sage / Claude Code (on-demand via /handoff)

## ⭐ Current state
<one paragraph: overall posture across projects/operations, what's live,
what's notable>

## 🟢 Active projects
### sonke-hub [ACTIVE] [owner: mason]
Status: <1-2 lines>
Current work: <in-progress branches with refs + tips>
Blocked on: <if anything, else drop this line>
Next up: <if anything, else drop this line>

### sonke-support [ACTIVE] [owner: sage]
...

### claudeclaw / engine-room [ACTIVE] [owner: sage]
...

## 🚧 Blocked / awaiting decision
<cross-project list of things waiting on [YOUR NAME] or external>

## 🔜 Next up (this week)
<planned but not started>

---

## 📦 Recent sessions (last 7 days)
### <YYYY-MM-DD <slot>> — <sprint name>
Branch `<branch>` on `<worktree>`, tip `<sha>`, <push status>. <one-line summary>.
- <3-5 key outcomes>
Full write-up: `<path>`.

### ...

## 📦 Archive
<everything older than 7 days, minimal summaries, full paths only>
```

1. Current state paragraph: write fresh each time.
2. Active projects register: update status per project from new info.
3. Blocked / Next up: carry over + add new; remove resolved.
4. Recent sessions: prepend the new session entry just filed. Keep 7 days.
5. Archive: move any existing Recent-sessions entries older than 7 days.

## Step 7. Write diff for approval

Before overwriting HANDOFF.md, write the proposed new content to
`~/workspace/scratchpad/handoff-proposed-<timestamp>.md` and show the user
a diff summary:

- "Session log created: `<path>`"
- "Decisions filed: N"
- "HANDOFF.md sections updated: <list>"
- "Entries auto-archived: N"

Ask "apply changes?" unless the user said "/handoff apply" explicitly
(in which case just apply).

## Step 8. Apply

On approval:
1. Overwrite `~/workspace/memory/HANDOFF.md`.
2. Confirm the writes with one-line summaries of each file touched.
3. Done.

## Failure handling

- If OB1 is unreachable: skip the thoughts query, tell user "OB1 down, can't
  see recent activity — update from session memory only?"
- If no meaningful activity found: say so, and offer a minimal
  "Updated: <timestamp>" bump to HANDOFF.md without rewriting sections.
- Never silently skip steps. Always tell the user what you did and didn't do.

## What this skill is NOT

- Not an auto-scheduled job. User triggers it.
- Not a drafting assistant. It writes authoritative updates, not suggestions
  the user has to rewrite.
- Not a replacement for session-end discipline. It captures what happened;
  the user still needs to tell it "we're done" so it runs.
