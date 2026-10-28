// Configuration: environment variables only (`.env` on a laptop, the host's settings elsewhere).
// `.env.example` documents every variable. A bad value is refused here, before any RPC call.
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { parseUsdc } from '@rekt-trading/1000x';
import { Refusal } from './errors.ts';
import { addSecret } from './journal.ts';
import type { Limits } from './risk.ts';
import type { Param, Params, Strategy } from './strategies/index.ts';

export const MARKETS = ['BTC', 'ETH', 'SOL', 'XRP', 'XAU'];

export interface Config {
  rpcUrl: string;
  wsUrl: string;
  grpcUrl: string | null;
  grpcToken: string | null;
  sendUrl: string;
  fallbackUrl: string | null;
  maxRps: number;
  tip: { lamports: number; account: PublicKey } | null;
  maxPriorityFee: number;
  /** The owner's key, when this process holds it. */
  wallet: Keypair | null;
  /** A session key that trades for the owner, inside the limits the owner set. */
  session: Keypair | null;
  sessionPath: string;
  /** The wallet whose positions these are. */
  owner: PublicKey | null;
  market: string;
  strategy: Strategy | null;
  params: Params;
  priceSource: string;
  replayFile: string | undefined;
  limits: Limits;
  paperUsdc: bigint;
  stateDir: string;
}

/** What a command needs from the configuration. */
export interface Needs {
  /** STRATEGY and its parameters. */
  strategy?: boolean;
  /** The risk limits, with the required loss stop. */
  limits?: boolean;
  /** 'owner': the owner's key; 'signer': the owner's key or a session key; 'address': at least an address. */
  key?: 'owner' | 'signer' | 'address';
}

export class ConfigError extends Refusal {
  constructor(message: string) {
    super('config', 'BAD_CONFIG', message);
  }
}

type Env = Record<string, string | undefined>;

export function parseConfig(env: Env, needs: Needs, strategies: Map<string, Strategy>): Config {
  const problems: string[] = [];
  const get = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const url = (name: string, schemes: string[]): string | undefined => {
    const v = get(name);
    if (v === undefined) return undefined;
    addSecret(v);
    try {
      const u = new URL(v);
      const local = u.hostname === 'localhost' && schemes.map((s) => s.replace('s:', ':')).includes(u.protocol);
      if (!schemes.includes(u.protocol) && !local) problems.push(`${name} must start with ${schemes.join(' or ')}`);
    } catch {
      problems.push(`${name} is not a URL`);
    }
    return v;
  };
  const num = (name: string, def: number, min: number, max: number): number => {
    const v = get(name);
    const n = v === undefined ? def : Number(v);
    if (!Number.isFinite(n) || n < min || n > max) problems.push(`${name} must be a number from ${min} to ${max}`);
    return n;
  };
  const usdc = (name: string, def: string | undefined): bigint => {
    const v = get(name) ?? def;
    if (v === undefined) {
      if (needs.limits) problems.push(`${name} is required`);
      return 0n;
    }
    try {
      const n = parseUsdc(v);
      if (n < 0n) throw new Error('negative');
      return n;
    } catch {
      problems.push(`${name} must be an amount of USDC, like 1.50`);
      return 0n;
    }
  };
  const address = (name: string): PublicKey | null => {
    const v = get(name);
    if (v === undefined) return null;
    try {
      return new PublicKey(v);
    } catch {
      problems.push(`${name} is not an address`);
      return null;
    }
  };
  const keypair = (pathName: string, secretName?: string): Keypair | null => {
    const secret = secretName === undefined ? undefined : get(secretName);
    addSecret(secret);
    const path = get(pathName);
    try {
      if (path !== undefined) return loadKeypair(readFileSync(path, 'utf8'));
      if (secret !== undefined) return loadKeypair(secret);
    } catch (e) {
      problems.push(`${secretName !== undefined && path === undefined ? secretName : pathName} could not be read: ${(e as Error).message}`);
    }
    return null;
  };

  const rpcUrl = url('RPC_URL', ['https:']);
  if (rpcUrl === undefined) problems.push('RPC_URL is required: an HTTPS JSON-RPC endpoint from any provider');
  const wsUrl = url('RPC_WS_URL', ['wss:']) ?? (rpcUrl ?? '').replace(/^http/, 'ws');
  const grpcUrl = url('GRPC_URL', ['https:', 'http:']) ?? null;
  const grpcToken = get('GRPC_TOKEN') ?? null;
  addSecret(grpcToken ?? undefined);
  const sendUrl = url('SEND_URL', ['https:']) ?? rpcUrl ?? '';
  const fallbackUrl = url('RPC_FALLBACK_URL', ['https:']) ?? null;
  const maxRps = num('RPC_MAX_RPS', 10, 1, 500);
  const tipLamports = num('SEND_TIP_LAMPORTS', 0, 0, 10_000_000);
  const tipAccount = address('SEND_TIP_ACCOUNT');
  if (tipLamports > 0 && tipAccount === null) problems.push('SEND_TIP_LAMPORTS needs SEND_TIP_ACCOUNT');
  const maxPriorityFee = num('MAX_PRIORITY_FEE', 100_000, 0, 10_000_000);

  // The keys. Never printed; only addresses are shown.
  const wallet = keypair('KEYPAIR_PATH', 'WALLET_SECRET_KEY');
  const sessionPath = get('SESSION_KEYPAIR_PATH') ?? 'wallets/session-keypair.json';
  const session = get('SESSION_KEYPAIR_PATH') === undefined ? null : keypair('SESSION_KEYPAIR_PATH');
  const named = address('OWNER');
  const owner = wallet?.publicKey ?? named;
  if (wallet !== null && named !== null && !named.equals(wallet.publicKey)) problems.push('OWNER is not the address of the configured wallet');
  if (session !== null && owner === null) problems.push('a session key needs OWNER: the address of the wallet it trades for');
  if (needs.key === 'owner' && wallet === null) problems.push('this command needs the owner\'s wallet: set KEYPAIR_PATH or WALLET_SECRET_KEY');
  if (needs.key === 'signer' && wallet === null && session === null) problems.push('set KEYPAIR_PATH or WALLET_SECRET_KEY, or a session key (SESSION_KEYPAIR_PATH and OWNER)');
  if (needs.key === 'address' && owner === null) problems.push('set OWNER (an address), or a wallet');

  const market = (get('MARKET') ?? 'BTC').toUpperCase();
  if (!MARKETS.includes(market)) problems.push(`MARKET must be one of ${MARKETS.join(', ')}`);
  const priceSource = get('PRICE_SOURCE') ?? 'coinbase';
  const replayFile = get('REPLAY_FILE');
  if (!['coinbase', 'replay'].includes(priceSource)) problems.push('PRICE_SOURCE must be coinbase or replay');
  if (priceSource === 'replay' && replayFile === undefined) problems.push('PRICE_SOURCE=replay needs REPLAY_FILE');

  const limits: Limits = {
    maxStake: usdc('MAX_STAKE_USDC', '1'),
    maxOpen: num('MAX_OPEN', 2, 1, 12),
    dailyLoss: usdc('DAILY_LOSS_USDC', undefined),
    minBalance: usdc('MIN_BALANCE_USDC', '0'),
  };
  if (needs.limits && get('DAILY_LOSS_USDC') !== undefined && limits.dailyLoss === 0n) problems.push('DAILY_LOSS_USDC must be above 0: the bot trades only with a loss stop');
  if (limits.dailyLoss > 0n && limits.maxStake > limits.dailyLoss) problems.push('MAX_STAKE_USDC is above DAILY_LOSS_USDC, so no trade could open');

  let strategy: Strategy | null = null;
  const params: Params = {};
  if (needs.strategy) {
    const id = get('STRATEGY');
    strategy = id === undefined ? null : (strategies.get(id) ?? null);
    if (id === undefined) problems.push(`STRATEGY is required: one of ${[...strategies.keys()].join(', ')}`);
    else if (strategy === null) problems.push(`STRATEGY ${id} does not exist: use one of ${[...strategies.keys()].join(', ')}`);
    if (strategy?.game === 'knockout' && priceSource === 'coinbase' && market === 'XAU') {
      problems.push('PRICE_SOURCE=coinbase has no XAU price; use replay, or add an adapter in src/prices.ts');
    }
  }
  if (strategy !== null) {
    const known = new Set(Object.keys(strategy.params).map((k) => `PARAM_${k.toUpperCase()}`));
    for (const name of Object.keys(env)) {
      if (name.startsWith('PARAM_') && !known.has(name)) problems.push(`${name} is not a parameter of ${strategy.id}`);
    }
    for (const [key, p] of Object.entries(strategy.params)) {
      const name = `PARAM_${key.toUpperCase()}`;
      const r = parseParam(name, p, get(name) ?? p.default);
      if ('problem' in r) problems.push(r.problem);
      else {
        params[key] = r.value;
        if (typeof r.value === 'bigint' && r.value > limits.maxStake) problems.push(`${name} is above MAX_STAKE_USDC`);
      }
    }
    if (strategy.id === 'knockout-straddle') {
      if (limits.maxOpen < 2) problems.push('knockout-straddle opens two positions: MAX_OPEN must be at least 2');
      const each = params.stake_usdc;
      if (typeof each === 'bigint' && limits.dailyLoss > 0n && 2n * each > limits.dailyLoss) {
        problems.push('knockout-straddle stakes two sides: DAILY_LOSS_USDC must be at least twice PARAM_STAKE_USDC');
      }
    }
  }
  const paperUsdc = usdc('PAPER_USDC', '100');

  if (problems.length > 0) throw new ConfigError(`the configuration is refused:\n  - ${problems.join('\n  - ')}`);
  return {
    rpcUrl: rpcUrl!, wsUrl, grpcUrl, grpcToken, sendUrl, fallbackUrl, maxRps, maxPriorityFee,
    tip: tipLamports > 0 && tipAccount !== null ? { lamports: tipLamports, account: tipAccount } : null,
    wallet, session, sessionPath, owner, market, strategy, params, priceSource, replayFile, limits, paperUsdc,
    stateDir: get('STATE_DIR') ?? '.wheelman',
  };
}

/** One strategy parameter from its text, inside its bounds. */
export function parseParam(name: string, p: Param, text: string): { value: number | bigint | string } | { problem: string } {
  if (p.kind === 'choice') return p.choices.includes(text) ? { value: text } : { problem: `${name} must be one of ${p.choices.join(', ')}` };
  if (p.kind === 'usdc') {
    try {
      const v = parseUsdc(text);
      if (v >= parseUsdc(p.min) && v <= parseUsdc(p.max)) return { value: v };
    } catch {
      // refused below
    }
    return { problem: `${name} must be an amount of USDC from ${p.min} to ${p.max}` };
  }
  const v = Number(text);
  if (text !== '' && Number.isFinite(v) && ((p.zeroOff === true && v === 0) || (v >= p.min && v <= p.max))) return { value: v };
  return { problem: `${name} must be a number from ${p.min} to ${p.max}${p.zeroOff === true ? ', or 0 for none' : ''}` };
}

/** A keypair from a Solana keypair file (a JSON array of 64 numbers) or a base58 secret key. */
export function loadKeypair(text: string): Keypair {
  try {
    const t = text.trim();
    const bytes = t.startsWith('[') ? Uint8Array.from(JSON.parse(t) as number[]) : base58Secret(t);
    return Keypair.fromSecretKey(bytes);
  } catch {
    // Never pass the parser's message on: it can quote the secret.
    throw new Error('it is not a keypair file (64 numbers) or a base58 secret key');
  }
}

/** A 64-byte secret key from base58 (the form wallets export). */
function base58Secret(text: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of text) {
    const digit = alphabet.indexOf(ch);
    if (digit < 0) throw new Error('not base58');
    n = n * 58n + BigInt(digit);
  }
  const out = new Uint8Array(64);
  for (let i = 63; i >= 0; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  if (n !== 0n) throw new Error('longer than 64 bytes');
  return out;
}
