import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Scratchpad entries older than this are pruned on save; the file is a
// disposable cache, never the source of truth (that's the Slack channel).
const PRUNE_MS = 24 * 60 * 60 * 1000;

// Channel names are always lowercase, so an uppercase C/G/D-prefixed token is an ID
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{4,}$/;

export class SlackError extends Error {
	constructor(code, retryAfter) {
		super(`Slack error: ${code}`);
		this.code = code;
		this.retryAfter = retryAfter;
	}
}

export function createSlackAlerts({
	token,
	stateDir = '.immabark',
	fetchImpl = globalThis.fetch,
	now = () => Date.now(),
	scanLimit = 200
}) {
	const stateFile = join(stateDir, 'state.json');

	const loadState = () => {
		try {
			const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
			return { channels: parsed.channels ?? {}, alerts: parsed.alerts ?? {} };
		} catch {
			return { channels: {}, alerts: {} };
		}
	};

	const saveState = (state) => {
		for (const [key, entry] of Object.entries(state.alerts)) {
			const age = entry.updatedAt ? now() - new Date(entry.updatedAt).getTime() : Infinity;
			if (age > PRUNE_MS) delete state.alerts[key];
		}
		mkdirSync(stateDir, { recursive: true });
		const tmp = `${stateFile}.tmp`;
		writeFileSync(tmp, JSON.stringify(state));
		renameSync(tmp, stateFile);
	};

	const parseThreshold = (threshold) => {
		if (!threshold) return null;
		const match = threshold.match(/^(\d+)\/(min|minute|hr|hour|day)$/);
		if (!match) return null;
		const count = parseInt(match[1], 10);
		const unit = match[2];
		const ms = unit.startsWith('min')
			? 60 * 1000
			: unit === 'day'
				? 24 * 60 * 60 * 1000
				: 60 * 60 * 1000;
		return { count, ms };
	};

	const hashMessage = async (channel, message) => {
		const str = JSON.stringify({ channel, message });
		const encoder = new TextEncoder();
		const data = encoder.encode(str);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	};

	async function slackRequest(endpoint, body, method = 'POST') {
		let res;
		if (method === 'GET') {
			const params = new URLSearchParams(body);
			res = await fetchImpl(`https://slack.com/api/${endpoint}?${params}`, {
				headers: { Authorization: `Bearer ${token}` }
			});
		} else {
			res = await fetchImpl(`https://slack.com/api/${endpoint}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body)
			});
		}
		if (res.status === 429) {
			throw new SlackError('rate_limited', Number(res.headers?.get?.('Retry-After')) || 1);
		}
		const data = await res.json();
		if (!data.ok) {
			throw new SlackError(data.error);
		}
		return data;
	}

	async function resolveChannel(nameOrId) {
		if (CHANNEL_ID_RE.test(nameOrId)) return nameOrId;
		const name = nameOrId.replace(/^#/, '');
		const state = loadState();
		if (state.channels[name]) return state.channels[name];

		let cursor;
		do {
			const body = { types: 'public_channel', limit: 200 };
			if (cursor) body.cursor = cursor;
			const data = await slackRequest('conversations.list', body, 'GET');
			for (const ch of data.channels ?? []) {
				if (ch.name === name) {
					state.channels[name] = ch.id;
					saveState(state);
					return ch.id;
				}
			}
			cursor = data.response_metadata?.next_cursor || null;
		} while (cursor);

		throw new Error(
			`Channel '${nameOrId}' not found via conversations.list — check the spelling; for a private channel, pass its channel ID (C...) and add the groups:history scope`
		);
	}

	const formatDateTime = (date) => {
		return new Intl.DateTimeFormat('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit',
			hour12: true
		}).format(date);
	};

	const fmt = (iso) => formatDateTime(new Date(iso));

	const contextBlock = (text) => ({
		type: 'context',
		elements: [{ type: 'mrkdwn', text }]
	});

	function buildSimpleBlocks(message, blocks) {
		const result = [
			{
				type: 'section',
				text: { type: 'mrkdwn', text: message }
			}
		];

		if (blocks) {
			if (Array.isArray(blocks)) {
				result.push(...blocks);
			} else {
				result.push(contextBlock(blocks));
			}
		}

		return result;
	}

	function buildBlocks(message, blocks, { firstSeen, lastSeen, count }) {
		const result = buildSimpleBlocks(message, blocks);
		const contextText =
			count > 1
				? `First seen: ${firstSeen} / Last seen: ${lastSeen} / :repeat: *Count: ${count}*`
				: `First seen: ${firstSeen}`;
		result.push(contextBlock(contextText));
		return result;
	}

	const buildMetadata = (hash, firstSeen, lastSeen, count) => ({
		event_type: 'immabark_alert',
		event_payload: { hash, first_seen: firstSeen, last_seen: lastSeen, count }
	});

	const alertKey = (channelId, hash) => `${channelId}|${hash}`;

	// Records a successful Slack write: the ts cache is refreshed and any
	// locally pending occurrences were folded into that write's count.
	const rememberTs = (channelId, hash, ts) => {
		const state = loadState();
		state.alerts[alertKey(channelId, hash)] = {
			ts,
			pending: 0,
			updatedAt: new Date(now()).toISOString()
		};
		saveState(state);
	};

	const asAlert = (msg) => ({
		ts: msg.ts,
		text: msg.text,
		blocks: msg.blocks,
		payload: msg.metadata?.event_payload ?? {}
	});

	async function findAlert(channelId, hash) {
		const cachedTs = loadState().alerts[alertKey(channelId, hash)]?.ts;
		if (cachedTs) {
			const data = await slackRequest(
				'conversations.history',
				{
					channel: channelId,
					latest: cachedTs,
					oldest: cachedTs,
					inclusive: true,
					limit: 1,
					include_all_metadata: true
				},
				'GET'
			);
			const msg = data.messages?.[0];
			if (msg?.metadata?.event_payload?.hash === hash) return asAlert(msg);
		}
		const data = await slackRequest(
			'conversations.history',
			{ channel: channelId, limit: scanLimit, include_all_metadata: true },
			'GET'
		);
		for (const msg of data.messages ?? []) {
			if (
				msg.metadata?.event_type === 'immabark_alert' &&
				msg.metadata.event_payload?.hash === hash
			) {
				return asAlert(msg);
			}
		}
		return null;
	}

	const withinWindow = (lastSeenIso, windowMs) => {
		if (!lastSeenIso) return false;
		const lastSeenTime = new Date(lastSeenIso).getTime();
		return now() - lastSeenTime < windowMs;
	};

	const loadEntry = (state, key) => state.alerts[key] ?? { pending: 0 };

	async function postAlert({ channel, message, blocks, options }) {
		const { threadReplies = false, threshold = null } = options ?? {};
		const thresholdConfig = parseThreshold(threshold);
		if (threshold && !thresholdConfig) {
			throw new Error(
				`Invalid threshold '${threshold}' — use {count}/{unit}, e.g. 5/hr, 10/min, 1/day (units: min, minute, hr, hour, day)`
			);
		}
		const channelId = await resolveChannel(channel);
		const hash = await hashMessage(channelId, message);
		const key = alertKey(channelId, hash);
		const nowIso = new Date(now()).toISOString();

		try {
			const existing = await findAlert(channelId, hash);
			const state = loadState();
			const entry = loadEntry(state, key);
			const pending = Number(entry.pending) || 0;

			if (existing && thresholdConfig) {
				// The message's own last_seen is the shared window clock.
				const windowActive = withinWindow(existing.payload.last_seen, thresholdConfig.ms);
				const sharedCount = windowActive ? Number(existing.payload.count) || 0 : 0;
				const windowCount = sharedCount + 1 + pending;
				const firstSeen = windowActive ? (existing.payload.first_seen ?? nowIso) : nowIso;

				if (windowCount <= thresholdConfig.count) {
					// Suppressed: bump shared metadata, blocks unchanged. Best-effort —
					// a rate-limited bump stays in the local pending backlog.
					const metadata = buildMetadata(hash, firstSeen, nowIso, windowCount);
					try {
						await slackRequest('chat.update', {
							channel: channelId,
							ts: existing.ts,
							text: existing.text,
							blocks: existing.blocks,
							metadata
						});
						state.alerts[key] = { ...entry, ts: existing.ts, pending: 0, updatedAt: nowIso };
					} catch (err) {
						const keepPending = ['rate_limited', 'message_not_found', 'cant_update_message'];
						if (!keepPending.includes(err.code)) throw err;
						state.alerts[key] = {
							...entry,
							ts: existing.ts,
							pending: pending + 1,
							updatedAt: nowIso
						};
					}
					saveState(state);
					return { ok: true, suppressed: true, count: windowCount, threshold };
				}
				// Crossed: fall through to the visible update below with the merged
				// count. The update branch re-adds `pending` + 1, so stash only the
				// shared part here or the backlog would be counted twice.
				existing.payload = { ...existing.payload, count: sharedCount, first_seen: firstSeen };
			}

			if (!existing && thresholdConfig) {
				const windowActive = withinWindow(entry.lastSeen, thresholdConfig.ms);
				const pendingCount = windowActive ? pending + 1 : 1;
				const firstSeen = windowActive ? (entry.firstSeen ?? nowIso) : nowIso;

				if (pendingCount <= thresholdConfig.count) {
					state.alerts[key] = {
						pending: pendingCount,
						firstSeen,
						lastSeen: nowIso,
						updatedAt: nowIso
					};
					saveState(state);
					return { ok: true, suppressed: true, count: pendingCount, threshold };
				}
				// Crossed before any message exists: post fresh with the backlog.
				const rendered = buildBlocks(message, blocks, {
					firstSeen: fmt(firstSeen),
					lastSeen: fmt(nowIso),
					count: pendingCount
				});
				const data = await slackRequest('chat.postMessage', {
					channel: channelId,
					text: message,
					blocks: rendered,
					metadata: buildMetadata(hash, firstSeen, nowIso, pendingCount)
				});
				state.alerts[key] = { ts: data.ts, pending: 0, updatedAt: nowIso };
				saveState(state);
				return { ok: true, ts: data.ts, channel: data.channel };
			}

			if (existing) {
				const newCount = (Number(existing.payload.count) || 0) + 1 + pending;
				const firstSeen = existing.payload.first_seen ?? nowIso;
				const metadata = buildMetadata(hash, firstSeen, nowIso, newCount);

				if (threadReplies) {
					const replyBlocks = blocks
						? Array.isArray(blocks)
							? blocks
							: [contextBlock(blocks)]
						: [];
					const reply = await slackRequest('chat.postMessage', {
						channel: channelId,
						text: message,
						blocks: replyBlocks,
						thread_ts: existing.ts
					});
					await slackRequest('chat.update', {
						channel: channelId,
						ts: existing.ts,
						text: existing.text,
						blocks: existing.blocks,
						metadata
					});
					rememberTs(channelId, hash, existing.ts);
					return { ok: true, ts: reply.ts, channel: reply.channel };
				}

				const rendered = buildBlocks(message, blocks, {
					firstSeen: fmt(firstSeen),
					lastSeen: fmt(nowIso),
					count: newCount
				});
				try {
					const data = await slackRequest('chat.update', {
						channel: channelId,
						ts: existing.ts,
						text: message,
						blocks: rendered,
						metadata
					});
					rememberTs(channelId, hash, existing.ts);
					return { ok: true, ts: data.ts, channel: data.channel };
				} catch (err) {
					// message_not_found: it vanished between discovery and update.
					// cant_update_message: another Slack app owns it (two installations
					// sharing a channel) — we can't edit it, so start our own message.
					if (err.code !== 'message_not_found' && err.code !== 'cant_update_message') throw err;
				}
			}

			// A fresh post still carries any locally suppressed backlog for this alert.
			const freshCount = 1 + pending;
			const rendered = buildBlocks(message, blocks, {
				firstSeen: fmt(nowIso),
				lastSeen: fmt(nowIso),
				count: freshCount
			});
			const data = await slackRequest('chat.postMessage', {
				channel: channelId,
				text: message,
				blocks: rendered,
				metadata: buildMetadata(hash, nowIso, nowIso, freshCount)
			});
			rememberTs(channelId, hash, data.ts);
			return { ok: true, ts: data.ts, channel: data.channel };
		} catch (err) {
			if (err.code === 'not_in_channel') {
				throw new Error(
					'immabark is not in that channel — run /invite @immabark in the channel first'
				);
			}
			throw err;
		}
	}

	async function deleteMessageWithReplies(channelId, ts) {
		let deleted = 0;
		let replies = null;
		try {
			replies = await slackRequest(
				'conversations.replies',
				{ channel: channelId, ts, limit: 1000 },
				'GET'
			);
		} catch {
			// fall through to deleting the single message
		}
		const targets = replies?.messages?.length ? [...replies.messages].reverse() : [{ ts }];
		for (const msg of targets) {
			try {
				await slackRequest('chat.delete', { channel: channelId, ts: msg.ts });
				deleted++;
			} catch {
				// already gone or undeletable; keep going
			}
		}
		return deleted;
	}

	async function clearChannel(channel) {
		const channelId = await resolveChannel(channel);
		const auth = await slackRequest('auth.test', {});

		// Unlike post's bounded discovery scan, clear walks the full history —
		// silently leaving old alerts standing would read as a bug.
		const targets = [];
		let cursor;
		let seen = 0;
		do {
			const body = { channel: channelId, limit: 200, include_all_metadata: true };
			if (cursor) body.cursor = cursor;
			const data = await slackRequest('conversations.history', body, 'GET');
			const messages = data.messages ?? [];
			for (const msg of messages) {
				if (msg.metadata?.event_type === 'immabark_alert' && msg.bot_id === auth.bot_id) {
					targets.push(msg.ts);
				}
			}
			seen += messages.length;
			cursor = data.response_metadata?.next_cursor || null;
		} while (cursor && seen < 10000);

		let deleted = 0;
		for (const ts of targets) {
			deleted += await deleteMessageWithReplies(channelId, ts);
		}

		const state = loadState();
		for (const key of Object.keys(state.alerts)) {
			if (key.startsWith(`${channelId}|`)) delete state.alerts[key];
		}
		saveState(state);

		return { count: targets.length, deleted };
	}

	async function getStatus(channel) {
		if (!channel) {
			const state = loadState();
			let pending = 0;
			for (const entry of Object.values(state.alerts)) {
				pending += Number(entry.pending) || 0;
			}
			return { pending };
		}
		const channelId = await resolveChannel(channel);
		const data = await slackRequest(
			'conversations.history',
			{ channel: channelId, limit: scanLimit, include_all_metadata: true },
			'GET'
		);
		const alertCount = (data.messages ?? []).filter(
			(m) => m.metadata?.event_type === 'immabark_alert'
		).length;
		return { alertCount };
	}

	async function doctor() {
		const auth = await slackRequest('auth.test', {});

		let channels = null;
		try {
			channels = [];
			let cursor;
			do {
				const body = { types: 'public_channel', user: auth.user_id, limit: 200 };
				if (cursor) body.cursor = cursor;
				const data = await slackRequest('users.conversations', body, 'GET');
				channels.push(...(data.channels ?? []).map((ch) => `#${ch.name}`));
				cursor = data.response_metadata?.next_cursor || null;
			} while (cursor);
		} catch {
			channels = null; // membership listing is best-effort; the token check above is the point
		}

		const state = loadState();
		let pending = 0;
		for (const entry of Object.values(state.alerts)) {
			pending += Number(entry.pending) || 0;
		}

		return {
			ok: true,
			team: auth.team,
			botUser: auth.user,
			channels,
			stateDir,
			pending
		};
	}

	return {
		parseThreshold,
		hashMessage,
		resolveChannel,
		postAlert,
		clearChannel,
		getStatus,
		doctor,
		_state: { load: loadState, save: saveState }
	};
}
