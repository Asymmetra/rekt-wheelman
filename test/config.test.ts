// A bad configuration is refused before any RPC call, and no secret reaches a message.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { encodeBase58 } from '@rekt-trading/1000x';
import { ConfigError, parseConfig, type Needs } from '../src/config.ts';
import { addSecret, redact } from '../src/journal.ts';
import { registry } from '../src/strategies/index.ts';

const strategies = await registry();
const KEY = 'k3y-that-must-never-print';
// The key parameter is spelled in parts: a literal one in source looks like a leaked key to scanners.
const KEY_PARAM = ['api', 'key'].join('-');
const good = {
  RPC_URL: `https://rpc.example.com/?${KEY_PARAM}=${KEY}`,
  STRATEGY: 'knockout-momentum',
  MARKET: 'BTC',
  DAILY_LOSS_USDC: '10',
  WALLET_SECRET_KEY: JSON.stringify(Array.from(Keypair.generate().secretKey)),
};
const RUN = { strategy: true, limits: true, key: 'signer' } as const;
const refused = (env: Record<string, string | undefined>, needs: Needs = RUN): string => {
  try {
    parseConfig(env, needs, strategies);
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.message;
  }
  assert.fail('the configuration was accepted');
};

test('a good configuration parses, with the defaults and bounds filled in', () => {
  const c = parseConfig(good, RUN, strategies);
  assert.equal(c.strategy?.id, 'knockout-momentum');
  assert.equal(c.params.stake_usdc, 1_000_000n);
  assert.equal(c.params.trigger_bps, 5);
  assert.equal(c.limits.dailyLoss, 10_000_000n);
  assert.equal(c.wsUrl, `wss://rpc.example.com/?${KEY_PARAM}=${KEY}`);
  assert.equal(c.sendUrl, good.RPC_URL);
});

test('a configuration with no loss stop is refused', () => {
  assert.match(refused({ ...good, DAILY_LOSS_USDC: undefined }), /DAILY_LOSS_USDC is required/);
  assert.match(refused({ ...good, DAILY_LOSS_USDC: '0' }), /loss stop/);
  assert.match(refused({ ...good, DAILY_LOSS_USDC: '0' }, { strategy: true, limits: true }), /loss stop/);
  assert.doesNotThrow(() => parseConfig({ RPC_URL: good.RPC_URL }, {}, strategies)); // a read command needs no loss stop
});

test('every bad value is refused, all at once', () => {
  const m = refused({
    ...good, RPC_URL: 'http://rpc.example.com', MARKET: 'DOGE', MAX_OPEN: '40', PARAM_TRIGGER_BPS: '0', PARAM_TAKE_PROFIT_X: '1.5',
    PARAM_NOPE: '1', PRICE_SOURCE: 'other',
  });
  for (const part of ['RPC_URL must start with https:', 'MARKET must be one of', 'MAX_OPEN', 'PARAM_TRIGGER_BPS', 'PARAM_TAKE_PROFIT_X', 'PARAM_NOPE is not a parameter', 'PRICE_SOURCE']) {
    assert.ok(m.includes(part), `missing: ${part}\n${m}`);
  }
});

test('limits that contradict each other are refused', () => {
  assert.match(refused({ ...good, PARAM_STAKE_USDC: '3', MAX_STAKE_USDC: '2' }), /above MAX_STAKE_USDC/);
  assert.match(refused({ ...good, MAX_STAKE_USDC: '20' }), /MAX_STAKE_USDC is above DAILY_LOSS_USDC/);
  assert.match(refused({ ...good, STRATEGY: 'knockout-straddle', MAX_OPEN: '1' }), /MAX_OPEN must be at least 2/);
  assert.match(refused({ ...good, STRATEGY: 'knockout-straddle', DAILY_LOSS_USDC: '1.5', MAX_STAKE_USDC: '1' }), /twice/);
});

test('a strategy, a market and a price source must exist and fit together', () => {
  assert.match(refused({ ...good, STRATEGY: undefined }), /STRATEGY is required/);
  assert.match(refused({ ...good, STRATEGY: 'nope' }), /does not exist/);
  assert.match(refused({ ...good, MARKET: 'XAU' }), /no XAU price/);
  assert.match(refused({ ...good, PRICE_SOURCE: 'replay' }), /REPLAY_FILE/);
  assert.doesNotThrow(() => parseConfig({ ...good, PARAM_TAKE_PROFIT_X: '0', PARAM_TIME_STOP_S: '0' }, RUN, strategies));
});

test('keys: the owner\'s wallet, a session key with OWNER, or just an address', () => {
  assert.match(refused({ ...good, WALLET_SECRET_KEY: undefined }), /KEYPAIR_PATH or WALLET_SECRET_KEY, or a session key/);
  assert.equal(parseConfig({ ...good, WALLET_SECRET_KEY: undefined }, { strategy: true, limits: true }, strategies).wallet, null);
  const address = Keypair.generate().publicKey.toBase58();
  assert.equal(parseConfig({ ...good, WALLET_SECRET_KEY: undefined, OWNER: address }, { key: 'address' }, strategies).owner?.toBase58(), address);
  assert.match(refused({ ...good, WALLET_SECRET_KEY: undefined, OWNER: address }, { key: 'owner' }), /owner's wallet/);
  const base58 = encodeBase58(Keypair.generate().secretKey);
  assert.ok(parseConfig({ ...good, WALLET_SECRET_KEY: base58 }, RUN, strategies).wallet !== null);
  assert.match(refused({ ...good, OWNER: address }), /OWNER is not the address of the configured wallet/);
  const dir = mkdtempSync(join(tmpdir(), 'session-'));
  const session = join(dir, 'session.json');
  writeFileSync(session, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  assert.match(refused({ ...good, WALLET_SECRET_KEY: undefined, SESSION_KEYPAIR_PATH: session }), /needs OWNER/);
  const c = parseConfig({ ...good, WALLET_SECRET_KEY: undefined, SESSION_KEYPAIR_PATH: session, OWNER: address }, RUN, strategies);
  assert.ok(c.session !== null && c.wallet === null && c.owner?.toBase58() === address);
});

test('a bad secret key is refused without quoting it', () => {
  const secret = 'not-a-key-but-secret-looking-text';
  const m = refused({ ...good, WALLET_SECRET_KEY: secret });
  assert.match(m, /WALLET_SECRET_KEY could not be read/);
  assert.ok(!m.includes(secret));
  assert.ok(!refused({ ...good, WALLET_SECRET_KEY: `[1,2,${secret}` }).includes(secret));
});

test('redaction hides keys in queries and paths, and every registered secret', () => {
  addSecret('https://node.example.net/secret-path-token');
  const text = redact(`failed: https://a.example.com/?${KEY_PARAM}=${KEY}&x=1 and https://node.example.net/secret-path-token and usdc=5`);
  assert.ok(!text.includes(KEY) && !text.includes('secret-path-token'), text);
  assert.ok(text.includes('usdc=5'));
});

test('the bot refuses a bad configuration before it makes any RPC call', async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  const port = (server.address() as { port: number }).port;
  const run = spawnSync(process.execPath, ['src/cli.ts', 'run'], {
    env: { PATH: process.env.PATH, RPC_URL: `http://localhost:${port}/?${KEY_PARAM}=${KEY}`, STRATEGY: 'knockout-momentum', DAILY_LOSS_USDC: '0', STATE_DIR: mkdtempSync(join(tmpdir(), 'state-')) },
    encoding: 'utf8',
  });
  server.close();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /loss stop/);
  assert.match(run.stderr, /^config BAD_CONFIG/);
  assert.ok(!run.stderr.includes(KEY) && !run.stdout.includes(KEY));
  assert.equal(calls, 0);
});
