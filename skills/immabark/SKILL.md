---
name: immabark
description: Send deduplicated, threshold-gated alerts to Slack with the immabark CLI. Use when asked to notify a Slack channel about events, errors, cron or job results, or recurring conditions without spamming the channel.
---

# Sending Slack alerts with immabark

immabark deduplicates Slack alerts: posting the same alert again edits the
original message ("First seen / Last seen / Count") instead of adding a new
one, and thresholds hold an alert back until it fires N times in a window.
It's a local CLI — no server or webhook involved.

## Prerequisites

- `SLACK_BOT_TOKEN` must be set in the environment (an `xoxb-...` bot token).
  Treat it as a secret: never print it or send it anywhere but Slack. If it's
  missing, ask the user; first-time setup is a one-pager — creating a Slack
  app from the repo's `slack-app-manifest.yaml` (see the README).
- Node ≥ 20. Run the CLI as `npx -y immabark` (shown as `immabark` below);
  nothing needs installing.
- The bot must be in the target channel: `/invite @immabark` there.
- If `IMMABARK_DEFAULT_CHANNEL` is set, you may omit `--channel`.
- Unsure about the setup? `immabark doctor` checks the token and lists the
  channels the bot is in.

## Send an alert

```bash
immabark post --channel '#ops-alerts' --text ':warning: Payment API unavailable'
```

Success: `{"ok": true, "ts": "...", "channel": "C..."}` on stdout.
Errors: `{"ok": false, "error": "..."}` on stderr, non-zero exit.

## Deduplication — keep --text stable

Alerts dedupe on channel + text. Repeats edit the original message with a
running count.

**CRITICAL:** put timestamps, IDs, row numbers, and any other variable detail
in `--blocks`, not `--text`. Text that changes every time posts a new message
every time, defeating the whole point.

```bash
immabark post --channel '#data-errors' \
  --text ':x: Invalid record in import batch' \
  --blocks 'Row 847: missing required field "email"'
```

`--blocks` takes a plain string (rendered as a context line) or a Slack
Block Kit JSON array for rich layouts.

## Thread mode

`--thread-replies` posts each repeat as a reply under the original message
instead of editing it — use it when every occurrence has unique detail worth
keeping.

## Thresholds

`--threshold 5/hr` suppresses the alert until it fires more than 5 times
inside an hour. Units: `min`/`minute`, `hr`/`hour`, `day`.

While suppressed the response is `{"ok": true, "suppressed": true, "count": N,
"threshold": "5/hr"}` — **that is success, not an error; do not retry.** When
the threshold is crossed, the alert posts with the accumulated count. The
window slides from the last occurrence and resets only after a full quiet
window.

## Cleanup and status

```bash
immabark clear --channel '#ops-alerts'   # delete the bot's alerts + replies there
immabark status --channel '#ops-alerts'  # {"alertCount": N}
immabark status                          # {"pending": N} local suppressed counts
```

## Error handling

- `SLACK_BOT_TOKEN is not set` → ask the user for the token or the one-time
  app setup (README quickstart).
- `not in that channel` → tell the user to run `/invite @immabark` in the
  target channel.
- `invalid_auth` → the token is wrong or revoked; ask the user.
- `Channel ... not found` → check the spelling; for a private channel, pass
  its channel ID (`C...`) and make sure the app has the `groups:history`
  scope.
