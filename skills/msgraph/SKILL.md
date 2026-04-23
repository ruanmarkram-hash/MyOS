# MS Graph Skill

Provides Microsoft Graph API access for token management and email operations.

## Capabilities

1. **Token refresh** (automated, every 45 min via scheduled task)
   - Silently refreshes access token using stored refresh token
   - Refresh token stored in `pass` (GPG-encrypted) at `sonke/ms-graph-refresh-token`
   - Fallback: reads `GRAPH_REFRESH_TOKEN` from `.env`
   - Alerts via Telegram if refresh fails

2. **Send email** via MS Graph
   - Plain text or HTML body
   - File attachments supported
   - Default from: `sage@sonke.com.au`

3. **Token health check**
   - Reports refresh token source (pass vs env vs none)
   - Reports access token validity and expiry

## Usage

### Token refresh (CLI)
```bash
python3 ~/HQ/skills/msgraph/refresh.sh
```

### Send email (CLI)
```bash
python3 ~/HQ/skills/msgraph/send_graph_email.py \
  --to "ruan@sonke.com.au" \
  --subject "Report" \
  --body "See attached" \
  --attach /tmp/report.pdf
```

### Health check
```bash
python3 ~/HQ/skills/msgraph/msgraph_auth.py --health
```

## Environment Variables

| Var | Required | Notes |
|-----|----------|-------|
| `GRAPH_CLIENT_ID` | Yes (has fallback) | Azure app client ID |
| `GRAPH_TENANT_ID` | Yes (has fallback) | Azure tenant ID |
| `GRAPH_CLIENT_SECRET` | Yes | Azure app secret |
| `GRAPH_REFRESH_TOKEN` | Fallback | Used if `pass` store is unavailable |

## Dependencies

- Python 3: `msal`, `requests` (install: `pip3 install msal requests`)
- `pass` CLI for GPG-encrypted token storage

## Owner

Mason (inherited from Forge, 2026-04-15 roster consolidation)
