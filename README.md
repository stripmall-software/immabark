# immabark

De-spammed Slack alerts: repeated alerts edit the original message in place
with a count, instead of flooding the channel.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Your tooling sends the same alert 1,000 times over a weekend. By Monday your
#alerts channel is unreadable. With immabark you get one message instead:

> 🚨 Import failed: Connection timeout
> First seen: Sat, Dec 27, 2:15 AM / Last seen: Mon, Dec 29, 8:42 AM / 🔁 **Count: 1000**

No server. No database. No webhook. A zero-dependency CLI that runs anywhere
Node ≥ 20 runs — your laptop, a cron box, CI, an agent workspace, a git repo.

## 60-second quickstart

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) →
   **Create New App** → **From a manifest**, pasting
   [`slack-app-manifest.yaml`](slack-app-manifest.yaml).
2. **Install to Workspace** and copy the Bot User OAuth Token:
   `export SLACK_BOT_TOKEN=xoxb-...`
3. Invite the bot where you want alerts: `/invite @immabark` in the channel.
4. Post an alert — no install needed:

```bash
npx -y immabark post --channel '#ops-alerts' --text ':warning: Payment API unavailable'
```

(`npm i -g immabark` if you'd rather have `immabark` on your PATH; examples
below assume you do. `npx -y immabark doctor` checks your token and lists the
channels the bot is in.)

Run it twice — instead of a second message, the first one gains
"First seen / Last seen / 🔁 Count: 2".

Deduplication is the core trick, not the whole kit:

```bash
# Keep dedup keys stable: variable detail goes in --blocks, not --text.
# --thread-replies collects each occurrence as a reply instead of editing.
immabark post --channel '#data-errors' --text ':x: Invalid record in import batch' \
  --blocks 'Row 847: missing required field "email"' --thread-replies

# Noisy-but-normal errors: suppress until they exceed a rate, then post
# one message carrying the accumulated count.
immabark post --channel '#ops-alerts' --text ':warning: Retry queue growing' \
  --threshold 5/hr

# Anything that can't exec Node can pipe the JSON (same body as the old
# hosted webhook) through whatever can:
echo '{"channel":"#ops-alerts","text":"backup finished","blocks":"42 GB in 12m"}' \
  | immabark post -
```

## How it works

Alerts are deduplicated by hashing the channel + alert text. Each posted alert
carries invisible [Slack message metadata](https://api.slack.com/metadata)
(`event_type: immabark_alert`) holding that hash plus first-seen/last-seen/count.
Before posting, immabark scans the channel's recent history for a matching
hash and edits that message instead of posting a new one.

**The channel is the database.** Three cron boxes, CI, and an AI agent all
posting the same alert converge on one counted message, because they all read
the same channel. Delete the message in Slack and the slate is genuinely
clean. A small local scratchpad (`.immabark/`, gitignored) only caches lookups
and counts not-yet-posted threshold suppressions — deleting it never loses an
alert.

**The dedup-key rule:** keep `--text` stable; put timestamps, IDs, and other
variable detail in `--blocks`. Text that changes every time posts a new
message every time.

## CLI reference

```
immabark post --channel '#ops' --text 'Import failed'
              [--blocks <string | Block Kit JSON>]   extra context under the alert
              [--threshold 5/hr]                     suppress until rate exceeded
              [--thread-replies]                     repeats reply in a thread
              [--scan-limit <n>]                     history lookback (default 200)
              [--token <xoxb-...>]                   instead of SLACK_BOT_TOKEN
immabark post -                read {channel, text, blocks, options} JSON from stdin
immabark clear --channel '#ops'    delete this bot's alerts + replies there
immabark status [--channel '#ops'] count alerts, or show local pending counts
immabark doctor                    check the token; list channels the bot is in
```

`IMMABARK_DEFAULT_CHANNEL` is used whenever `--channel` is omitted — set it
once in a workspace (or an agent's environment) and alerts need only text.

Output is one JSON object on stdout; errors are `{"ok": false, "error": ...}`
on stderr with a non-zero exit code.

**Thresholds** (`5/hr`, `10/min`, `1/day`) hold an alert back until it fires
more than N times inside the window, then post with the accumulated count.
While suppressed, the response is `{"ok": true, "suppressed": true, "count": N,
...}` — that's success, not an error. The window slides from the last
occurrence: it resets only after a full window of quiet.

**Migrating from the old webhook?** The stdin mode takes the same JSON body:
swap `curl $WEBHOOK_URL -d @-` for `immabark post -`.

## Using the library

The whole engine is one zero-dependency file, importable from the package —
or just copy `lib/slack-alerts.js` into your project:

```js
import { createSlackAlerts } from 'immabark';

const alerts = createSlackAlerts({ token: process.env.SLACK_BOT_TOKEN });
await alerts.postAlert({
	channel: '#alerts',
	message: 'Deployment failed',
	blocks: 'Error: timeout after 30s',
	options: { threshold: '5/hr' }
});
```

Factory options: `token` (required), `stateDir` (default `.immabark`),
`fetchImpl`, `now`, `scanLimit`. Returns `{ postAlert, clearChannel, getStatus,
resolveChannel, hashMessage, parseThreshold }`.

## Agent skill

[`skills/immabark/SKILL.md`](skills/immabark/SKILL.md) teaches an AI agent
(Claude Code, openclaw, or anything that reads SKILL.md files) to send
deduplicated alerts. Copy the directory into `~/.claude/skills/` or your
project's `.claude/skills/` (it also ships inside the npm package under
`skills/`), and set `SLACK_BOT_TOKEN` — plus, ideally,
`IMMABARK_DEFAULT_CHANNEL` — in the agent's environment. The skill runs the
CLI via `npx -y immabark`, so nothing needs installing.

## Known limits

- Discovery scans the last 200 messages (`--scan-limit` to change): an alert
  that last fired further back posts fresh — usually what you want anyway.
- Two producers first-posting the same alert in the same instant can briefly
  double-post; the next occurrence converges on one of them.
- Suppressed-hit counts sync to Slack best-effort: under heavy rate limiting
  they lag a few seconds locally, but are never lost.
- Private channels: add the `groups:history` scope to the manifest AND pass
  the channel ID (`C...`) as `--channel` — name lookup only covers public
  channels.
- Producers sharing a channel converge on one message when they share one
  Slack app (one token). Two _separate_ immabark installations in the same
  channel each keep their own counted message — Slack doesn't let one app
  edit another's.

## Local development

```bash
pnpm install
pnpm test     # vitest; Slack and the filesystem are faked, no network
pnpm lint     # prettier
```

## License

[MIT](LICENSE)
