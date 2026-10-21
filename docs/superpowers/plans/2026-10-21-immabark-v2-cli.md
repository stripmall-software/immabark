# immabark v2 CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloudflare web app with a zero-dependency Node CLI + importable engine that dedupes Slack alerts using channel message metadata as shared state.

**Architecture:** One engine file (`lib/slack-alerts.js`, factory with injected `token`/`stateDir`/`fetchImpl`/`now`) holds all logic; posted alerts carry `metadata: {event_type: 'immabark_alert', event_payload: {hash, first_seen, last_seen, count}}` and are rediscovered by scanning channel history, so every producer converges on one counted message. A disposable `.immabark/state.json` holds only pre-post threshold counters and caches. A thin `bin/immabark.mjs` wraps the engine as `immabark post|clear|status`.

**Tech Stack:** Node ≥ 20 (global `fetch`, `crypto.subtle`, `node:fs`), vitest + prettier as the only devDependencies. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-immabark-v2-cli-design.md`

## Global Constraints

- Node ≥ 20; `"engines": {"node": ">=20"}` in package.json. Zero runtime dependencies.
- Metadata contract: `event_type: 'immabark_alert'`, `event_payload: {hash, first_seen, last_seen, count}` (ISO strings, number).
- Hash: `SHA-256(JSON.stringify({channel, message}))` with `channel` = resolved channel ID.
- Env: `SLACK_BOT_TOKEN` (required), `IMMABARK_STATE_DIR` (default `.immabark` under cwd).
- Discovery scan bound: last 200 messages (`--scan-limit` overrides). `clear` paginates fully, cap 10,000 messages.
- CLI output: one JSON object on stdout; errors `{ok: false, error}` on stderr, non-zero exit.
- Stdin payload shape (v1 webhook compat): `{channel, text, blocks, options: {threadReplies, threshold}}`.
- Threshold units: `min|minute|hr|hour|day`; sliding window measured from `last_seen` (shared metadata when a message exists, local otherwise).
- Prettier: tabs, single quotes (existing `.prettierrc`); MIT license (existing LICENSE).
- Port verbatim from v1 `src/lib/slack-alerts.js` (readable at git tag-point `oss-main`): `parseThreshold`, `buildSimpleBlocks`/`buildBlocks`, `slackRequest`, `deleteMessageWithReplies` shape. Delete the file after porting.

## Review Focus

- Bot not in the target channel (`not_in_channel` from history/post): error must name the fix — `/invite @immabark`. Test in Task 4.
- Missing/invalid `SLACK_BOT_TOKEN`: actionable error naming the env var and manifest setup, exit 1, no stack trace. Test in Task 7.
- Malformed stdin JSON or missing `channel`/`text`: `{ok: false, error}` + exit 1, never a crash. Test in Task 7.
- Foreign/malformed metadata (an `immabark_alert` message whose payload lacks `count` or `last_seen`): treated as count 0 / window expired, never a crash. Test in Task 4.
- Duplicate older than the scan bound: posts fresh (documented, not an error). Test in Task 4.

---

### Task 1: Teardown and scaffold

**Files:**

- Delete: `src/` (entire), `schema.sql`, `wrangler.toml.example`, `.dev.vars.example`, `svelte.config.js`, `vite.config.js`, `jsconfig.json`, `static/` keep only `hero.png` `logo.png` (move to `assets/`), `.npmrc`, `.nvmrc` keep
- Modify: `package.json`, `.gitignore`, `.prettierignore`, `AGENTS.md`
- Create: `lib/` and `bin/` directories (empty until Task 2/7)

**Interfaces:**

- Produces: `package.json` with `"type": "module"`, `"bin": {"immabark": "bin/immabark.mjs"}`, `"engines": {"node": ">=20"}`, scripts `{"test": "vitest run", "test:unit": "vitest", "lint": "prettier --check .", "format": "prettier --write ."}`, devDependencies only `vitest` and `prettier`.

- [ ] **Step 1: Port v1 reference out of the way** — copy `src/lib/slack-alerts.js` to `docs/superpowers/specs/v1-slack-alerts.js.txt` (port reference; deleted again in Task 8).
- [ ] **Step 2: Delete the app** — `git rm -r src schema.sql wrangler.toml.example .dev.vars.example svelte.config.js vite.config.js jsconfig.json`; `mkdir -p assets && git mv static/hero.png static/logo.png assets/ && git rm -r static`.
- [ ] **Step 3: Rewrite `package.json`** per Produces; version stays `1.0.0` (v2 label happens at release), keep `"private": true`, `"license": "MIT"`, `"repository"`. Drop the `pnpm.onlyBuiltDependencies` block (no esbuild/workerd anymore).
- [ ] **Step 4: Update `.gitignore`** — remove Svelte/Cloudflare blocks (`.svelte-kit`, `.wrangler`, `wrangler.toml`, `.dev.vars`, vite timestamps); add `.immabark/`; keep `node_modules`, `.superpowers/`, OS junk. Update `.prettierignore`: drop `/static/`, add `assets/` and `docs/superpowers/specs/v1-slack-alerts.js.txt`.
- [ ] **Step 5: Rewrite `AGENTS.md`** — commands (`pnpm test`, `pnpm lint`), architecture (engine `lib/slack-alerts.js`, CLI `bin/immabark.mjs`, state in `.immabark/`), code style section kept minus D1/wrangler lines.
- [ ] **Step 6: Verify** — `rm -rf node_modules pnpm-lock.yaml && pnpm install && pnpm lint`. Expected: install succeeds with only vitest+prettier trees; lint passes. `pnpm test` is allowed to fail with "no test files" until Task 2.
- [ ] **Step 7: Commit** — `chore: remove the web app; scaffold the CLI package`.

### Task 2: Engine foundations — threshold parser, hashing, scratchpad

**Files:**

- Create: `lib/slack-alerts.js`, `lib/slack-alerts.test.js`

**Interfaces:**

- Produces: `createSlackAlerts({token, stateDir, fetchImpl = globalThis.fetch, now = () => Date.now()})` returning an object; this task implements `parseThreshold(str) -> {count, ms} | null` and `hashMessage(channelId, message) -> Promise<hex string>` on it, plus internal state helpers `loadState() -> {channels: {}, alerts: {}}` and `saveState(state)` (atomic temp+rename). State schema (internal but pinned for later tasks): `state.channels[name] = channelId`; `state.alerts["<channelId>|<hash>"] = {ts?, pending, firstSeen?, lastSeen?, updatedAt}` where `pending` = locally counted occurrences not yet reflected in Slack.

- [ ] **Step 1: Write failing tests** — port the v1 `parseThreshold` cases (`5/hr`, `10/min`, `1/day`, `3/minute`, `2/hour`, invalid/null → null) and `hashMessage` cases (64-hex, deterministic, changes with channel and with message) against `createSlackAlerts({token: 'x', stateDir: <tmpdir>})`; add scratchpad tests:
  - `state survives a round trip` (write an alert entry via a posting flow stub — or export-for-test via a `_state` accessor; simplest: test through `postAlert` later — here, test that a malformed `state.json` (literal `"not json"`) is ignored and the dir is created on demand).
  - `prunes alert entries older than 24h` (seed a state.json with `updatedAt` 25h ago via injected `now`; after any load-save cycle the entry is gone).
- [ ] **Step 2: Run, verify fail** — `pnpm vitest run lib/slack-alerts.test.js`. Expected: FAIL, `createSlackAlerts` not defined.
- [ ] **Step 3: Implement** the factory skeleton with `parseThreshold` and the hash ported from v1 (hash takes channelId), `loadState`/`saveState` with `node:fs` (mkdir recursive, `JSON.parse` in try/catch → fresh state, write `state.json.tmp` then rename, prune on save).
- [ ] **Step 4: Run, verify pass**, then `pnpm test` (whole suite green).
- [ ] **Step 5: Commit** — `feat: engine foundations — thresholds, hashing, scratchpad`.

### Task 3: Slack client and channel resolution

**Files:**

- Modify: `lib/slack-alerts.js`, `lib/slack-alerts.test.js`

**Interfaces:**

- Consumes: factory + state from Task 2.
- Produces: on the factory object, `resolveChannel(nameOrId) -> Promise<channelId>`; internal `slackRequest(endpoint, body, method = 'POST')` (token closed over; GET sends query params; throws `SlackError` carrying `data.error`, with a `retryAfter` property on HTTP 429). Test harness: `createFakeSlack()` in the test file — port of the v1 fake (`{calls, state, fetchImpl}`) extended with `conversations.list` (two pages: `[{id: 'C0AAA', name: 'ops'}]` + cursor, `[{id: 'C0BBB', name: 'dev'}]`) and per-endpoint overrides via `state.respond[endpoint]`.

- [ ] **Step 1: Write failing tests:**
  - `resolveChannel passes IDs through` — `C0123ABCDEF` returned as-is, no fetch calls.
  - `resolveChannel resolves #name via conversations.list and caches` — `'#ops'` and `'ops'` → `C0AAA`; second call makes no further fetch (cache in state file); `'dev'` found on page 2 (cursor followed).
  - `resolveChannel throws a clear error for unknown channels` — message contains the name and `conversations.list`.
  - `slack errors carry the Slack error code` — override `chat.postMessage` to `{ok: false, error: 'invalid_auth'}`; a later `postAlert` test relies on this; here assert via `resolveChannel` with `conversations.list` → `{ok: false, error: 'invalid_auth'}` rejects mentioning `invalid_auth`.
- [ ] **Step 2: Run, verify fail** (function not defined).
- [ ] **Step 3: Implement** `slackRequest` (v1 port + error throw + 429 handling) and `resolveChannel` (ID regex `/^[CGD][A-Z0-9]{8,}$/`, strip leading `#`, paginate `conversations.list?types=public_channel&limit=200`, cache hit before any fetch).
- [ ] **Step 4: Run, verify pass; whole suite green.**
- [ ] **Step 5: Commit** — `feat: slack client and channel resolution`.

### Task 4: postAlert — metadata dedup (no thresholds)

**Files:**

- Modify: `lib/slack-alerts.js`, `lib/slack-alerts.test.js`

**Interfaces:**

- Consumes: Tasks 2–3.
- Produces: `postAlert({channel, message, blocks, options}) -> {ok: true, ts, channel} | {ok: true, suppressed: true, count, threshold}`; internal `findAlert(channelId, hash) -> {ts, text, blocks, payload} | null` (cached ts → single-message `conversations.history` fetch `latest=ts&oldest=ts&inclusive=true&include_all_metadata=true`; miss → bounded scan, default `scanLimit: 200` factory option); `buildBlocks` ported from v1. Fake Slack grows: `chat.postMessage` records metadata and stores the message in a per-channel `state.messages` list that `conversations.history` serves (with metadata, newest first), `chat.update` mutates it.

- [ ] **Step 1: Write failing tests** (all through `postAlert` with the fake):
  - `first alert posts with metadata` — `chat.postMessage` called once; its body has `metadata.event_type === 'immabark_alert'` and payload `{hash, first_seen, last_seen, count: 1}`; blocks end with a `First seen:` context line; returns `{ok, ts, channel}`.
  - `duplicate found via local cache updates in place` — second identical post → `chat.update` (not postMessage), blocks contain `Count: 2`, metadata count 2, first_seen preserved, and the history fetch asked for exactly the cached ts.
  - `duplicate found via channel scan when cache is cold` — post once, wipe the state dir, post again from a fresh factory instance → scan (`conversations.history` without `latest`) then `chat.update` with count 2. **This is the cross-producer test.**
  - `count and first_seen come from metadata, not local state` — seed the fake channel with an existing immabark message (count 7, old first_seen) with no local state; post → count 8, first_seen preserved.
  - `malformed foreign metadata is tolerated` — seed an `immabark_alert` message whose payload is `{hash}` only; post → update with count 1+0+... asserts count is a number ≥ 1 and no throw.
  - `update race falls through to a fresh post` — `chat.update` responds `message_not_found` → `chat.postMessage` fresh, count restarts at 1, cache updated to the new ts.
  - `duplicate beyond the scan bound posts fresh` — factory `scanLimit: 2`, seed 3 unrelated messages atop an old immabark message → fresh post, no crash.
  - `not_in_channel is a clear error` — history responds `{ok: false, error: 'not_in_channel'}` → rejection mentioning `/invite @immabark`.
  - `blocks accept a string or Block Kit array` and `threadReplies posts replies and bumps parent metadata` — reply has `thread_ts` of parent, parent's visible blocks unchanged, parent metadata count incremented via an extra `chat.update`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `findAlert`, `buildBlocks` port, and the no-threshold `postAlert` path per the spec flow (resolve → hash → find → update-or-post; write ts cache on success).
- [ ] **Step 4: Run, verify pass; whole suite green.**
- [ ] **Step 5: Commit** — `feat: metadata-based dedup in postAlert`.

### Task 5: postAlert — thresholds with the shared window clock

**Files:**

- Modify: `lib/slack-alerts.js`, `lib/slack-alerts.test.js`

**Interfaces:**

- Consumes: Task 4's `postAlert`/`findAlert`; Task 2's state entries (`pending`, `firstSeen`, `lastSeen`).
- Produces: the threshold branch of `postAlert` (same signature). Semantics pinned by the spec: window measured from metadata `last_seen` when a message exists, from local `lastSeen` otherwise; suppressed hits on an existing message bump metadata via blocks-unchanged `chat.update` (best-effort: on 429 keep the hit in local `pending`); crossing posts/updates with `count = windowCount + local pending`, then clears `pending`.

- [ ] **Step 1: Write failing tests** (injected `now` for time travel):
  - `suppresses below threshold before any message exists` — `2/hr`: hits 1 and 2 → `{suppressed, count: 1|2}`, zero fetch calls to post endpoints; hit 3 → `chat.postMessage` with `Count: 3` and metadata count 3; local pending cleared.
  - `window expiry resets the local counter` — `2/hr`, one hit, advance 2h, next hit → `{suppressed, count: 1}`.
  - `suppressed hit on an existing message bumps shared metadata` — create the message via a plain post (count 1, last_seen now), then post the same alert with threshold `3/hr` → windowCount 2 ≤ 3, so the hit is suppressed; `chat.update` is sent with the message's OWN text/blocks (unchanged) and metadata count 2; returns `{suppressed: true, count: 2}`.
  - `another producer's suppressed hits are visible` — after the bump above, a fresh factory (cold cache) posting the same alert reads count 2 from the scan and continues from there.
  - `quiet window resets the shared count and first_seen` — existing message count 9, metadata last_seen 2h ago, threshold `2/hr` → hit computes windowCount 1 → suppressed with metadata bumped to count 1; a crossing after two more hits renders `Count: 3` with a NEW first_seen.
  - `rate-limited metadata bump is kept locally and folded in` — `chat.update` responds HTTP 429 once; suppressed hit returns normally with the hit in local pending; next hit succeeds and the metadata count includes the backlog.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the threshold branch; port v1's `isWithinWindow` against the chosen clock source.
- [ ] **Step 4: Run, verify pass; whole suite green.**
- [ ] **Step 5: Commit** — `feat: threshold suppression with shared window clock`.

### Task 6: clearChannel and getStatus

**Files:**

- Modify: `lib/slack-alerts.js`, `lib/slack-alerts.test.js`

**Interfaces:**

- Consumes: Tasks 3–4 (client, resolution, fake message store).
- Produces: `clearChannel(channel) -> {count, deleted}` (full-history cursor pagination, 10,000-message cap, deletes this bot's `immabark_alert` messages + thread replies — bot identity via one `auth.test` call — and drops the channel's state entries); `getStatus(channel) -> {alertCount}` (bounded scan counting `immabark_alert` messages); `getStatus()` with no channel → `{pending: <n>}` from the local scratchpad only, no network.

- [ ] **Step 1: Write failing tests:**
  - `clearChannel deletes alerts and replies across pages` — fake history serves 2 pages via cursor (3 immabark alerts, one with 2 replies, plus human messages); `auth.test` identifies the bot; result `{count: 3, deleted: 5}`; non-immabark messages untouched; state entries for the channel gone; dedup restarts (next post is fresh).
  - `clearChannel ignores other bots' metadata` — an `immabark_alert` message with a different bot author survives.
  - `getStatus counts channel alerts via scan; bare getStatus reads only local state` — bare call makes zero fetch calls.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** (port `deleteMessageWithReplies` from v1; pagination loop with `response.response_metadata.next_cursor`).
- [ ] **Step 4: Run, verify pass; whole suite green.**
- [ ] **Step 5: Commit** — `feat: clear and status`.

### Task 7: The CLI

**Files:**

- Create: `bin/immabark.mjs`, `bin/immabark.test.js`

**Interfaces:**

- Consumes: the full factory API from Tasks 2–6.
- Produces: executable `bin/immabark.mjs` (shebang `#!/usr/bin/env node`, self-run guard via `pathToFileURL(process.argv[1]).href === import.meta.url`) exporting `run(argv, {env = process.env, stdinText = null, createAlerts = createSlackAlerts}) -> Promise<{code, out, err}>` for tests. Commands: `post` (flags `--channel`, `--text`, `--blocks <string|json>`, `--threshold`, `--thread-replies`, `--scan-limit <n>`, `--token`; or `post -` reading the stdin JSON shape), `clear --channel`, `status [--channel]`, `help`/no args. Token from `--token` else `env.SLACK_BOT_TOKEN`; state dir from `env.IMMABARK_STATE_DIR` else `.immabark`.

- [ ] **Step 1: Write failing tests** (unit-test `run` with a stub `createAlerts` recording calls; one spawn smoke test for the shebang path):
  - `post maps flags to postAlert` — channel/text/blocks/threshold/threadReplies arrive correctly; `out` is the JSON result; code 0.
  - `post - parses the v1 webhook payload from stdin` — `{channel, text, blocks, options: {threadReplies: true, threshold: '5/hr'}}` maps fully.
  - `missing token is an actionable error` — no `--token`, empty env → code 1, `err` JSON mentions `SLACK_BOT_TOKEN` and `slack-app-manifest.yaml`, no stack trace.
  - `missing --channel/--text and malformed stdin JSON` → code 1, `{ok: false, error}` on err.
  - `engine errors surface as {ok:false,error} with code 1` — stub rejects with a SlackError.
  - `help prints usage, code 0`; unknown command → usage on err, code 1.
  - Smoke: `node bin/immabark.mjs help` via `child_process.execFile` → exit 0.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — hand-rolled argv loop (no deps); `chmod +x bin/immabark.mjs`.
- [ ] **Step 4: Run, verify pass; whole suite green; `pnpm lint` clean.**
- [ ] **Step 5: Commit** — `feat: immabark CLI`.

### Task 8: Docs, skill, manifest, final sweep

**Files:**

- Modify: `README.md`, `skills/immabark/SKILL.md`, `slack-app-manifest.yaml`
- Delete: `docs/superpowers/specs/v1-slack-alerts.js.txt`

**Interfaces:**

- Consumes: the CLI surface from Task 7 (exact flags/commands in all docs).

- [ ] **Step 1: Rewrite `slack-app-manifest.yaml`** — drop `oauth_config.redirect_urls` and `features.slash_commands`; scopes `chat:write`, `channels:history`, `channels:read`; comment header: create from manifest → Install to Workspace → copy Bot User OAuth Token → `export SLACK_BOT_TOKEN=...`; private channels note (`groups:history` opt-in).
- [ ] **Step 2: Rewrite `README.md`** — keep the "Count: 1000" hook and MIT badge; 60-second quickstart (manifest → token → `/invite @immabark` → `immabark post ...` twice to see the edit); How it works (metadata = shared state, disposable `.immabark/`, per-window thresholds incl. sliding-window sentence); CLI reference (all commands/flags + stdin v1-payload migration note: swap `curl $URL -d @-` for `immabark post -`); library usage (`import {createSlackAlerts} from './lib/slack-alerts.js'`, copy-the-file framing, not on npm); agent skill section; local dev (`pnpm test`, `pnpm lint`); known limits (scan bound, brief first-post races, best-effort counts under rate limits).
- [ ] **Step 3: Rewrite `skills/immabark/SKILL.md`** — frontmatter description unchanged in spirit; body: prerequisite `SLACK_BOT_TOKEN` (ask the user; secret) and one-time Slack app setup pointer; run `immabark post --channel ... --text ...` (or `node bin/immabark.mjs` when not on PATH); stable-`--text` dedup rule; `suppressed: true` is success; thresholds; `immabark clear`/`status`; error handling (`not_in_channel` → `/invite`, auth errors → token).
- [ ] **Step 4: Sweep** — `git rm docs/superpowers/specs/v1-slack-alerts.js.txt`; grep gates: `grep -rni "cloudflare\|wrangler\|d1\|svelte\|webhook\|oauth\|api_key\|stripe" README.md skills/ bin/ lib/ slack-app-manifest.yaml AGENTS.md package.json` → only deliberate mentions (the README migration note may say "webhook"); `git ls-files | grep -iE 'svelte|wrangler|schema.sql|dev.vars'` → empty.
- [ ] **Step 5: Full verification** — `pnpm lint && pnpm test`; fresh-clone sim: `git stash -u || true`, confirm clean tree builds: `rm -rf node_modules && pnpm install && pnpm test`. Expected: green.
- [ ] **Step 6: Commit** — `docs: v2 README, skill, and manifest`.

---

## Post-plan (operator steps, not tasks — each needs Rob's go-ahead)

1. Optional live smoke test with a real `SLACK_BOT_TOKEN` against a test channel (post ×2 → edit-in-place; threshold `2/hr` → suppressed ×2 then post; `clear`).
2. Release: `gh repo rename immabark-saas-archive` on the old private repo → `gh repo create stripmall-software/immabark --public` → squash `v2-design` history into one release commit (same orphan technique as v1) → push.
