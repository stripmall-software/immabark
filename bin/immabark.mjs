#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createSlackAlerts } from '../lib/slack-alerts.js';

const USAGE = `immabark — de-spammed Slack alerts (repeats edit the original message with a count)

Usage:
  immabark post --channel '#ops' --text 'Import failed' [--blocks <string|json>]
                [--threshold 5/hr] [--thread-replies] [--scan-limit <n>] [--token <xoxb-...>]
  immabark post -             read a JSON payload {channel, text, blocks, options} from stdin
  immabark clear --channel '#ops'     delete this bot's alerts (and replies) in the channel
  immabark status [--channel '#ops']  count alerts in a channel, or show local pending counts
  immabark help

Environment:
  SLACK_BOT_TOKEN      bot token (required unless --token); see slack-app-manifest.yaml
  IMMABARK_STATE_DIR   local scratchpad directory (default: .immabark)`;

function parseArgs(args) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--thread-replies') {
			flags.threadReplies = true;
		} else if (arg.startsWith('--')) {
			flags[arg.slice(2)] = args[++i];
		} else {
			positional.push(arg);
		}
	}
	return { flags, positional };
}

function parseBlocks(raw) {
	if (raw == null) return undefined;
	const trimmed = raw.trim();
	if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
		return JSON.parse(trimmed);
	}
	return raw;
}

export async function run(
	argv,
	{ env = process.env, stdinText = null, createAlerts = createSlackAlerts } = {}
) {
	const [command, ...rest] = argv;
	const { flags, positional } = parseArgs(rest);

	if (!command || command === 'help') {
		return { code: 0, out: USAGE, err: '' };
	}
	if (!['post', 'clear', 'status'].includes(command)) {
		return { code: 1, out: '', err: `Unknown command: ${command}\n\n${USAGE}` };
	}

	try {
		const token = flags.token || env.SLACK_BOT_TOKEN;
		if (!token) {
			throw new Error(
				'SLACK_BOT_TOKEN is not set — create a Slack app from slack-app-manifest.yaml, install it to your workspace, and export its Bot User OAuth Token as SLACK_BOT_TOKEN (or pass --token)'
			);
		}

		const factoryOpts = {
			token,
			stateDir: env.IMMABARK_STATE_DIR || '.immabark'
		};
		if (flags['scan-limit']) factoryOpts.scanLimit = Number(flags['scan-limit']);
		const alerts = createAlerts(factoryOpts);

		let result;
		if (command === 'post') {
			let payload;
			if (positional[0] === '-') {
				const parsed = JSON.parse(stdinText ?? '');
				payload = {
					channel: parsed.channel,
					message: parsed.text,
					blocks: parsed.blocks,
					options: parsed.options ?? {}
				};
			} else {
				const options = {};
				if (flags.threadReplies) options.threadReplies = true;
				if (flags.threshold) options.threshold = flags.threshold;
				payload = {
					channel: flags.channel,
					message: flags.text,
					blocks: parseBlocks(flags.blocks),
					options
				};
			}
			if (!payload.channel)
				throw new Error('Missing --channel (or "channel" in the stdin payload)');
			if (!payload.message) throw new Error('Missing --text (or "text" in the stdin payload)');
			result = await alerts.postAlert(payload);
		} else if (command === 'clear') {
			if (!flags.channel) throw new Error('Missing --channel');
			result = await alerts.clearChannel(flags.channel);
		} else {
			result = await alerts.getStatus(flags.channel);
		}

		return { code: 0, out: JSON.stringify(result), err: '' };
	} catch (err) {
		return { code: 1, out: '', err: JSON.stringify({ ok: false, error: err.message }) };
	}
}

async function readStdin() {
	let text = '';
	for await (const chunk of process.stdin) text += chunk;
	return text;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const argv = process.argv.slice(2);
	const needsStdin = argv.includes('-');
	const { code, out, err } = await run(argv, {
		stdinText: needsStdin ? await readStdin() : null
	});
	if (out) console.log(out);
	if (err) console.error(err);
	process.exit(code);
}
