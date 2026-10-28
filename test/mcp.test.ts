// The MCP server: the protocol, the tool list (trading tools only with a session key or on paper),
// and every tool answering with the CLI's envelope. Only the connection is fake.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { AccountInfo } from '@solana/web3.js';
import { USDC_MINT } from '../src/account.ts';
import { ata } from '../src/client.ts';
import { makeCtx, type Ctx } from '../src/commands.ts';
import { serve } from '../src/mcp.ts';
import { fakeHandles, fakeRpc, keypairFile, tempDir, tokenAccount } from './helpers.ts';

const dir = tempDir('mcp-');
const owner = keypairFile(dir, 'owner-keypair.json');
const session = keypairFile(dir, 'session-keypair.json');
const accounts = new Map<string, AccountInfo<Buffer>>([
  [ata(owner.key.publicKey, USDC_MINT).toBase58(), tokenAccount(50_000_000n)],
  [session.key.publicKey.toBase58(), { ...tokenAccount(0n), lamports: 100_000_000 }],
]);

async function ctxWith(env: Record<string, string>): Promise<Ctx> {
  const ctx = await makeCtx({ RPC_URL: 'https://rpc.example.com', STATE_DIR: tempDir('state-'), DAILY_LOSS_USDC: '5', ...env }, true);
  const rpc = fakeRpc(accounts);
  ctx.connect = async (cfg, game, signer) => fakeHandles(cfg, game, signer, rpc);
  ctx.prices = { markets: ['BTC'], ticks: async function* () {}, latest: async (market) => ({ market, price: 100, time: Date.now() }) };
  return ctx;
}

/** Send requests on stdin, read the answers by id. */
async function talk(ctx: Ctx, paper: boolean, requests: unknown[]): Promise<Map<unknown, any>> {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => (out += d));
  const done = serve(ctx, { paper, input, output });
  for (const r of requests) input.write(`${typeof r === 'string' ? r : JSON.stringify(r)}\n`);
  input.end();
  await done;
  const answers = out.trim().split('\n').map((l) => JSON.parse(l) as { id: unknown });
  return new Map(answers.map((a) => [a.id, a]));
}
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const envelope = (answer: any) => JSON.parse(answer.result.content[0].text);

test('initialize, ping, notifications and protocol errors', async () => {
  const a = await talk(await ctxWith({}), false, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    { jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    'not json',
  ]);
  assert.equal(a.get(1).result.protocolVersion, '2025-06-18');
  assert.deepEqual(a.get(1).result.serverInfo, { name: 'wheelman', version: '1.0.0' });
  assert.deepEqual(a.get(1).result.capabilities, { tools: {} });
  assert.deepEqual(a.get(2).result, {});
  assert.equal(a.get(3).error.code, -32601);
  assert.equal(a.get(4).result.protocolVersion, '2025-06-18');
  assert.equal(a.get(null).error.code, -32700);
  assert.equal(a.size, 5, 'the notification gets no answer');
});

test('read tools by default; the owner\'s key alone adds no trading tool', async () => {
  for (const env of [{}, { KEYPAIR_PATH: owner.path }] as Record<string, string>[]) {
    const tools = (await talk(await ctxWith(env), false, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])).get(1).result.tools;
    assert.deepEqual(tools.map((t: any) => t.name), ['markets', 'preview', 'positions', 'session_status']);
    assert.ok(tools.every((t: any) => t.annotations.readOnlyHint === true && t.inputSchema.type === 'object'));
  }
});

test('every read tool answers with the envelope', async () => {
  const a = await talk(await ctxWith({ OWNER: owner.key.publicKey.toBase58() }), false, [
    call(1, 'markets'), call(2, 'preview', { market: 'BTC', side: 'long', usd: '1', target: 2 }), call(3, 'positions'), call(4, 'session_status'),
    call(5, 'preview', { market: 'BTC', side: 'up', usd: '1' }), call(6, 'open', { market: 'BTC', side: 'long', usd: '1' }),
  ]);
  assert.equal(envelope(a.get(1)).data.length, 5);
  assert.equal(envelope(a.get(2)).data.payoutAtTarget, '1.824000');
  assert.equal(envelope(a.get(3)).data.balances.usdc, '50.000000');
  assert.equal(envelope(a.get(4)).data.state, 'none');
  assert.equal(a.get(1).result.isError, false);
  assert.deepEqual(envelope(a.get(5)), { ok: false, error: { category: 'config', code: 'BAD_ARGUMENT', message: 'side must be long or short', retryable: false } });
  assert.equal(a.get(5).result.isError, true);
  assert.equal(a.get(6).error.code, -32602, 'open is not a tool without a session key');
});

test('--paper adds open and close, and they trade on paper only', async () => {
  const ctx = await ctxWith({});
  const a = await talk(ctx, true, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    call(2, 'open', { market: 'BTC', side: 'long', usd: '1', target: 2, paper: false }),
  ]);
  assert.deepEqual(a.get(1).result.tools.map((t: any) => t.name), ['markets', 'preview', 'positions', 'session_status', 'open', 'close']);
  const opened = envelope(a.get(2));
  assert.deepEqual([opened.ok, opened.data.paper, opened.data.id], [true, true, '1']);
  const closed = await talk(ctx, true, [call(3, 'close', { id: '1' })]);
  assert.equal(envelope(closed.get(3)).data.closed, true);
});

test('with a session key, open and close trade live, signed by the session', async () => {
  const a = await talk(await ctxWith({ SESSION_KEYPAIR_PATH: session.path, OWNER: owner.key.publicKey.toBase58() }), false, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' }, call(2, 'open', { market: 'BTC', side: 'long', usd: '1' }), call(3, 'close', { id: '7' }),
  ]);
  const tools = a.get(1).result.tools;
  assert.ok(tools.find((t: any) => t.name === 'close').annotations.destructiveHint);
  assert.deepEqual(envelope(a.get(2)).data, { what: 'open', signature: 'signature-open', seqs: ['7'] });
  assert.deepEqual(envelope(a.get(3)).data, { id: '7', signature: 'signature-close' });
});

test('--paper wins over a session key: open and close stay paper-only', async () => {
  const a = await talk(await ctxWith({ SESSION_KEYPAIR_PATH: session.path, OWNER: owner.key.publicKey.toBase58() }), true, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' }, call(2, 'open', { market: 'BTC', side: 'long', usd: '1', target: 2, paper: false }),
  ]);
  assert.match(a.get(1).result.tools.find((t: any) => t.name === 'open').description, /Paper only/);
  assert.equal(envelope(a.get(2)).data.paper, true);
});

test('the real server process writes nothing but JSON-RPC on stdout', async () => {
  const child = spawn(process.execPath, ['src/cli.ts', 'mcp'], { env: { PATH: process.env.PATH, STATE_DIR: tempDir('mcp-run-') } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  for (const m of [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, call(3, 'markets')]) {
    child.stdin.write(`${JSON.stringify(m)}\n`);
  }
  child.stdin.end();
  assert.equal(await new Promise((r) => child.on('close', r)), 0);
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id).sort(), [1, 2, 3]);
  // No RPC_URL: the tool says so in the envelope, and the server stays up.
  assert.match(envelope(lines.find((l) => l.id === 3)).error.message, /RPC_URL is required/);
});
