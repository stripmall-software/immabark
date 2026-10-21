# AGENTS.md - immabark

## Commands

- `pnpm test` - Run all unit tests once (Vitest)
- `pnpm test:unit lib/slack-alerts.test.js` - Run single test file (watch mode)
- `pnpm lint` - Check formatting (Prettier)
- `pnpm format` - Auto-format code

## Architecture

- **Engine**: `lib/slack-alerts.js` — zero-dependency factory
  (`createSlackAlerts({token, stateDir, ...})`) holding all alert logic.
  Dedup state lives in Slack message metadata; `.immabark/state.json` is a
  disposable local scratchpad (threshold counters, caches).
- **CLI**: `bin/immabark.mjs` — thin wrapper (`immabark post|clear|status`),
  token from `SLACK_BOT_TOKEN`, state dir from `IMMABARK_STATE_DIR`.
- **Skill**: `skills/immabark/SKILL.md` teaches AI agents to drive the CLI.
- **Slack app**: created from `slack-app-manifest.yaml`; no server, no OAuth
  flow, no webhook.

## Code Style

- Tabs for indentation, single quotes, no trailing commas (Prettier handles it)
- Node >= 20, ESM only, zero runtime dependencies
- `export function` for module exports, factory pattern for stateful modules
- Tests fake `fetch` and use a temp `IMMABARK_STATE_DIR`; no network
