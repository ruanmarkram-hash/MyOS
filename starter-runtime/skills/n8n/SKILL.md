# n8n Workflow Invoker Skill

Provides CLI access to n8n workflows running on localhost:5678.

## Scope

n8n is scoped to Sage OS infrastructure only (LOCKED decision 2026-04-04).
All app-layer automation goes to Supabase, not n8n.

## Active Workflows (7 OS-layer)

1. Sentry Error Log Watcher
2. Memory Consolidation
3. Heartbeat Pre-computation
4. Boot Check
5. Sprint Queue Manager
6. Sprint Completion Notifier
7. Failed Cron Recovery

## Usage

### List workflows
```bash
bash ~/HQ/skills/n8n/list.sh
```

### Run a workflow
```bash
bash ~/HQ/skills/n8n/run.sh <workflow-id>
```

### View execution history
```bash
bash ~/HQ/skills/n8n/history.sh [limit]
```

## Environment Variables

| Var | Required | Notes |
|-----|----------|-------|
| `N8N_API_KEY` | Yes | JWT token for n8n API |
| `N8N_LOGIN` | Info | Login username (sonke2026) |

## Approval Gate (non-negotiable)

Every NEW workflow must be drafted first, reviewed by Sage, then activated.
Never auto-deploy workflows.

## Owner

Mason (inherited from Forge, 2026-04-15 roster consolidation)
