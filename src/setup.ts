// Onboarding: wheelman setup         asks each question, with a default and a bound
//             wheelman setup --yes   takes every answer from the environment (for agents and scripts)
// It writes .env (mode 600) and, if asked, a new wallet file (mode 600). It never prints a secret.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, parseUsdc } from '@rekt-trading/1000x';
import { MINUTE_PROGRAM_ID } from '@rekt-trading/1000x'; // Minute's API ships in the same package
import { ConfigError, MARKETS, loadKeypair, parseConfig, parseParam } from './config.ts';
import { redact } from './journal.ts';
import { MIN_SOL, usd } from './risk.ts';
import { makeRpc } from './rpc.ts';
import { registry } from './strategies/index.ts';

const LOGO = String.raw`
 __      __ _                 _
 \ \    / /| |_   ___  ___ | | _ __   __ _  _ _
  \ \/\/ / | ' \ / -_)/ -_)| || '  \ / _' || ' \
   \_/\_/  |_||_|\___|\___||_||_|_|_|\__,_||_||_|
   Wheelman, the Rekt trading bot and CLI
`;
const WALLET_FILE = 'wallets/bot-keypair.json';
const DOCS = 'https://docs.rekt.money';

export async function setup(o: { yes: boolean; force: boolean; say: (line: string) => void }) {
  const { yes, force, say } = o;
  const env: Record<string, string> = {};
  const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, def: string | undefined, check: (v: string) => string | null = () => null): Promise<string> => {
    for (;;) {
      const answer = rl === null ? (def ?? '') : ((await rl.question(`${question}${def === undefined || def === '' ? '' : ` [${def}]`}: `)).trim() || (def ?? ''));
      const problem = answer === '' ? 'an answer is required' : check(answer);
      if (problem === null) return answer;
      if (rl === null) throw new ConfigError(`${question}: ${problem}`);
      say(`  ${problem}`);
    }
  };
  const from = (name: string) => process.env[name]?.trim() || undefined;

  say(LOGO);
  say(`Answers go to .env (mode 600). Every variable is in .env.example. Docs: ${DOCS}\n`);
  if (existsSync('.env') && !force) {
    if (rl === null) throw new ConfigError('.env exists: run with --force to replace it');
    if ((await ask('.env exists. Replace it? (yes/no)', 'no')) !== 'yes') {
      rl.close();
      return { wrote: null };
    }
  }

  // 1. The wallet. Only the address is ever shown.
  let wallet: Keypair;
  const existing = from('KEYPAIR_PATH') ?? (existsSync(WALLET_FILE) ? WALLET_FILE : undefined);
  const choice = existing !== undefined ? 'keep' : from('WALLET_IMPORT') !== undefined ? 'import' : 'create';
  const how = await ask('Wallet: create, import or keep', choice, (v) => (['create', 'import', 'keep'].includes(v) ? null : 'create, import or keep'));
  if (how === 'keep') {
    const path = await ask('Keypair file', existing, (v) => (existsSync(v) ? null : 'no such file'));
    wallet = loadKeypair(readFileSync(path, 'utf8'));
    env.KEYPAIR_PATH = path;
  } else {
    if (existsSync(WALLET_FILE)) throw new ConfigError(`${WALLET_FILE} exists: choose keep, or move it first`);
    wallet = how === 'import'
      ? loadKeypair(readFileSync(await ask('Keypair file to import', from('WALLET_IMPORT'), (v) => (existsSync(v) ? null : 'no such file')), 'utf8'))
      : Keypair.generate();
    mkdirSync('wallets', { recursive: true, mode: 0o700 });
    writeFileSync(WALLET_FILE, JSON.stringify(Array.from(wallet.secretKey)), { mode: 0o600, flag: 'wx' });
    env.KEYPAIR_PATH = WALLET_FILE;
    say(`  wrote ${WALLET_FILE} (mode 600). Back it up: it is the only copy of this wallet's key.`);
  }
  say(`  wallet address: ${wallet.publicKey.toBase58()}\n`);

  // 2. RPC: the user's own endpoint. There is no default and no shared key.
  env.RPC_URL = await ask('RPC_URL, your HTTPS RPC endpoint (Helius, Triton, QuickNode, your own node)', from('RPC_URL'), (v) =>
    /^(https:\/\/|http:\/\/localhost[:/])/.test(v) ? null : 'it must start with https://');
  for (const name of ['RPC_WS_URL', 'GRPC_URL', 'GRPC_TOKEN', 'SEND_URL', 'RPC_FALLBACK_URL', 'SEND_TIP_LAMPORTS', 'SEND_TIP_ACCOUNT']) {
    const v = from(name);
    if (v !== undefined) env[name] = v;
  }

  // 3. The public values come from the SDK; nothing to type.
  say(`\n  Knockout program ${PROGRAM_ID}\n  Minute program   ${MINUTE_PROGRAM_ID}\n  Every governed value is read from the chain at run time.\n`);

  // 4. Game, market, strategy and its parameters.
  const strategies = await registry();
  const game = await ask('Game: knockout or minute', from('STRATEGY') === undefined ? 'knockout' : strategies.get(from('STRATEGY')!)?.game, (v) =>
    v === 'knockout' || v === 'minute' ? null : 'knockout or minute');
  const ids = [...strategies.values()].filter((s) => s.game === game).map((s) => s.id);
  for (const id of ids) say(`  ${id}: ${strategies.get(id)!.description}`);
  env.STRATEGY = await ask('Strategy', from('STRATEGY') ?? ids[0], (v) => (ids.includes(v) ? null : `one of ${ids.join(', ')}`));
  env.MARKET = (await ask(`Market (${MARKETS.slice(0, 4).join(', ')})`, from('MARKET') ?? 'BTC', (v) =>
    MARKETS.slice(0, 4).includes(v.toUpperCase()) ? null : `one of ${MARKETS.slice(0, 4).join(', ')}`)).toUpperCase();
  const strategy = strategies.get(env.STRATEGY)!;
  for (const [key, p] of Object.entries(strategy.params)) {
    const name = `PARAM_${key.toUpperCase()}`;
    const bound = p.kind === 'choice' ? p.choices.join(', ') : `${p.min} to ${p.max}${p.kind === 'number' && p.zeroOff ? ', or 0' : ''}`;
    env[name] = await ask(`${key}: ${p.help} (${bound})`, from(name) ?? p.default, (v) => {
      const r = parseParam(name, p, v);
      return 'problem' in r ? r.problem : null;
    });
  }

  // 5. Risk limits. A loss stop is required.
  const stake = env.PARAM_STAKE_USDC ?? '1';
  const amount = (v: string) => {
    try {
      return parseUsdc(v) >= 0n ? null : 'not an amount';
    } catch {
      return 'an amount of USDC, like 1.50';
    }
  };
  env.MAX_STAKE_USDC = await ask('MAX_STAKE_USDC, the largest stake of one trade', from('MAX_STAKE_USDC') ?? stake, amount);
  env.MAX_OPEN = await ask('MAX_OPEN, the most positions open at once (1 to 12)', from('MAX_OPEN') ?? '2', (v) =>
    /^([1-9]|1[0-2])$/.test(v) ? null : 'a whole number from 1 to 12');
  env.DAILY_LOSS_USDC = await ask('DAILY_LOSS_USDC, stop opening when today\'s loss would pass this (required)', from('DAILY_LOSS_USDC'), (v) =>
    amount(v) ?? (parseUsdc(v) > 0n ? null : 'the bot runs only with a loss stop above 0'));
  env.MIN_BALANCE_USDC = await ask('MIN_BALANCE_USDC, never let the wallet drop below this', from('MIN_BALANCE_USDC') ?? '0', amount);
  rl?.close();

  // 6. Check the whole configuration the way `wheelman run` will, then write it.
  parseConfig(env, { strategy: true, limits: true, key: 'signer' }, strategies);
  const lines = ['# Written by wheelman setup. Every variable is documented in .env.example.', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  writeFileSync('.env', `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync('.env', 0o600);
  say('\nwrote .env (mode 600)');

  // 7. The funding check: SOL for fees and rent, USDC for stakes.
  let funding: { sol: number; usdc: string } | null = null;
  try {
    const rpc = makeRpc({ rpcUrl: env.RPC_URL, fallbackUrl: null, sendUrl: env.RPC_URL, maxRps: 5 });
    const usdc = PublicKey.findProgramAddressSync(
      [wallet.publicKey.toBytes(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes(), new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').toBytes()],
      new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    )[0];
    const [sol, token] = await rpc.conn.getMultipleAccountsInfo([wallet.publicKey, usdc], 'confirmed');
    const held = token === null ? 0n : Buffer.from(token.data).readBigUInt64LE(64);
    funding = { sol: (sol?.lamports ?? 0) / 1e9, usdc: usd(held) };
    say(`funding: ${(sol?.lamports ?? 0) / 1e9} SOL (needs ${MIN_SOL} for fees and rent), ${usd(held)} USDC (needs at least ${usd(parseUsdc(stake))})`);
  } catch (e) {
    say(`funding: could not read the wallet: ${redact((e as Error).message)}`);
  }
  say('\nNext: wheelman run --paper    (simulated fills, sends nothing)\n      wheelman run --dry-run  (builds and simulates the real transactions, sends nothing)\n      wheelman run            (trades)');
  return { wrote: '.env', wallet: wallet.publicKey.toBase58(), keypairPath: env.KEYPAIR_PATH, funding };
}
