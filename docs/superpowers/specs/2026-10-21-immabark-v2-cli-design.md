# immabark v2 — drop-anywhere CLI design

## Intent

immabark de-spams Slack alerts: repeated alerts edit the original message in
place with a "First seen / Last seen / Count" footer instead of flooding the
channel, and thresholds like `5/hr` hold an alert back until it fires more
than N times in a window.

v1 was a hosted SaaS, then (unreleased) a self-hostable Cloudflare Workers app.
v2 drops the server entirely: immabark becomes a tool that lives where the
work happens — an agent workspace (openclaw, Claude Code) or a git repo. You
create a Slack app, paste one bot token, and run a CLI. No deploy, no
database, no webhook, no public URL.

The key insight enabling this: **Slack message metadata makes the channel
itself the shared dedup store.** `chat.postMessage` accepts an invisible
`metadata` field that comes back from `conversations.history` with
`include_all_metadata=true`. Every producer — three agent workspaces, a cron
box, CI — reading the same channel converges on the same deduplicated message,
with zero shared infrastructure.

## Goals

- `immabark post --channel '#ops' --text 'Import failed'` works seconds after
  pasting a bot token. Repeats edit the original message with a count.
- Dedup is **global across producers** sharing a channel (via metadata), not
  per-machine.
- Thresholds (`--threshold 5/hr`) suppress until the rate is exceeded, then
  post with the accumulated count.
- The agent skill is a first-class interface: `skills/immabark/SKILL.md`
  drives the CLI directly.
- The library face survives: the engine stays importable as a module.
- Zero runtime dependencies. Node ≥ 20 (global `fetch`, `crypto.subtle`).

## Non-goals

- Hosted service, multi-workspace OAuth install flow, web UI, webhook
  endpoint, Cloudflare/D1 anything. All deleted.
- Slack slash commands (`/imma ...`) — they require a public URL. `immabark
clear` / `immabark status` replace them.
- npm publishing (fast-follow if demand appears; repo-only for now).
- Perfect atomicity: two producers first-posting the same alert in the same
  instant may briefly double-post. Acceptable for alerting.

## Anti-goals (failure even if it works)

- Anything that requires a public HTTPS endpoint or a deploy step.
- A load-bearing local database. Local state must be a disposable scratchpad:
  deleting it may cost one early post or one extra history scan, never
  correctness.

## Decisions already made (by Rob)

- Web app and Cloudflare infra are removed, not preserved behind a flag.
- Channel metadata is the source of truth; the local file holds only
  threshold counters (and a hash→ts cache).
- Per-producer threshold counting is acceptable: once any producer posts,
  the channel merges everyone's counts.
- MIT license; public repo `github.com/stripmall-software/immabark` with
  fresh history. The existing private GitHub repo is **renamed to a private
  archive** (e.g. `immabark-saas-archive`), not deleted; local branches
  `main`/`private-history`/`oss-release` preserve the SaaS and v1 work.
- Each workspace/repo has its own Slack installation (its own token), or
  several share one — both must work with no configuration beyond the token.

## Mechanism

### State model

- **Identity:** `hash = SHA-256(JSON.stringify({channel, message}))` where
  `channel` is the **resolved channel ID**, not the string as typed (builder's
  call: `#ops`, `ops`, and `C0123ABC` must dedupe together or the
  cross-producer promise silently breaks; v1 hash stability is moot since
  nothing migrates). Resolution happens once per channel and is cached in the
  scratchpad.
- **Count semantics: v1's per-window reset, ported (decided with Rob).** The
  metadata payload carries `{hash, first_seen, last_seen, count}`, and
  `last_seen` is the shared window clock: every producer evaluates
  "window expired?" against the metadata's last_seen, never against local
  state, so all producers reach the same verdict and a reset can't clobber
  anyone's merged history. Window active → count climbs (suppressed hits on an
  existing message bump metadata via a blocks-unchanged `chat.update`, so even
  mid-suppression counts are shared); a full quiet window → next occurrence
  starts a new window with count and first_seen reset — exactly v1, with the
  DB row replaced by the message.
  **Rate-limit posture (builder's call):** suppressed-hit metadata bumps are
  best-effort — when Slack rate-limits the update, count locally and fold the
  backlog into the next successful write. Counts may lag seconds under a
  storm; they are never lost. The only per-producer residue is suppression
  before any message exists (nothing to hang metadata on), as already
  accepted.
- **Channel state:** posted alerts carry
  `metadata: { event_type: 'immabark_alert', event_payload: { hash, first_seen, count } }`.
  Humans never see it; any producer with `channels:history` reads it back.
- **Local scratchpad:** `.immabark/state.json` (location overridable via
  `IMMABARK_STATE_DIR`; gitignored). Holds `{ [channel+hash]: { ts cache,
threshold counter, window start } }`. Atomic write (write temp + rename).
  Disposable by design.

### postAlert flow

1. Hash the alert. Threshold configured? Check/update the local counter with
   v1's sliding-window semantics (`parseThreshold`, `isWithinWindow` port).
   Under threshold → increment, print `{suppressed: true, count}`, exit 0.
2. Find the existing message: local ts cache first; on miss, scan
   `conversations.history?include_all_metadata=true` (bounded: default last
   200 messages, `--scan-limit` to override) for a message whose metadata
   hash matches.
3. Found → `chat.update` with re-rendered blocks (count+1 — channel count,
   plus any locally suppressed occurrences — and updated last-seen) and
   updated metadata. `message_not_found` → treat as deleted, fall through.
4. Not found → `chat.postMessage` with metadata, count = 1 + suppressed
   backlog. Cache the new ts locally.
5. `--thread-replies`: same discovery, but repeats post as replies under the
   found parent instead of editing its visible blocks (v1 behavior preserved,
   including falling back to a fresh post when the parent was deleted).
   Builder's call: each repeat ALSO `chat.update`s the parent to bump
   count/last_seen in its metadata (blocks unchanged) — one extra API call,
   so cross-producer counts and `status` stay correct in this mode.

Block rendering (`buildBlocks`, the First seen / Last seen / Count context
line) ports from v1 unchanged.

### CLI surface

```
immabark post   --channel '#ops' --text '...' [--blocks <string|json>]
                [--threshold 5/hr] [--thread-replies]
immabark clear  --channel '#ops'     # delete this bot's alert messages + replies there
immabark status [--channel '#ops']   # count immabark alerts via metadata scan
immabark help
```

- Token from `SLACK_BOT_TOKEN` (flag `--token` as override). Missing token is
  a clear, actionable error naming the manifest setup steps.
- Also accepts a JSON body on stdin (`immabark post -`) matching the v1
  webhook payload shape `{channel, text, blocks, options}`, so v1 users and
  existing scripts migrate by swapping `curl $URL -d @-` for `immabark post -`.
- Output: one JSON object on stdout (`{ok, ts, channel}` or
  `{ok, suppressed, count, threshold}`); errors as `{ok: false, error}` on
  stderr with non-zero exit.

`clear` finds messages by scanning history for `event_type: immabark_alert`
posted by this bot (identified via `auth.test`), deletes each with its thread
replies, and drops the local scratchpad entries. Builder's call: unlike
`post`'s bounded discovery scan, `clear` paginates the FULL channel history
(cursor loop, sanity cap ~10k messages, respecting rate limits) — a bounded
clear that silently left older alerts standing would read as a bug.
(`clearall` is out: without a server there is no channel registry; enumerate
channels is a fast-follow if wanted.)

### Repo layout (after)

```
README.md  LICENSE  slack-app-manifest.yaml  package.json
bin/immabark.mjs          # CLI entry (thin: arg parsing + engine calls)
lib/slack-alerts.js       # the engine (importable; zero deps)
lib/slack-alerts.test.js  # vitest
skills/immabark/SKILL.md  # drives the CLI
docs/superpowers/specs/   # this document
```

Deleted relative to v1: all of `src/` (SvelteKit app), `schema.sql`,
`wrangler.toml.example`, `.dev.vars.example`, svelte/vite/tailwind configs and
devDependencies. `package.json` keeps only `vitest` + `prettier` as devDeps
and gains `"bin": {"immabark": "bin/immabark.mjs"}` so `npx`/local-link work.

### Slack app manifest (simplified)

No OAuth redirect, no slash command. Bot scopes: `chat:write`,
`channels:history` (metadata scan), `channels:read` (resolve `#name` → ID
when needed). Setup: create app from manifest → Install to Workspace →
copy the Bot User OAuth Token → `export SLACK_BOT_TOKEN=...` →
`/invite @immabark` in target channels. Private-channel support = user adds
`groups:history` themselves; README notes it.

### Skill rewrite

SKILL.md teaches: ensure `SLACK_BOT_TOKEN` (ask the user; treat as secret),
run `immabark post` (or `node bin/immabark.mjs` when not linked), the
dedup-key rule (stable `--text`, variable detail in `--blocks`),
`suppressed: true` is success not an error, thresholds for recurring checks,
`immabark clear`/`status` for management. Install = copy `skills/immabark/`
into `~/.claude/skills/` or the workspace's skills dir; the skill must state
the one-time Slack app setup as its prerequisite with a pointer to the README.

## Testing

Port the v1 vitest suite to the new state model: fake `fetch` (canned Slack
responses, call recorder — reuse v1's fake), temp `IMMABARK_STATE_DIR` per
test. Must cover: first post carries metadata; duplicate found via history
scan (cache miss) and via cache; count/first-seen come from metadata not
local state; threshold suppress → accumulate → post with merged count; window
expiry reset; suppressed backlog merging into another producer's message;
`message_not_found` fallback; `clear` deletes messages+replies; malformed
state file ignored (scratchpad is disposable); stdin JSON mode. Signature
verification (`slack-verify.js`) is dead — delete with the routes.

## Migration / release

- Branch from the v1 orphan commit (`oss-main`); delete the app, add the CLI.
- v1's Cloudflare incarnation is never published; it survives on local branch
  `oss-release` and in the renamed private archive repo.
- README rewrites around the 60-second quickstart: manifest → token →
  `immabark post`. Keep the "Count: 1000" before/after hook.
- Release: fresh public repo as already decided; rename old repo first.

## Left to the builder

- Arg parsing style (hand-rolled `process.argv` loop — zero deps — is fine).
- Exact scan bound default and whether `oldest=` (time-based) beats
  `limit=` (count-based); pick one, document it.
- State-file schema details and pruning (drop entries older than the largest
  window, e.g. > 24h).
- Channel-name → ID resolution mechanics (`conversations.list` lookup, cached
  in the scratchpad; note resolution must precede hashing — see State model).
- Whether `status` without `--channel` reads only the local scratchpad (no
  scan) — acceptable.
