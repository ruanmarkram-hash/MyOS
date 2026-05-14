---
name: agent-browser
description: Interactive browser automation using the agent-browser CLI. Use when a task requires interacting with a web page (not just reading it): clicking buttons, filling forms, logging in, navigating SPAs, testing UI flows, taking screenshots, scraping pages that require JavaScript, or any task where web_fetch is insufficient because the page requires interaction or dynamic rendering. NOT for simple page reads — use web_fetch for those. Triggers on: "click", "fill in", "log in to", "test this page", "take a screenshot of", "automate", "navigate and", "interact with", "scrape this site", "open and click".
---

# Browser Automation with agent-browser

Binary: `agent-browser` (installed globally via npm, v0.22.1)
Chrome: `~/.agent-browser/browsers/chrome-146.0.7680.165`

## Decision: agent-browser vs web_fetch

- **web_fetch**: static pages, documentation, APIs that return HTML/JSON — fast, cheap, no overhead
- **agent-browser**: interactive tasks, JavaScript-rendered pages, forms, login flows, UI testing, anything that requires clicking or waiting for dynamic content

## Core Workflow

```bash
agent-browser open <url>
agent-browser snapshot        # get accessibility tree with @refs
agent-browser click @e2       # interact using refs
agent-browser fill @e3 "text"
agent-browser snapshot        # re-snapshot after DOM changes
agent-browser close
```

Chain commands with `&&` when you don't need intermediate output. Run separately when you need to parse refs first.

## Key Commands

```bash
agent-browser open <url>              # navigate
agent-browser snapshot                # accessibility tree (use -i for interactive elements only)
agent-browser click @ref              # click by ref
agent-browser fill @ref "text"        # clear + type
agent-browser type @ref "text"        # type without clearing
agent-browser select @ref "option"    # dropdown
agent-browser check @ref              # checkbox
agent-browser screenshot [path]       # screenshot (--full for full page)
agent-browser wait --load networkidle # wait for page to settle
agent-browser close                   # always close when done
```

CSS selectors also work: `agent-browser click "#submit"` — but prefer @refs from snapshot.

## Authentication

For sites requiring login, see [references/auth.md](references/auth.md) for session persistence, profile reuse, and auth vault patterns.

## Rules

- Always `agent-browser close` when done — the daemon persists between commands
- Re-snapshot after navigation or significant DOM changes
- Keep sessions short — don't leave the browser open between unrelated tasks
- Never store credentials in plaintext files; use `--session-name` for cookie persistence
