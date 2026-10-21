import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackAlerts } from './slack-alerts.js';

let stateDir;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), 'immabark-test-'));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

const makeAlerts = (opts = {}) => createSlackAlerts({ token: 'xoxb-test', stateDir, ...opts });

// Canned Slack Web API: records calls, keeps per-channel message stores that
// chat.postMessage/update/delete mutate and conversations.history serves.
function createFakeSlack() {
	const calls = [];
	const state = {
		nextTs: 1,
		respond: {}, // endpoint -> response | (body) => response | {http: 429, retryAfter}
		channels: [
			{ id: 'C0AAA', name: 'ops' },
			{ id: 'C0BBB', name: 'dev' }
		],
		messages: {}, // channelId -> [{ts, text, blocks, metadata, bot_id, replies: []}] newest last
		botId: 'B0IMMA'
	};

	const channelMessages = (id) => (state.messages[id] ??= []);
	const findMessage = (id, ts) => channelMessages(id).find((m) => m.ts === ts);

	const handlers = {
		'auth.test': () => ({ ok: true, bot_id: state.botId, user_id: 'U0IMMA' }),
		'conversations.list': (body) => {
			const page = body.cursor ? 1 : 0;
			const channel = state.channels[page];
			return {
				ok: true,
				channels: channel ? [channel] : [],
				response_metadata: { next_cursor: page === 0 && state.channels[1] ? 'page2' : '' }
			};
		},
		'chat.postMessage': (body) => {
			const ts = `${state.nextTs++}.000000`;
			const msg = {
				ts,
				text: body.text,
				blocks: body.blocks,
				metadata: body.metadata,
				bot_id: state.botId,
				replies: []
			};
			if (body.thread_ts) {
				const parent = findMessage(body.channel, body.thread_ts);
				if (!parent) return { ok: false, error: 'thread_not_found' };
				parent.replies.push(msg);
			} else {
				channelMessages(body.channel).push(msg);
			}
			return { ok: true, channel: body.channel, ts };
		},
		'chat.update': (body) => {
			const msg = findMessage(body.channel, body.ts);
			if (!msg) return { ok: false, error: 'message_not_found' };
			Object.assign(msg, { text: body.text, blocks: body.blocks });
			if (body.metadata) msg.metadata = body.metadata;
			return { ok: true, channel: body.channel, ts: body.ts };
		},
		'chat.delete': (body) => {
			const list = channelMessages(body.channel);
			const i = list.findIndex((m) => m.ts === body.ts);
			if (i >= 0) {
				list.splice(i, 1);
				return { ok: true };
			}
			for (const m of list) {
				const j = m.replies.findIndex((r) => r.ts === body.ts);
				if (j >= 0) {
					m.replies.splice(j, 1);
					return { ok: true };
				}
			}
			return { ok: false, error: 'message_not_found' };
		},
		'conversations.history': (body) => {
			const list = channelMessages(body.channel);
			if (body.latest && body.oldest && body.inclusive) {
				const msg = findMessage(body.channel, body.latest);
				return { ok: true, messages: msg ? [toWire(msg)] : [] };
			}
			const newestFirst = [...list].reverse();
			const start = body.cursor ? Number(body.cursor) : 0;
			const limit = Number(body.limit) || 100;
			const page = newestFirst.slice(start, start + limit);
			const nextStart = start + limit;
			return {
				ok: true,
				messages: page.map(toWire),
				response_metadata: {
					next_cursor: nextStart < newestFirst.length ? String(nextStart) : ''
				}
			};
		},
		'conversations.replies': (body) => {
			const parent = findMessage(body.channel, body.ts);
			if (!parent) return { ok: false, error: 'thread_not_found' };
			return { ok: true, messages: [toWire(parent), ...parent.replies.map(toWire)] };
		}
	};

	const toWire = ({ replies, ...msg }) => ({ ...msg });

	const fetchImpl = async (url, init) => {
		const u = new URL(url);
		const endpoint = u.pathname.replace('/api/', '');
		const body =
			init?.method === 'POST' && init.body
				? JSON.parse(init.body)
				: Object.fromEntries(u.searchParams);
		calls.push({ endpoint, body });

		let resp = state.respond[endpoint];
		if (typeof resp === 'function') resp = resp(body);
		if (resp?.http) {
			return {
				ok: false,
				status: resp.http,
				headers: new Headers({ 'Retry-After': String(resp.retryAfter ?? 1) }),
				json: async () => ({ ok: false, error: 'rate_limited' })
			};
		}
		resp ??= handlers[endpoint]?.(body) ?? { ok: false, error: `unhandled_${endpoint}` };
		return { ok: true, status: 200, headers: new Headers(), json: async () => resp };
	};

	return { calls, state, fetchImpl };
}

describe('parseThreshold', () => {
	it('parses count and window for each unit', () => {
		const alerts = makeAlerts();
		expect(alerts.parseThreshold('5/hr')).toEqual({ count: 5, ms: 60 * 60 * 1000 });
		expect(alerts.parseThreshold('10/min')).toEqual({ count: 10, ms: 60 * 1000 });
		expect(alerts.parseThreshold('1/day')).toEqual({ count: 1, ms: 24 * 60 * 60 * 1000 });
		expect(alerts.parseThreshold('3/minute')).toEqual({ count: 3, ms: 60 * 1000 });
		expect(alerts.parseThreshold('2/hour')).toEqual({ count: 2, ms: 60 * 60 * 1000 });
	});

	it('returns null for invalid or missing thresholds', () => {
		const alerts = makeAlerts();
		expect(alerts.parseThreshold('5/week')).toBeNull();
		expect(alerts.parseThreshold('lots')).toBeNull();
		expect(alerts.parseThreshold(null)).toBeNull();
		expect(alerts.parseThreshold(undefined)).toBeNull();
	});
});

describe('hashMessage', () => {
	it('is a deterministic 64-char hex digest', async () => {
		const alerts = makeAlerts();
		const a = await alerts.hashMessage('C0AAA', 'disk full');
		const b = await alerts.hashMessage('C0AAA', 'disk full');
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it('changes when the channel or message changes', async () => {
		const alerts = makeAlerts();
		const base = await alerts.hashMessage('C0AAA', 'disk full');
		expect(await alerts.hashMessage('C0BBB', 'disk full')).not.toBe(base);
		expect(await alerts.hashMessage('C0AAA', 'disk almost full')).not.toBe(base);
	});
});

describe('resolveChannel', () => {
	it('passes channel IDs through without any API call', async () => {
		const slack = createFakeSlack();
		const alerts = makeAlerts({ fetchImpl: slack.fetchImpl });
		expect(await alerts.resolveChannel('C0123ABCDEF')).toBe('C0123ABCDEF');
		expect(slack.calls).toHaveLength(0);
	});

	it('resolves #name via conversations.list and caches the answer', async () => {
		const slack = createFakeSlack();
		const alerts = makeAlerts({ fetchImpl: slack.fetchImpl });

		expect(await alerts.resolveChannel('#ops')).toBe('C0AAA');
		expect(slack.calls.filter((c) => c.endpoint === 'conversations.list')).toHaveLength(1);

		expect(await alerts.resolveChannel('ops')).toBe('C0AAA');
		expect(slack.calls.filter((c) => c.endpoint === 'conversations.list')).toHaveLength(1);
	});

	it('follows pagination cursors', async () => {
		const slack = createFakeSlack();
		const alerts = makeAlerts({ fetchImpl: slack.fetchImpl });
		expect(await alerts.resolveChannel('dev')).toBe('C0BBB');
		expect(slack.calls.filter((c) => c.endpoint === 'conversations.list')).toHaveLength(2);
	});

	it('throws a clear error for unknown channels', async () => {
		const slack = createFakeSlack();
		const alerts = makeAlerts({ fetchImpl: slack.fetchImpl });
		await expect(alerts.resolveChannel('#nope')).rejects.toThrow(/nope.*conversations\.list/s);
	});

	it('surfaces the Slack error code on API failures', async () => {
		const slack = createFakeSlack();
		slack.state.respond['conversations.list'] = { ok: false, error: 'invalid_auth' };
		const alerts = makeAlerts({ fetchImpl: slack.fetchImpl });
		await expect(alerts.resolveChannel('#ops')).rejects.toThrow(/invalid_auth/);
	});
});

async function seedAlertMessage(
	slack,
	alerts,
	channelId,
	{ count, first_seen, last_seen, payload, message = 'disk full' }
) {
	const hash = await alerts.hashMessage(channelId, message);
	const ts = `${slack.state.nextTs++}.000000`;
	(slack.state.messages[channelId] ??= []).push({
		ts,
		text: message,
		blocks: [{ type: 'section', text: { type: 'mrkdwn', text: message } }],
		metadata: {
			event_type: 'immabark_alert',
			event_payload: payload ?? { hash, first_seen, last_seen, count }
		},
		bot_id: slack.state.botId,
		replies: []
	});
	return { hash, ts };
}

describe('postAlert (dedup via metadata)', () => {
	let slack;
	let alerts;

	beforeEach(() => {
		slack = createFakeSlack();
		alerts = makeAlerts({ fetchImpl: slack.fetchImpl });
	});

	const post = (overrides = {}) =>
		alerts.postAlert({ channel: 'C0AAA', message: 'disk full', ...overrides });

	const seedAlert = (channelId, opts) => seedAlertMessage(slack, alerts, channelId, opts);

	it('posts a first alert with immabark metadata', async () => {
		const result = await post();

		expect(result).toEqual({ ok: true, ts: expect.any(String), channel: 'C0AAA' });
		const sent = slack.calls.find((c) => c.endpoint === 'chat.postMessage');
		expect(sent.body.metadata.event_type).toBe('immabark_alert');
		expect(sent.body.metadata.event_payload).toEqual({
			hash: expect.stringMatching(/^[0-9a-f]{64}$/),
			first_seen: expect.any(String),
			last_seen: expect.any(String),
			count: 1
		});
		expect(sent.body.blocks.at(-1).elements[0].text).toMatch(/^First seen:/);
	});

	it('updates in place on a duplicate found via the local cache', async () => {
		await post();
		const firstPayload = slack.calls.find((c) => c.endpoint === 'chat.postMessage').body.metadata
			.event_payload;
		slack.calls.length = 0;

		const result = await post();

		expect(result.ok).toBe(true);
		expect(slack.calls.map((c) => c.endpoint)).toEqual(['conversations.history', 'chat.update']);
		const history = slack.calls[0].body;
		expect(history.latest).toBe(result.ts);
		expect(history.oldest).toBe(result.ts);
		const update = slack.calls[1].body;
		expect(update.blocks.at(-1).elements[0].text).toContain('Count: 2');
		expect(update.metadata.event_payload.count).toBe(2);
		expect(update.metadata.event_payload.first_seen).toBe(firstPayload.first_seen);
	});

	it('finds a duplicate via channel scan when the cache is cold (cross-producer)', async () => {
		await post();
		slack.calls.length = 0;

		const otherDir = mkdtempSync(join(tmpdir(), 'immabark-producer2-'));
		try {
			const producer2 = createSlackAlerts({
				token: 'xoxb-test',
				stateDir: otherDir,
				fetchImpl: slack.fetchImpl
			});
			const result = await producer2.postAlert({ channel: 'C0AAA', message: 'disk full' });

			expect(result.ok).toBe(true);
			const scan = slack.calls.find((c) => c.endpoint === 'conversations.history');
			expect(scan.body.latest).toBeUndefined();
			expect(scan.body.include_all_metadata).toBe('true');
			const update = slack.calls.find((c) => c.endpoint === 'chat.update');
			expect(update.body.metadata.event_payload.count).toBe(2);
		} finally {
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	it('takes count and first_seen from metadata, not local state', async () => {
		await seedAlert('C0AAA', {
			count: 7,
			first_seen: '2026-01-01T00:00:00.000Z',
			last_seen: '2026-01-01T00:00:00.000Z'
		});

		await post();

		const update = slack.calls.find((c) => c.endpoint === 'chat.update');
		expect(update.body.metadata.event_payload.count).toBe(8);
		expect(update.body.metadata.event_payload.first_seen).toBe('2026-01-01T00:00:00.000Z');
		expect(update.body.blocks.at(-1).elements[0].text).toContain('Count: 8');
	});

	it('tolerates malformed foreign metadata', async () => {
		const hash = await alerts.hashMessage('C0AAA', 'disk full');
		await seedAlert('C0AAA', { payload: { hash } });

		const result = await post();

		expect(result.ok).toBe(true);
		const update = slack.calls.find((c) => c.endpoint === 'chat.update');
		expect(update.body.metadata.event_payload.count).toBe(1);
	});

	it('falls through to a fresh post when the update races a deletion', async () => {
		const first = await post();
		slack.state.respond['chat.update'] = () => {
			delete slack.state.respond['chat.update'];
			return { ok: false, error: 'message_not_found' };
		};

		const result = await post();

		expect(result.ok).toBe(true);
		expect(result.ts).not.toBe(first.ts);
		const fresh = slack.calls.filter((c) => c.endpoint === 'chat.postMessage');
		expect(fresh).toHaveLength(2);
		expect(fresh[1].body.metadata.event_payload.count).toBe(1);
	});

	it('posts fresh when the duplicate is beyond the scan bound', async () => {
		const bounded = makeAlerts({ fetchImpl: slack.fetchImpl, scanLimit: 2 });
		await seedAlert('C0AAA', {
			count: 3,
			first_seen: '2026-01-01T00:00:00.000Z',
			last_seen: '2026-01-01T00:00:00.000Z'
		});
		for (const ts of ['90.000000', '91.000000', '92.000000']) {
			slack.state.messages.C0AAA.push({ ts, text: 'chatter', replies: [] });
		}

		const result = await bounded.postAlert({ channel: 'C0AAA', message: 'disk full' });

		expect(result.ok).toBe(true);
		expect(slack.calls.filter((c) => c.endpoint === 'conversations.history')).toHaveLength(1);
		expect(slack.calls.find((c) => c.endpoint === 'conversations.history').body.limit).toBe('2');
		expect(slack.calls.find((c) => c.endpoint === 'chat.postMessage')).toBeDefined();
	});

	it('explains not_in_channel errors', async () => {
		slack.state.respond['conversations.history'] = { ok: false, error: 'not_in_channel' };
		await expect(post()).rejects.toThrow(/\/invite @immabark/);
	});

	it('accepts blocks as a string or Block Kit array', async () => {
		await post({ blocks: 'Connection timeout after 30s' });
		const sent = slack.calls.find((c) => c.endpoint === 'chat.postMessage');
		expect(sent.body.blocks[1]).toEqual({
			type: 'context',
			elements: [{ type: 'mrkdwn', text: 'Connection timeout after 30s' }]
		});

		slack.calls.length = 0;
		const kit = [{ type: 'divider' }];
		await post({ message: 'other alert', blocks: kit });
		const sent2 = slack.calls.find((c) => c.endpoint === 'chat.postMessage');
		expect(sent2.body.blocks[1]).toEqual({ type: 'divider' });
	});

	it('threadReplies posts a reply and bumps parent metadata without touching its blocks', async () => {
		const first = await post();
		const parentBlocks = structuredClone(slack.state.messages.C0AAA[0].blocks);
		slack.calls.length = 0;

		const result = await post({ options: { threadReplies: true } });

		expect(result.ok).toBe(true);
		const reply = slack.calls.find((c) => c.endpoint === 'chat.postMessage');
		expect(reply.body.thread_ts).toBe(first.ts);
		const update = slack.calls.find((c) => c.endpoint === 'chat.update');
		expect(update.body.metadata.event_payload.count).toBe(2);
		expect(slack.state.messages.C0AAA[0].blocks).toEqual(parentBlocks);
	});
});

describe('postAlert thresholds (shared window clock)', () => {
	let slack;
	let clock;
	let alerts;

	beforeEach(() => {
		slack = createFakeSlack();
		clock = { t: Date.parse('2026-01-02T12:00:00Z') };
		alerts = makeAlerts({ fetchImpl: slack.fetchImpl, now: () => clock.t });
	});

	const post = (overrides = {}) =>
		alerts.postAlert({ channel: 'C0AAA', message: 'disk full', ...overrides });

	it('suppresses below the threshold before any message exists, then posts with the backlog', async () => {
		const options = { threshold: '2/hr' };

		expect(await post({ options })).toMatchObject({ suppressed: true, count: 1 });
		expect(await post({ options })).toMatchObject({ suppressed: true, count: 2 });
		expect(slack.calls.filter((c) => c.endpoint === 'chat.postMessage')).toHaveLength(0);
		expect(slack.calls.filter((c) => c.endpoint === 'chat.update')).toHaveLength(0);

		const result = await post({ options });
		expect(result.ok).toBe(true);
		const sent = slack.calls.find((c) => c.endpoint === 'chat.postMessage');
		expect(sent.body.metadata.event_payload.count).toBe(3);
		expect(sent.body.blocks.at(-1).elements[0].text).toContain('Count: 3');
	});

	it('resets the local counter after a quiet window', async () => {
		const options = { threshold: '2/hr' };
		await post({ options });
		clock.t += 2 * 60 * 60 * 1000;
		expect(await post({ options })).toMatchObject({ suppressed: true, count: 1 });
	});

	it('bumps shared metadata on a suppressed hit against an existing message', async () => {
		await post();
		const original = structuredClone(slack.state.messages.C0AAA[0]);
		slack.calls.length = 0;

		const result = await post({ options: { threshold: '3/hr' } });

		expect(result).toMatchObject({ suppressed: true, count: 2 });
		const update = slack.calls.find((c) => c.endpoint === 'chat.update');
		expect(update.body.blocks).toEqual(original.blocks);
		expect(update.body.text).toBe(original.text);
		expect(update.body.metadata.event_payload.count).toBe(2);
		expect(update.body.metadata.event_payload.first_seen).toBe(
			original.metadata.event_payload.first_seen
		);
	});

	it("exposes another producer's suppressed hits through the channel", async () => {
		await post();
		await post({ options: { threshold: '3/hr' } }); // suppressed, metadata count 2

		const otherDir = mkdtempSync(join(tmpdir(), 'immabark-producer2-'));
		try {
			const producer2 = createSlackAlerts({
				token: 'xoxb-test',
				stateDir: otherDir,
				fetchImpl: slack.fetchImpl,
				now: () => clock.t
			});
			slack.calls.length = 0;
			await producer2.postAlert({ channel: 'C0AAA', message: 'disk full' });

			const update = slack.calls.find((c) => c.endpoint === 'chat.update');
			expect(update.body.metadata.event_payload.count).toBe(3);
			expect(update.body.blocks.at(-1).elements[0].text).toContain('Count: 3');
		} finally {
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	it('a quiet window resets the shared count and first_seen', async () => {
		const seeded = {
			count: 9,
			first_seen: new Date(clock.t - 3 * 60 * 60 * 1000).toISOString(),
			last_seen: new Date(clock.t - 2 * 60 * 60 * 1000).toISOString()
		};
		await seedAlertMessage(slack, alerts, 'C0AAA', seeded);
		const options = { threshold: '2/hr' };

		expect(await post({ options })).toMatchObject({ suppressed: true, count: 1 });
		expect(await post({ options })).toMatchObject({ suppressed: true, count: 2 });
		const result = await post({ options });

		expect(result.ok).toBe(true);
		const lastUpdate = slack.calls.filter((c) => c.endpoint === 'chat.update').at(-1);
		expect(lastUpdate.body.metadata.event_payload.count).toBe(3);
		expect(lastUpdate.body.metadata.event_payload.first_seen).not.toBe(seeded.first_seen);
		expect(lastUpdate.body.blocks.at(-1).elements[0].text).toContain('Count: 3');
	});

	it('does not double-count the backlog when a crossing follows a rate-limited bump', async () => {
		await post(); // count 1
		slack.state.respond['chat.update'] = () => {
			delete slack.state.respond['chat.update'];
			return { http: 429, retryAfter: 1 };
		};
		const options = { threshold: '2/hr' };

		expect(await post({ options })).toMatchObject({ suppressed: true, count: 2 }); // 429 → pending 1
		const result = await post({ options }); // 3rd occurrence crosses 2/hr

		expect(result.ok).toBe(true);
		const update = slack.calls.filter((c) => c.endpoint === 'chat.update').at(-1);
		expect(update.body.metadata.event_payload.count).toBe(3);
		expect(update.body.blocks.at(-1).elements[0].text).toContain('Count: 3');
	});

	it('a plain post folds the suppressed backlog into a fresh message', async () => {
		const options = { threshold: '5/hr' };
		await post({ options }); // suppressed, pending 1
		await post({ options }); // suppressed, pending 2

		const result = await post(); // same alert, no threshold

		expect(result.ok).toBe(true);
		const sent = slack.calls.find((c) => c.endpoint === 'chat.postMessage');
		expect(sent.body.metadata.event_payload.count).toBe(3);
		expect(sent.body.blocks.at(-1).elements[0].text).toContain('Count: 3');
	});

	it('falls through to a fresh post when another app owns the found message', async () => {
		await seedAlertMessage(slack, alerts, 'C0AAA', {
			count: 4,
			first_seen: new Date(clock.t).toISOString(),
			last_seen: new Date(clock.t).toISOString()
		});
		slack.state.respond['chat.update'] = { ok: false, error: 'cant_update_message' };

		const result = await post();

		expect(result.ok).toBe(true);
		const sent = slack.calls.find((c) => c.endpoint === 'chat.postMessage');
		expect(sent).toBeDefined();
		expect(sent.body.metadata.event_payload.count).toBe(1);
	});

	it("keeps the pending backlog when a suppressed bump hits another app's message", async () => {
		await post(); // our message, count 1
		slack.state.respond['chat.update'] = () => {
			delete slack.state.respond['chat.update'];
			return { ok: false, error: 'cant_update_message' };
		};
		const options = { threshold: '5/hr' };

		expect(await post({ options })).toMatchObject({ suppressed: true, count: 2 });

		slack.calls.length = 0;
		expect(await post({ options })).toMatchObject({ suppressed: true, count: 3 });
		const update = slack.calls.find((c) => c.endpoint === 'chat.update');
		expect(update.body.metadata.event_payload.count).toBe(3);
	});

	it('rejects an invalid threshold instead of silently ignoring it', async () => {
		await expect(post({ options: { threshold: '5/week' } })).rejects.toThrow(
			/5\/week.*(min|hr|day)/s
		);
		expect(slack.calls.filter((c) => c.endpoint === 'chat.postMessage')).toHaveLength(0);
	});

	it('keeps a rate-limited metadata bump locally and folds it into the next write', async () => {
		await post();
		slack.state.respond['chat.update'] = () => {
			delete slack.state.respond['chat.update'];
			return { http: 429, retryAfter: 1 };
		};
		const options = { threshold: '5/hr' };

		expect(await post({ options })).toMatchObject({ suppressed: true, count: 2 });

		slack.calls.length = 0;
		expect(await post({ options })).toMatchObject({ suppressed: true, count: 3 });
		const update = slack.calls.find((c) => c.endpoint === 'chat.update');
		expect(update.body.metadata.event_payload.count).toBe(3);
	});
});

describe('clearChannel and getStatus', () => {
	let slack;
	let alerts;

	beforeEach(() => {
		slack = createFakeSlack();
		alerts = makeAlerts({ fetchImpl: slack.fetchImpl });
	});

	it('clearChannel deletes alerts and replies across history pages', async () => {
		await seedAlertMessage(slack, alerts, 'C0AAA', { count: 1, message: 'alert one' });
		const second = await seedAlertMessage(slack, alerts, 'C0AAA', {
			count: 2,
			message: 'alert two'
		});
		const parent = slack.state.messages.C0AAA.find((m) => m.ts === second.ts);
		parent.replies.push({ ts: '50.000000', text: 'r1' }, { ts: '51.000000', text: 'r2' });
		await seedAlertMessage(slack, alerts, 'C0AAA', { count: 1, message: 'alert three' });
		slack.state.messages.C0AAA.push({ ts: '60.000000', text: 'human chatter', replies: [] });
		slack.state.messages.C0AAA.push({ ts: '61.000000', text: 'more chatter', replies: [] });

		// Force pagination: serve history in pages of 3.
		slack.state.respond['conversations.history'] = (body) => {
			if (body.latest) return undefined; // single-message fetches use the default handler
			const newestFirst = [...(slack.state.messages[body.channel] ?? [])].reverse();
			const start = body.cursor ? Number(body.cursor) : 0;
			const page = newestFirst.slice(start, start + 3).map(({ replies, ...m }) => ({ ...m }));
			return {
				ok: true,
				messages: page,
				response_metadata: {
					next_cursor: start + 3 < newestFirst.length ? String(start + 3) : ''
				}
			};
		};

		const result = await alerts.clearChannel('C0AAA');

		expect(result).toEqual({ count: 3, deleted: 5 });
		expect(
			slack.calls.filter((c) => c.endpoint === 'conversations.history').length
		).toBeGreaterThan(1);
		expect(slack.state.messages.C0AAA.map((m) => m.text)).toEqual([
			'human chatter',
			'more chatter'
		]);
	});

	it("clearChannel ignores other bots' immabark-shaped messages and drops state entries", async () => {
		await alerts.postAlert({ channel: 'C0AAA', message: 'mine' });
		const foreign = await seedAlertMessage(slack, alerts, 'C0AAA', { count: 1, message: 'theirs' });
		slack.state.messages.C0AAA.find((m) => m.ts === foreign.ts).bot_id = 'B0OTHER';

		const result = await alerts.clearChannel('C0AAA');

		expect(result.count).toBe(1);
		expect(slack.state.messages.C0AAA.map((m) => m.text)).toEqual(['theirs']);
		expect(Object.keys(alerts._state.load().alerts)).toEqual([]);
	});

	it('getStatus counts channel alerts via scan; bare getStatus reads only local state', async () => {
		await alerts.postAlert({ channel: 'C0AAA', message: 'a' });
		await alerts.postAlert({ channel: 'C0AAA', message: 'b' });
		await alerts.postAlert({
			channel: 'C0AAA',
			message: 'quiet',
			options: { threshold: '5/hr' }
		});

		expect(await alerts.getStatus('C0AAA')).toEqual({ alertCount: 2 });

		slack.calls.length = 0;
		expect(await alerts.getStatus()).toEqual({ pending: 1 });
		expect(slack.calls).toHaveLength(0);
	});
});

describe('scratchpad state', () => {
	it('round-trips through an atomic save', () => {
		const alerts = makeAlerts();
		const state = alerts._state.load();
		state.channels.ops = 'C0AAA';
		state.alerts['C0AAA|abc'] = { pending: 2, updatedAt: new Date().toISOString() };
		alerts._state.save(state);

		expect(existsSync(join(stateDir, 'state.json'))).toBe(true);
		expect(existsSync(join(stateDir, 'state.json.tmp'))).toBe(false);
		const reloaded = makeAlerts()._state.load();
		expect(reloaded.channels.ops).toBe('C0AAA');
		expect(reloaded.alerts['C0AAA|abc'].pending).toBe(2);
	});

	it('ignores a malformed state file (disposable scratchpad)', () => {
		writeFileSync(join(stateDir, 'state.json'), 'not json');
		const state = makeAlerts()._state.load();
		expect(state).toEqual({ channels: {}, alerts: {} });
	});

	it('creates the state dir on demand', () => {
		const nested = join(stateDir, 'does', 'not', 'exist');
		const alerts = makeAlerts({ stateDir: nested });
		alerts._state.save(alerts._state.load());
		expect(existsSync(join(nested, 'state.json'))).toBe(true);
	});

	it('prunes alert entries older than 24h on save', () => {
		const t0 = Date.parse('2026-01-02T12:00:00Z');
		const alerts = makeAlerts({ now: () => t0 });
		const state = alerts._state.load();
		state.alerts['C0AAA|old'] = {
			pending: 1,
			updatedAt: new Date(t0 - 25 * 60 * 60 * 1000).toISOString()
		};
		state.alerts['C0AAA|fresh'] = {
			pending: 1,
			updatedAt: new Date(t0 - 60 * 1000).toISOString()
		};
		alerts._state.save(state);

		const reloaded = alerts._state.load();
		expect(reloaded.alerts['C0AAA|old']).toBeUndefined();
		expect(reloaded.alerts['C0AAA|fresh']).toBeDefined();
	});
});
