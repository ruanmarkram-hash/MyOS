# HQ remote topology: private origin, public upstream with disabled push

**Date**: 2026-05-02
**Scope**: engine-room
**Status**: active
**Session**: `~/workspace/operations/engine-room/sessions/2026-05-02-codex-phase2-paperwork-mcp-allowlist-sigterm-drain.md`

## Decision

The `~/HQ` repo's remotes are configured so that:

- `origin` → `git@github.com:your-user/your-private-os.git` ([YOUR NAME]'s private fork; this is the push target)
- `upstream` → `https://github.com/earlyaidopters/myos-os.git` (public fork; fetch only)
- `upstream` push URL is set to `DISABLED-public-fork-do-not-push` so any accidental `git push upstream` fails immediately with "not a git repository"
- Branch `main` tracks `origin/main`, so plain `git push` goes to the private fork by default

MyOS HQ contains operational state — bot tokens, agent configs, OAuth tokens, conversation logs, and integration credentials — that must never be published. The `earlyaidopters/myos-os` repo is the public-safe fork; HQ is its private downstream and stays that way.

## Reasoning

Earlier in the day, `git push origin main` failed because the SSH key on this machine authenticates as `your-github-user`, which doesn't have write to the `earlyaidopters` org. That was actually the correct behaviour — [YOUR NAME]'s account SHOULD NOT be able to push to the public fork from this machine. The fix wasn't to grant access; it was to remove `earlyaidopters` from the push path entirely.

Alternatives considered:
- **`git remote remove upstream`**: tempting but loses the ability to fetch updates from the public fork if/when it diverges (e.g. someone else contributes upstream improvements that should be cherry-picked). Keeping fetch-only preserves that path.
- **Add `your-github-user` as a collaborator on `earlyaidopters/myos-os`**: explicitly rejected. The private fork has data the public one must never see.
- **Rely on a pre-push hook**: too easy to bypass with `--no-verify`. Hard remote URL replacement is the only mechanism that can't be bypassed without conscious effort.

Setting the push URL to a non-URL string causes git to fail-closed: any push attempt errors immediately with a clear message. This is the same pattern as `git remote set-url --push <name> no_push` (a documented git idiom).

## What this locks in

- No automated process or future Sage session can push HQ to the public fork without explicitly resetting the upstream push URL.
- The default `git push` (no remote argument) goes to private origin. Mistakes here require active effort, not passive forgetfulness.
- A high-salience lesson (importance 1.0, salience 5.0) is in the memory DB tagged `[lesson, git, remotes, privacy]` so any future session retrieves the rule when working on git operations.

## What this unlocks

- Operational tokens in `.env`, conversation logs in `store/myos.db`, and any other private state can stay tracked locally without paranoia about accidental publication.
- Future code sharing with the public fork goes through deliberate cherry-pick + sanitisation, not through git's default behaviour.

## Superseded by / supersedes

Standalone.
