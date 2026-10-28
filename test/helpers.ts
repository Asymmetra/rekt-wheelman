// Test helpers: an invented venue (round numbers, not the live values) that the SDK's own arithmetic
// accepts, and a fake connection, so every command runs offline through the real code above it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram, type AccountInfo } from '@solana/web3.js';
import { MODE_COMMIT_OPEN, MODE_FEE_TERMS_ON, type ConfigView, type FeeTermsTableView, type MarketView } from '@rekt-trading/1000x';
import type { MinuteConfigView } from '@rekt-trading/1000x'; // Minute's API ships in the same package
import type { Handles } from '../src/commands.ts';
import type { Config } from '../src/config.ts';
import type { Venue } from '../src/paper.ts';
import { CLOCK, type Rpc } from '../src/rpc.ts';
import type { Game } from '../src/strategies/index.ts';

/** Fee terms: 4 % on a win, 8 % on a loss, a 1 bp ramp; 60 % of a gain kept up to 1 bp, 90 % from 10 bp. */
export const TERMS = {
  winBps: 400, lossBps: 800, rampHalfTenthBp: 10, rampCenterTenthBp: 0, haircutCount: 2,
  haircutMoveTenthBp: [10, 100, 0, 0, 0, 0], haircutKeptBps: [6000, 9000, 0, 0, 0, 0], feeBase: 1, writtenAt: 1n,
};

export function venue(withTerms = true): Venue {
  const config = {
    mode: MODE_COMMIT_OPEN | (withTerms ? MODE_FEE_TERMS_ON : 0), paused: false,
    params: {
      entryFeeBps: 0n, muBps: 5000n, payoutCapMultiple: 100n, exitFeeBps: 800n, minCollateral: 200_000n, maxCollateral: 1_000_000_000n,
      taxSplit: [0n, 10_000n, 0n, 0n], exitSplit: [5000n, 5000n], pendingExitSplit: [5000n, 5000n], exitSplitEffectiveAt: 0n, gasFloor: 0n,
      entrySplit: [10_000n, 0n], pendingEntrySplit: [10_000n, 0n], entrySplitEffectiveAt: 0n, tMaxSeconds: 4_000_000_000,
    },
  } as unknown as ConfigView;
  const market = { tier: 1000n, exitFeeBps: 0, feeTermsRegs: 1, minuteEnabled: true, paused: false } as unknown as MarketView;
  const feeTable = { entries: [TERMS] } as unknown as FeeTermsTableView;
  const minute = { params: { tier: 0, rungBps: 0, initialTimerS: 60, entryFeeBps: 100, exitFeeBps: 200 } } as unknown as MinuteConfigView;
  return { config, market, feeTable, minute, nowUnix: 1_767_225_600n };
}

/** A token account holding `amount` base units (the amount is at byte 64). */
export function tokenAccount(amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return { data, owner: PublicKey.default, lamports: 2_039_280, executable: false };
}

/** A connection that answers from a map of accounts and simulates every transaction clean. */
export function fakeRpc(accounts = new Map<string, AccountInfo<Buffer>>(), simulate: { err: unknown; unitsConsumed: number } = { err: null, unitsConsumed: 1234 }): Rpc {
  // The Clock: slot 1000, unix time 2026-01-01.
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(1000n, 0);
  clock.writeBigInt64LE(1_767_225_600n, 32);
  const clockInfo = { data: clock, owner: PublicKey.default, lamports: 1, executable: false };
  const conn = {
    // Read live: a test may add an account after the connection exists.
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (k.equals(CLOCK) ? clockInfo : (accounts.get(k.toBase58()) ?? null))),
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }),
    getRecentPrioritizationFees: async () => [],
    simulateTransaction: async () => ({ value: { ...simulate, logs: [] } }),
    getSignaturesForAddress: async () => [],
  };
  return { conn: conn as never, send: conn as never, host: 'rpc.example.com', call: async () => ({}) };
}

/** A two-instruction bundle, as a client's build.* returns one. */
export const bundle = () => ({
  instructions: [SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  computeUnits: 30_000,
});

/** Handles with fake clients: what each records, and what each answers, is the test's to set. */
export function fakeHandles(cfg: Config, game: Game, signer: Keypair | null, rpc: Rpc, calls: string[] = []): Handles {
  const owner = cfg.owner ?? PublicKey.default;
  const knockout = {
    owner,
    market: async (symbol: string) => {
      calls.push(`market ${symbol}`);
      return {
        symbol, address: PublicKey.default.toBase58(), open: true, why: null, minute: symbol !== 'XAU', leverage: 1000,
        stake: { min: 200_000n, max: 1_000_000_000n }, fees: { entryBps: 0, exitWinBps: 400, exitLossBps: 800, keptBps: [] },
        sideRoom: { long: null, short: 5_000_000n },
      };
    },
    preview: async () => ({ market: 'BTC', side: 'long' as const, debit: 1_000_000n, stake: 1_000_000n, leverage: 1000, barrierBps: 5, target: 2, targetBps: 10, timer: 0, payoutAtTarget: 1_824_000n, payoutAtBarrier: 0n }),
    positions: async () => [],
    history: async () => [],
    settlement: async () => null,
    open: async (orders: unknown) => {
      calls.push(`open ${JSON.stringify(orders, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      return { seq: 7n, seqs: [7n], signature: 'signature-open' };
    },
    close: async (seq: bigint) => {
      calls.push(`close ${seq}`);
      return { signature: 'signature-close' };
    },
    build: { open: async () => bundle(), close: async () => bundle() },
  };
  const minute = {
    owner, player: PublicKey.default, book: PublicKey.default, custody: PublicKey.default,
    rounds: async () => [], history: async () => [], settlement: async () => null,
    preview: async () => ({ market: 'BTC', side: 'long' as const, total: 1_000_000n, stake: 990_000n, leverage: 1000, timer: 60, target: null, payoutAtTarget: null, payoutAtBarrier: 0n, minuteFees: { entryBps: 100, exitBps: 200 } }),
    round: async () => {
      calls.push('round');
      return { seq: 9n, signature: 'signature-round' };
    },
    build: { round: async () => bundle() },
  };
  return {
    cfg, rpc, owner, game, knockout: knockout as never, minute: minute as never, venue: async () => venue(),
    sender: { rpc, payer: signer?.publicKey ?? owner, signer, maxPriorityFee: 1000, tip: null },
  };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A keypair file made for the test, in a temporary directory. */
export function keypairFile(dir: string, name: string): { path: string; key: Keypair } {
  const key = Keypair.generate();
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600 });
  return { path, key };
}
