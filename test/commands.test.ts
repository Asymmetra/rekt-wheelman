// Every CLI command, through the real argument parser, configuration, risk guard and envelope.
// Only the connection is fake (test/helpers.ts); nothing here touches a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { AccountInfo } from '@solana/web3.js';
import { traderPda } from '@rekt-trading/1000x';
import { USDC_MINT } from '../src/account.ts';
import { execute, parseArgs, text } from '../src/cli.ts';
import { ata } from '../src/client.ts';
import { makeCtx, type Ctx } from '../src/commands.ts';
import { replay } from '../src/prices.ts';
import { fakeHandles, fakeRpc, keypairFile, tempDir, tokenAccount } from './helpers.ts';

const dir = tempDir('commands-');
const owner = keypairFile(dir, 'owner-keypair.json');
const funded = new Map<string, AccountInfo<Buffer>>([
  [ata(owner.key.publicKey, USDC_MINT).toBase58(), tokenAccount(50_000_000n)],
  [owner.key.publicKey.toBase58(), { ...tokenAccount(0n), lamports: 1_000_000_000 }],
]);

async function ctxWith(env: Record<string, string>, o: { accounts?: Map<string, AccountInfo<Buffer>>; agent?: boolean; calls?: string[]; simulate?: { err: unknown; unitsConsumed: number } } = {}): Promise<Ctx> {
  const ctx = await makeCtx({ RPC_URL: 'https://rpc.example.com', STATE_DIR: tempDir('state-'), DAILY_LOSS_USDC: '5', ...env }, o.agent ?? false);
  const rpc = fakeRpc(o.accounts, o.simulate);
  ctx.connect = async (cfg, game, signer) => fakeHandles(cfg, game, signer, rpc, o.calls);
  let price = 100;
  ctx.prices = { ...replay('test/fixtures/tape.jsonl'), latest: async (market) => ({ market, price: (price += 0.01), time: Date.now() }) };
  return ctx;
}
const run = (ctx: Ctx, ...argv: string[]) => execute(parseArgs(argv), ctx, new AbortController().signal);
const data = (e: Awaited<ReturnType<typeof run>>) => {
  assert.ok(e.ok, JSON.stringify(e));
  return e.data as Record<string, any>;
};
const error = (e: Awaited<ReturnType<typeof run>>) => {
  assert.ok(!e.ok, JSON.stringify(e));
  return e.error;
};

test('markets: facts per market, money as USDC text, no side room where no limit is set', async () => {
  const calls: string[] = [];
  const d = data(await run(await ctxWith({}, { calls }), 'markets')) as unknown as Record<string, any>[];
  assert.equal(d.length, 5);
  assert.deepEqual(d[0]!.stake, { min: '0.200000', max: '1000.000000' });
  assert.deepEqual(d[0]!.sideRoom, { long: null, short: '5.000000' });
  assert.deepEqual(calls, ['market BTC', 'market ETH', 'market SOL', 'market XRP', 'market XAU']);
});

test('preview: a Knockout position or a Minute round; bad arguments are refused by name', async () => {
  const ctx = await ctxWith({});
  assert.equal(data(await run(ctx, 'preview', 'BTC', 'long', '1', '--target', '2')).payoutAtTarget, '1.824000');
  assert.equal(data(await run(ctx, 'preview', 'btc', 'short', '1', '--minute')).total, '1.000000');
  assert.deepEqual(error(await run(ctx, 'preview', 'BTC', 'up', '1')), { category: 'config', code: 'BAD_ARGUMENT', message: 'side must be long or short', retryable: false });
  assert.equal(error(await run(ctx, 'preview', 'DOGE', 'long', '1')).code, 'BAD_ARGUMENT');
  assert.equal(error(await run(ctx, 'preview', 'BTC', 'long', 'lots')).code, 'BAD_ARGUMENT');
});

test('positions: the wallet\'s positions, rounds, balances and today\'s result', async () => {
  const d = data(await run(await ctxWith({ OWNER: owner.key.publicKey.toBase58() }, { accounts: funded }), 'positions'));
  assert.equal(d.balances.usdc, '50.000000');
  assert.deepEqual([d.positions, d.rounds, d.today], [[], [], '0.000000']);
  assert.match(error(await run(await ctxWith({}), 'positions')).message, /OWNER/);
});

test('open: through the risk guard, then one transaction; refusals name the limit', async () => {
  const calls: string[] = [];
  const ctx = await ctxWith({ KEYPAIR_PATH: owner.path, MAX_STAKE_USDC: '2' }, { accounts: funded, calls });
  const d = data(await run(ctx, 'open', 'BTC', 'long', '1.5', '--target', '2', '--timer', '60'));
  assert.deepEqual(d, { what: 'open', signature: 'signature-open', seqs: ['7'] });
  assert.match(calls.at(-1)!, /"usd":"1500000","target":2,"timer":60/);
  // The stake limit, the wallet's balance, the loss stop: each refusal is category risk, not retryable.
  const over = error(await run(ctx, 'open', 'BTC', 'long', '3'));
  assert.deepEqual([over.category, over.code, over.retryable], ['risk', 'RISK_LIMIT', false]);
  assert.match(over.message, /MAX_STAKE_USDC/);
  assert.match(error(await run(await ctxWith({ KEYPAIR_PATH: owner.path }), 'open', 'BTC', 'long', '1')).message, /the wallet holds \$0/);
  assert.match(error(await run(await ctxWith({ KEYPAIR_PATH: owner.path, DAILY_LOSS_USDC: '' }), 'open', 'BTC', 'long', '1')).message, /DAILY_LOSS_USDC is required/);
  assert.match(error(await run(await ctxWith({}), 'open', 'BTC', 'long', '1')).message, /KEYPAIR_PATH/);
});

test('open --minute opens a round; --dry-run simulates and sends nothing', async () => {
  const calls: string[] = [];
  const ctx = await ctxWith({ KEYPAIR_PATH: owner.path }, { accounts: funded, calls });
  assert.deepEqual(data(await run(ctx, 'open', 'BTC', 'short', '1', '--minute')), { what: 'round', seq: '9', signature: 'signature-round' });
  const dry = await ctxWith({ OWNER: owner.key.publicKey.toBase58() }, { accounts: funded, calls });
  assert.deepEqual(data(await run(dry, 'open', 'BTC', 'long', '1', '--dry-run')), { dryRun: true, simulated: true, units: 1234, bytes: data(await run(dry, 'open', 'BTC', 'long', '1', '--dry-run')).bytes });
  assert.deepEqual(calls, ['round']);
});

test('a refused simulation is a venue error with the program\'s name and retry class', async () => {
  const refused = { err: { InstructionError: [2, { Custom: 6057 }] }, unitsConsumed: 900 };
  const ctx = await ctxWith({ OWNER: owner.key.publicKey.toBase58() }, { accounts: funded, simulate: refused });
  const e = error(await run(ctx, 'close', '74', '--dry-run'));
  assert.deepEqual([e.category, e.code, e.retryable], ['venue', 'PositionNotFound', false]);
});

test('paper: open, positions and close, priced by the SDK, sending nothing', async () => {
  const ctx = await ctxWith({});
  const opened = data(await run(ctx, 'open', 'BTC', 'long', '1', '--target', '2', '--paper'));
  assert.equal(opened.id, '1');
  assert.ok(opened.entryPrice > 100);
  assert.equal(data(await run(ctx, 'positions', '--paper')).positions[0].id, '1');
  const closed = data(await run(ctx, 'close', '1', '--paper'));
  assert.equal(closed.closed, true);
  assert.equal(closed.reason, 'voluntary');
  assert.match(closed.pnl, /^-?\d+\.\d{6}$/);
  assert.equal(error(await run(ctx, 'close', '1', '--paper')).code, 'NO_SUCH_POSITION');
});

test('close: one request; a bad id is refused', async () => {
  const calls: string[] = [];
  const ctx = await ctxWith({ KEYPAIR_PATH: owner.path }, { calls });
  assert.deepEqual(data(await run(ctx, 'close', '12')), { id: '12', signature: 'signature-close' });
  assert.deepEqual(calls, ['close 12']);
  assert.equal(error(await run(ctx, 'close', 'x')).code, 'BAD_ARGUMENT');
});

test('an agent trades only with a session key, never with the owner\'s key', async () => {
  const agent = await ctxWith({ KEYPAIR_PATH: owner.path }, { accounts: funded, agent: true });
  assert.equal(error(await run(agent, 'open', 'BTC', 'long', '1')).code, 'NO_SESSION');
  const session = keypairFile(dir, 'session-keypair.json');
  const calls: string[] = [];
  const withSession = await ctxWith({ SESSION_KEYPAIR_PATH: session.path, OWNER: owner.key.publicKey.toBase58() }, { accounts: funded, agent: true, calls });
  // The session key pays fees, so it needs SOL; the fake gives it none, and the guard says so.
  assert.match(error(await run(withSession, 'open', 'BTC', 'long', '1')).message, /SOL/);
  funded.set(session.key.publicKey.toBase58(), { ...tokenAccount(0n), lamports: 100_000_000 });
  assert.equal(data(await run(withSession, 'open', 'BTC', 'long', '1')).what, 'open');
});

test('session start, status and end', async () => {
  // The owner already has a book, so the authorisation needs no vault read (the fake has none).
  const withBook = new Map([...funded, [traderPda(owner.key.publicKey).address.toBase58(), tokenAccount(0n)]]);
  const ctx = await ctxWith({ OWNER: owner.key.publicKey.toBase58() }, { accounts: withBook });
  const s = data(await run(ctx, 'session', 'start', '--allowance', '20', '--expires', '24h', '--dry-run'));
  assert.deepEqual([s.allowance, s.expiresInS, s.fuelSol, s.signature, s.units], ['20.000000', 86_400, 0.01, null, 1234]);
  assert.match(error(await run(ctx, 'session', 'start', '--allowance', '20')).message, /owner's wallet/);
  assert.equal(error(await run(ctx, 'session', 'start', '--allowance', '20', '--expires', 'soon', '--dry-run')).code, 'BAD_ARGUMENT');
  assert.equal(error(await run(ctx, 'session', 'start', '--allowance', '20', '--expires', '10s', '--dry-run')).code, 'BAD_EXPIRY');
  assert.equal(data(await run(ctx, 'session', 'status')).state, 'none');
  assert.equal(error(await run(ctx, 'session', 'end', '--dry-run')).code, 'NO_SESSION');
  assert.equal(error(await run(ctx, 'session', 'pause')).code, 'BAD_ARGUMENT');
});

test('run: the bot on paper over a replay tape, and its dry run', async (t) => {
  t.mock.method(console, 'log', () => {});
  const env = { STRATEGY: 'knockout-momentum', PRICE_SOURCE: 'replay', REPLAY_FILE: 'test/fixtures/tape.jsonl', OWNER: owner.key.publicKey.toBase58() };
  const paper = data(await run(await ctxWith(env), 'run', '--paper'));
  assert.ok(paper.opened >= 1 && paper.closed >= 1);
  assert.match(paper.result, /^-?\d+\.\d{6}$/);
  const dry = data(await run(await ctxWith(env, { accounts: funded }), 'run', 'knockout-straddle', '--dry-run')) as unknown as Record<string, unknown>[];
  assert.deepEqual(dry.map((x) => [x.what, x.simulated]), [['open long and short', true], ['close (none open: a seq that does not exist)', true]]);
  assert.match(error(await run(await ctxWith({ ...env, KEYPAIR_PATH: owner.path }), 'run')).message, /replay is for paper mode/);
});

test('the parser, the text output and the unknown cases', async () => {
  assert.deepEqual(parseArgs(['open', 'BTC', '-o', 'json', '--target=2', '--paper']), { words: ['open', 'BTC'], flags: { output: 'json', target: '2', paper: true } });
  assert.throws(() => parseArgs(['--bogus']), /unknown flag --bogus/);
  assert.throws(() => parseArgs(['-o', 'yaml']), /json or text/);
  assert.equal(error(await run(await ctxWith({}), 'nope')).code, 'UNKNOWN_COMMAND');
  assert.equal(text({ a: 1, b: { c: 'x' }, d: [1, 2] }), 'a: 1\nb:\n  c: x\nd:\n  - 1\n  - 2');
});

test('the program: -o json prints exactly one envelope line, and the exit code follows ok', () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['src/cli.ts', ...args], { env: { PATH: process.env.PATH, STATE_DIR: tempDir('cli-'), ...env }, encoding: 'utf8' });
  const help = cli(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /wheelman <command>/);
  const noRpc = cli(['markets', '-o', 'json']);
  assert.equal(noRpc.status, 1);
  const lines = noRpc.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0]!)), ['ok', 'error']);
  assert.equal(JSON.parse(lines[0]!).error.category, 'config');
  const bad = cli(['--bogus']);
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error.code, 'BAD_ARGUMENT');
});
