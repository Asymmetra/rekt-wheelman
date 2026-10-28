// Onboarding without prompts: `npm run setup -- --yes` in an empty directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const CLI = resolve('src/cli.ts');

async function setup(env: Record<string, string>, args: string[] = ['setup', '--yes']) {
  // A fake RPC that answers every call with an empty result, so the funding check runs offline.
  const server = createServer((_req, res) => res.end('{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":[null,null]}}'));
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: dir, env: { PATH: process.env.PATH, RPC_URL: `http://localhost:${(server.address() as { port: number }).port}/?${['api', 'key'].join('-')}=k3y`, ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  server.close();
  return { code, out, dir };
}

test('setup --yes creates a wallet and .env, both mode 600, and prints only the address', async () => {
  const { code, out, dir } = await setup({ STRATEGY: 'minute-trend', DAILY_LOSS_USDC: '5', PARAM_STAKE_USDC: '0.5' });
  assert.equal(code, 0, out);
  assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'wallets/bot-keypair.json')).mode & 0o777, 0o600);
  const env = readFileSync(join(dir, '.env'), 'utf8');
  for (const line of ['KEYPAIR_PATH=wallets/bot-keypair.json', 'STRATEGY=minute-trend', 'MARKET=BTC', 'PARAM_STAKE_USDC=0.5', 'PARAM_LOOKBACK_S=30', 'MAX_STAKE_USDC=0.5', 'DAILY_LOSS_USDC=5']) {
    assert.ok(env.includes(`${line}\n`), `missing ${line}`);
  }
  const secret = JSON.parse(readFileSync(join(dir, 'wallets/bot-keypair.json'), 'utf8')) as number[];
  assert.equal(secret.length, 64);
  assert.match(out, /wallet address: [1-9A-HJ-NP-Za-km-z]{32,44}/);
  assert.ok(!out.includes(secret.join(',')) && !out.includes('k3y'));
  assert.match(out, /funding: /);
});

test('setup --yes refuses no loss stop, a bad parameter, and an existing .env', async () => {
  assert.match((await setup({ STRATEGY: 'knockout-momentum' })).out, /DAILY_LOSS_USDC/);
  const bad = await setup({ STRATEGY: 'knockout-momentum', DAILY_LOSS_USDC: '5', PARAM_TRIGGER_BPS: '0' });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /PARAM_TRIGGER_BPS must be a number from 1 to 1000/);
  const first = await setup({ STRATEGY: 'knockout-momentum', DAILY_LOSS_USDC: '5' });
  const again = spawn(process.execPath, [CLI, 'setup', '--yes'], { cwd: first.dir, env: { PATH: process.env.PATH } });
  let out = '';
  again.stderr.on('data', (d) => (out += d));
  assert.equal(await new Promise((r) => again.on('close', r)), 1);
  assert.match(out, /\.env exists/);
});
