# Authentication Patterns

## Session name (simplest — auto-saves cookies + localStorage)

```bash
agent-browser --session-name myapp open https://app.example.com/login
# ... complete login flow ...
agent-browser close  # state auto-saved

# Next time: state auto-restored
agent-browser --session-name myapp open https://app.example.com/dashboard
```

## Persistent profile (good for recurring tasks)

```bash
agent-browser --profile ~/.agent-browser/profiles/myapp open https://app.example.com/login
# ... login once ...
# All future runs: already authenticated
agent-browser --profile ~/.agent-browser/profiles/myapp open https://app.example.com/dashboard
```

## Connect to user's existing browser session

```bash
agent-browser --auto-connect state save ./auth.json
agent-browser --state ./auth.json open https://app.example.com/dashboard
```

State files contain session tokens in plaintext — delete when no longer needed.

## Auth vault (credentials stored encrypted)

```bash
echo "$PASSWORD" | agent-browser auth save myapp --url https://app.example.com/login --username user --password-stdin
agent-browser auth login myapp
```
