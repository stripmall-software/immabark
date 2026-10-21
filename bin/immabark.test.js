import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { run } from './immabark.mjs';

const binPath = join(dirname(fileURLToPath(import.meta.url)), 'immabark.mjs');

function makeStub(result = { ok: true, ts: '1.000000', channel: 'C0AAA' }) {
	const recorded = { factory: null, calls: [] };
	const createAlerts = (opts) => {
		recorded.factory = opts;
		return {
			postAlert: async (args) => {
				recorded.calls.push(['postAlert', args]);
				if (result instanceof Error) throw result;
				return result;
			},
			clearChannel: async (channel) => {
				recorded.calls.push(['clearChannel', channel]);
				return { count: 1, deleted: 2 };
			},
			getStatus: async (channel) => {
				recorded.calls.push(['getStatus', channel]);
				return channel ? { alertCount: 3 } : { pending: 0 };
			}
		};
	};
	return { recorded, createAlerts };
}

const env = { SLACK_BOT_TOKEN: 'xoxb-cli-test' };

describe('immabark CLI', () => {
	it('post maps flags to postAlert and prints the JSON result', async () => {
		const { recorded, createAlerts } = makeStub();
		const result = await run(
			[
				'post',
				'--channel',
				'#ops',
				'--text',
				'disk full',
				'--blocks',
				'ctx line',
				'--threshold',
				'5/hr',
				'--thread-replies'
			],
			{ env, createAlerts }
		);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.out)).toEqual({ ok: true, ts: '1.000000', channel: 'C0AAA' });
		expect(recorded.factory.token).toBe('xoxb-cli-test');
		expect(recorded.factory.stateDir).toBe('.immabark');
		expect(recorded.calls[0]).toEqual([
			'postAlert',
			{
				channel: '#ops',
				message: 'disk full',
				blocks: 'ctx line',
				options: { threadReplies: true, threshold: '5/hr' }
			}
		]);
	});

	it('parses --blocks as Block Kit JSON when it looks like JSON', async () => {
		const { recorded, createAlerts } = makeStub();
		await run(['post', '--channel', 'C0AAA', '--text', 'x', '--blocks', '[{"type":"divider"}]'], {
			env,
			createAlerts
		});
		expect(recorded.calls[0][1].blocks).toEqual([{ type: 'divider' }]);
	});

	it('honors IMMABARK_STATE_DIR and --scan-limit', async () => {
		const { recorded, createAlerts } = makeStub();
		await run(['post', '--channel', 'C0AAA', '--text', 'x', '--scan-limit', '50'], {
			env: { ...env, IMMABARK_STATE_DIR: '/tmp/somewhere' },
			createAlerts
		});
		expect(recorded.factory.stateDir).toBe('/tmp/somewhere');
		expect(recorded.factory.scanLimit).toBe(50);
	});

	it('post - parses the v1 webhook payload from stdin', async () => {
		const { recorded, createAlerts } = makeStub();
		const stdinText = JSON.stringify({
			channel: '#ops',
			text: 'disk full',
			blocks: 'ctx',
			options: { threadReplies: true, threshold: '5/hr' }
		});
		const result = await run(['post', '-'], { env, createAlerts, stdinText });

		expect(result.code).toBe(0);
		expect(recorded.calls[0]).toEqual([
			'postAlert',
			{
				channel: '#ops',
				message: 'disk full',
				blocks: 'ctx',
				options: { threadReplies: true, threshold: '5/hr' }
			}
		]);
	});

	it('missing token is an actionable error without a stack trace', async () => {
		const { createAlerts } = makeStub();
		const result = await run(['post', '--channel', 'C0AAA', '--text', 'x'], {
			env: {},
			createAlerts
		});
		expect(result.code).toBe(1);
		const parsed = JSON.parse(result.err);
		expect(parsed.ok).toBe(false);
		expect(parsed.error).toMatch(/SLACK_BOT_TOKEN/);
		expect(parsed.error).toMatch(/slack-app-manifest\.yaml/);
		expect(result.err).not.toMatch(/\n\s+at /);
	});

	it('rejects missing --channel/--text and malformed stdin JSON', async () => {
		const { createAlerts } = makeStub();

		const noText = await run(['post', '--channel', 'C0AAA'], { env, createAlerts });
		expect(noText.code).toBe(1);
		expect(JSON.parse(noText.err).error).toMatch(/--text/);

		const badStdin = await run(['post', '-'], { env, createAlerts, stdinText: 'not json' });
		expect(badStdin.code).toBe(1);
		expect(JSON.parse(badStdin.err).ok).toBe(false);
	});

	it('surfaces engine errors as {ok:false,error} with exit 1', async () => {
		const { createAlerts } = makeStub(new Error('Slack error: invalid_auth'));
		const result = await run(['post', '--channel', 'C0AAA', '--text', 'x'], { env, createAlerts });
		expect(result.code).toBe(1);
		expect(JSON.parse(result.err)).toEqual({ ok: false, error: 'Slack error: invalid_auth' });
	});

	it('clear and status map to the engine', async () => {
		const { recorded, createAlerts } = makeStub();
		const clear = await run(['clear', '--channel', '#ops'], { env, createAlerts });
		expect(JSON.parse(clear.out)).toEqual({ count: 1, deleted: 2 });

		const status = await run(['status', '--channel', '#ops'], { env, createAlerts });
		expect(JSON.parse(status.out)).toEqual({ alertCount: 3 });

		const bare = await run(['status'], { env, createAlerts });
		expect(JSON.parse(bare.out)).toEqual({ pending: 0 });
		expect(recorded.calls.map(([name]) => name)).toEqual([
			'clearChannel',
			'getStatus',
			'getStatus'
		]);
	});

	it('help prints usage with code 0; unknown commands get usage with code 1', async () => {
		const { createAlerts } = makeStub();
		const help = await run(['help'], { env, createAlerts });
		expect(help.code).toBe(0);
		expect(help.out).toMatch(/immabark post/);

		const unknown = await run(['bark'], { env, createAlerts });
		expect(unknown.code).toBe(1);
		expect(unknown.err).toMatch(/immabark post/);
	});

	it('runs as an executable (smoke)', async () => {
		const { stdout } = await promisify(execFile)('node', [binPath, 'help']);
		expect(stdout).toMatch(/immabark post/);
	});
});
