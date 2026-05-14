# Reminders Migration: CalDAV → MS Graph Tasks

## What Was Done

### 1. Created New MS Graph Tasks Script
**File:** `/Users/sc/workspace/operations/engine-room/skills/msgraph/tasks_ops.py`

Drop-in replacement for the old CalDAV-based `reminders.py`. Uses Microsoft To-Do via MS Graph Tasks API.

**Commands:**
```bash
# List all tasks
python3 ~/workspace/operations/engine-room/skills/msgraph/tasks_ops.py list --all

# List overdue tasks
python3 ~/workspace/operations/engine-room/skills/msgraph/tasks_ops.py list --overdue

# List tasks due today
python3 ~/workspace/operations/engine-room/skills/msgraph/tasks_ops.py list --due-today

# Add a task
python3 ~/workspace/operations/engine-room/skills/msgraph/tasks_ops.py add "Task title" --due 2026-05-10T17:00

# Complete a task
python3 ~/workspace/operations/engine-room/skills/msgraph/tasks_ops.py complete <task_id_or_substring>

# Delete a task
python3 ~/workspace/operations/engine-room/skills/msgraph/tasks_ops.py delete <task_id_or_substring>

# Find a task
python3 ~/workspace/operations/engine-room/skills/msgraph/tasks_ops.py find "substring"
```

### 2. Updated MS Graph Client
**File:** `/Users/sc/workspace/operations/engine-room/skills/msgraph/graph_client.py`

Added `Tasks.ReadWrite` scope to the SCOPES list.

### 3. Updated Scheduled Tasks
Migrated 3 scheduled tasks from CalDAV reminders to MS Graph tasks:

- **Morning brief** (`885bf4a5`): Section (3) now uses `tasks_ops.py`
- **Mid-day pulse** (`e37c97f7`): Section (3) now uses `tasks_ops.py`
- **Evening wrap** (`2c9e2829`): Section (3) now uses `tasks_ops.py`

All references to `~/workspace/operations/engine-room/skills/reminders/reminders.py` have been replaced.

## BLOCKER: Azure AD Consent Required

The new `Tasks.ReadWrite` scope requires re-authorization. Current error:

```
AADSTS65001: The user or administrator has not consented to use the application 
with ID '4938226d-531c-4334-b3a0-7b40058fc34e' named 'Sage-Cos'. 
Send an interactive authorization request for this user and resource.
```

### To Fix:

You need to grant the new `Tasks.ReadWrite` permission in Azure AD. Two options:

#### Option 1: Admin Consent URL (Fastest)
Open this URL in your browser (replace `TENANT_ID` and `CLIENT_ID` if different):

```
https://login.microsoftonline.com/4e4a54d8-0cc6-473f-baee-a99418c99ce6/v2.0/adminconsent
?client_id=4938226d-531c-4334-b3a0-7b40058fc34e
&scope=https://graph.microsoft.com/Tasks.ReadWrite
&redirect_uri=http://localhost
```

#### Option 2: Azure Portal
1. Go to https://portal.azure.com
2. Navigate to: Azure Active Directory → App registrations → Sage-Cos
3. Go to: API permissions
4. Click: Add a permission → Microsoft Graph → Delegated permissions
5. Find and check: `Tasks.ReadWrite`
6. Click: Grant admin consent for Sonke

After consent is granted, the scripts will work immediately (no restart needed).

## Testing After Consent

Run this to verify the integration works:

```bash
cd /Users/sc/workspace/operations/engine-room/skills/msgraph
python3 tasks_ops.py list --all
```

Expected: List of tasks from your Microsoft To-Do "Tasks" list (or empty if no tasks exist).

## Migration Notes

- The old CalDAV reminders.py script still exists at `/Users/sc/workspace/operations/engine-room/skills/reminders/reminders.py` but is no longer called by any scheduled tasks.
- Microsoft To-Do tasks are stored in the cloud (synced across devices), unlike Apple Reminders which were local via CalDAV.
- Task list name defaults to "Tasks". You can specify a different list with `--list-name "My List"`.
- Timezone handling: All due dates are converted to/from Brisbane time automatically.

## Files Changed

1. `/Users/sc/workspace/operations/engine-room/skills/msgraph/tasks_ops.py` (new)
2. `/Users/sc/workspace/operations/engine-room/skills/msgraph/graph_client.py` (scope added)
3. Scheduled tasks in `myos.db`:
   - `885bf4a5` (morning brief)
   - `e37c97f7` (mid-day pulse)
   - `2c9e2829` (evening wrap)
