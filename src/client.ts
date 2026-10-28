// createKnockoutClient: the Knockout client the SDK is to ship, written here with the same method
// names and result shapes. When the SDK publishes it, this file is deleted and the import changes.
//   market(symbol)   facts about a market       preview(order)   what an open costs and pays
//   open(order)      { seq, seqs, signature }   positions()      the wallet's open positions
//   close(seq)       { signature }              settlement(seq)  what a closed position paid
//   history()        settled positions          build.open/close the same, as unsigned instructions
// A refusal is thrown as a Refusal with `retryable`. Money is bigint USDC base units.
import { PublicKey, type Keypair, type TransactionInstruction } from '@solana/web3.js';
import {
  MICRO_PER_BP, assetId, barrierMicroBps, closableFromSlotOf, commitOpen, computeUnitLimit, configPda, connectionReader, decodeConfig, decodeFeeTermsTable,
  decodeMarket, decodeTraderAccount, decodeVault, delegatePda, exitFeeBpsFor, feeTermsTablePda,
  findBySeq, heldPositions, inEventWindow, ix, levels, marketPda, memoReader, newRules, openFeeTerms, openTenorS, ourInstruction,
  parseUsdc, phase, priceAccountsFor, readTradeHistory, receiptOf, sideRoom, sizeForTotal, toBase58, toHex, traderPda, vaultPda, venueEventsNamed,
  type BuiltInstruction, type ClosedTrade, type MemoReaderOptions, type ConfigView, type MarketView, type Phase, type TraderAccountView, type VaultView,
} from '@rekt-trading/1000x';
import { MARKETS } from './config.ts';
import { Refusal } from './errors.ts';
import { payoutAt, scaled, termsFor } from './paper.ts';
import { CLOCK, transact, type Bundle, type Rpc, type Sender } from './rpc.ts';

export type Side = 'long' | 'short';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const ata = (owner: PublicKey, mint: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
export const tokenAmount = (data: Uint8Array | null | undefined): bigint => (data == null || data.length < 72 ? 0n : Buffer.from(data).readBigUInt64LE(64));
const clockOf = (data: Uint8Array) => ({ slot: Buffer.from(data).readBigUInt64LE(0), unix: Buffer.from(data).readBigInt64LE(32) });

export interface KnockoutClientOptions {
  rpc: Rpc;
  /** The wallet whose book trades. */
  owner: PublicKey;
  /** The owner's key, or a session key (then the session signs and pays). null: build and simulate only. */
  signer: Keypair | null;
  maxPriorityFee?: number;
  tip?: { lamports: number; account: PublicKey } | null;
  /** Where settled transactions are kept, so none is fetched twice. */
  store?: MemoReaderOptions['store'];
}

export interface Order {
  market: string;
  side: Side;
  /** What leaves the wallet, in USDC: '1.50' or base units. */
  usd: string | bigint;
  /** Take-profit as a multiple of the stake (2 or more); 0 or absent: none of its own. */
  target?: number;
  /** The position's own timer in seconds (26 or more); 0 or absent: none. */
  timer?: number;
}

export interface MarketFacts {
  symbol: string;
  address: string;
  open: boolean;
  /** Why it takes no open now, or null. */
  why: string | null;
  minute: boolean;
  leverage: number;
  stake: { min: bigint; max: bigint };
  fees: { entryBps: number; exitWinBps: number; exitLossBps: number; keptBps: { moveBp: number; keptBps: number }[] };
  /** Room left on each side, when a side limit is set; null when none is. */
  sideRoom: { long: bigint | null; short: bigint | null };
}

export interface Preview {
  market: string;
  side: Side;
  /** What leaves the wallet, and the position it buys. */
  debit: bigint;
  stake: bigint;
  leverage: number;
  barrierBps: number;
  /** The take-profit multiple, or null for none of its own. */
  target: number | null;
  targetBps: number | null;
  timer: number;
  /** What the trader receives at the target, after the exit fee and the share of the gain the venue keeps. */
  payoutAtTarget: bigint | null;
  payoutAtBarrier: bigint;
}

export interface Opened {
  seq: bigint;
  seqs: bigint[];
  signature: string;
}

export interface PositionInfo {
  seq: bigint;
  market: string;
  side: Side;
  stake: bigint;
  /** null while the open is an order that waits for its price. */
  entryPrice: number | null;
  barrierPrice: number | null;
  targetPrice: number | null;
  state: Phase;
  openedAt: number;
  timerEndsAt: number | null;
  /** The first slot a close request can land in; null while there is none. */
  closableFromSlot: bigint | null;
}

export interface Settlement {
  seq: bigint;
  market: string;
  side: Side | null;
  stake: bigint;
  payout: bigint;
  pnl: bigint;
  reason: string;
  settledAt: number | null;
  signature: string;
}

const symbolOf = new Map(MARKETS.map((s) => [toHex(marketPda(assetId(s)).address), s]));
export const marketSymbol = (hex: string): string => symbolOf.get(hex) ?? toBase58(hex);
const price = (v: bigint, expo: number): number => Number(v) * 10 ** expo;
const sideOf = (direction: number): Side => (direction === 0 ? 'long' : 'short');

export function createKnockoutClient(o: KnockoutClientOptions) {
  const owner = o.owner;
  const book = traderPda(owner).address;
  const session = o.signer !== null && !o.signer.publicKey.equals(owner);
  const authority = o.signer?.publicKey ?? owner;
  const sender: Sender = { rpc: o.rpc, payer: authority, signer: o.signer, maxPriorityFee: o.maxPriorityFee ?? 100_000, tip: o.tip ?? null };
  const reader = memoReader(connectionReader(o.rpc.conn), o.store === undefined ? {} : { store: o.store });
  let vaultToken: Promise<{ address: PublicKey; mint: PublicKey }> | null = null;

  /** The vault's token account and the USDC mint: fixed, read once. */
  const vaultTokenOf = (vault: VaultView) =>
    (vaultToken ??= (async () => {
      const address = new PublicKey(toBase58(vault.tokenAccount));
      const info = await o.rpc.conn.getAccountInfo(address, 'confirmed');
      if (info === null) throw new Refusal('venue', 'VAULT_MISSING', 'the vault token account is missing');
      return { address, mint: new PublicKey(info.data.subarray(0, 32)) };
    })());

  /** One read: the config, the vault, a market and its fee terms, the wallet's book, the clock. */
  async function read(symbol: string) {
    const market = marketPda(assetId(symbol)).address;
    const [c, v, m, f, b, k] = await o.rpc.conn.getMultipleAccountsInfo(
      [configPda().address, vaultPda().address, market, feeTermsTablePda(market).address, book, CLOCK], 'confirmed');
    if (c === null || v === null) throw new Refusal('config', 'VENUE_MISSING', 'the venue config is missing: is RPC_URL a mainnet endpoint?');
    if (m === null) throw new Refusal('config', 'NO_SUCH_MARKET', `${symbol} is not listed on the venue`);
    return {
      address: market, config: decodeConfig(new Uint8Array(c.data)), vault: decodeVault(new Uint8Array(v.data)),
      market: decodeMarket(new Uint8Array(m.data)), feeTable: f === null ? null : decodeFeeTermsTable(new Uint8Array(f.data)),
      book: b === null ? null : decodeTraderAccount(new Uint8Array(b.data)), clock: clockOf(new Uint8Array(k!.data)),
    };
  }

  /** Why the market takes no open now, or null. */
  function closedWhy(config: ConfigView, market: MarketView, nowUnix: bigint): string | null {
    if (config.paused) return 'the venue is paused';
    if (!commitOpen(config)) return 'the venue takes no orders now';
    if (config.oracleFrozen || config.settlesDisabled) return 'the venue is stopped';
    if (market.paused) return 'the market is paused';
    if (inEventWindow(market, nowUnix)) return 'a scheduled event window';
    const t = openTenorS(config, market, nowUnix);
    return t.ok ? null : t.reason === 'closed' ? 'outside trading hours' : 'too close to the session close';
  }

  async function market(symbol: string): Promise<MarketFacts> {
    const r = await read(symbol);
    const vt = await vaultTokenOf(r.vault);
    const balance = await o.rpc.conn.getAccountInfo(vt.address, 'confirmed');
    const terms = openFeeTerms(r.config, r.market, r.feeTable);
    const flat = Number(exitFeeBpsFor(BigInt(r.market.exitFeeBps), r.config.params.exitFeeBps));
    const room = (side: Side) => {
      const s = sideRoom(side, r.market, r.vault, tokenAmount(balance?.data), newRules(r.config));
      return s.limit === null ? null : s.room; // no limit set: no room to report
    };
    const why = closedWhy(r.config, r.market, r.clock.unix);
    return {
      symbol, address: r.address.toBase58(), open: why === null, why, minute: r.market.minuteEnabled, leverage: Number(r.market.tier),
      stake: { min: r.config.params.minCollateral, max: r.config.params.maxCollateral },
      fees: {
        entryBps: Number(r.config.params.entryFeeBps),
        exitWinBps: terms.kind === 'terms' ? terms.entry.winBps : flat,
        exitLossBps: terms.kind === 'terms' ? terms.entry.lossBps : flat,
        keptBps: terms.kind === 'terms'
          ? terms.entry.haircutMoveTenthBp.slice(0, terms.entry.haircutCount).map((m, i) => ({ moveBp: m / 10, keptBps: terms.entry.haircutKeptBps[i]! }))
          : [],
      },
      sideRoom: { long: room('long'), short: room('short') },
    };
  }

  async function preview(order: Order): Promise<Preview> {
    const r = await read(order.market);
    const debit = typeof order.usd === 'bigint' ? order.usd : parseUsdc(order.usd);
    const t = termsFor({ config: r.config, market: r.market, feeTable: r.feeTable, minute: null, nowUnix: r.clock.unix },
      'knockout', order.side, debit, order.target ?? 0, order.timer ?? 0);
    // Priced at a reference entry of 1: both ends are distances from the entry, so any entry gives the same payouts.
    const at = { ...t, engine: { ...t.engine, entryPrice: scaled(1) } };
    const micro = Number(MICRO_PER_BP);
    return {
      market: order.market, side: order.side, debit, stake: t.engine.collateral, leverage: Number(t.engine.tier),
      barrierBps: Number(barrierMicroBps(t.engine.tier, t.engine.muBps)) / micro,
      target: order.target ? order.target : null, targetBps: order.target ? Number(t.engine.takeProfit) / micro : null,
      timer: order.timer ?? 0, payoutAtTarget: order.target ? payoutAt(at, 1, 'takeProfit') : null, payoutAtBarrier: payoutAt(at, 1, 'knockout'),
    };
  }

  /** One transaction for every order given: the book is created first when the wallet has none. */
  async function buildOpen(orders: Order | Order[]): Promise<Bundle> {
    const list = Array.isArray(orders) ? orders : [orders];
    const r = await read(list[0]!.market);
    const why = closedWhy(r.config, r.market, r.clock.unix);
    if (why !== null) throw new Refusal('venue', 'MARKET_CLOSED', `${list[0]!.market}: ${why}`, true, 60_000);
    const vt = await vaultTokenOf(r.vault);
    const traderToken = toHex(ata(owner, vt.mint));
    const built: BuiltInstruction[] = [];
    if (r.book === null) {
      if (session) throw new Refusal('session', 'NO_BOOK', 'the owner has no book yet: `wheelman session start` creates it');
      built.push(ix.initTraderAccount({
        trader: toHex(owner), payer: toHex(owner), positions: toHex(book), vault: toHex(vaultPda().address),
        vault_token: r.vault.tokenAccount, payout_destination: traderToken,
      }, 12));
    }
    list.forEach((order, n) => {
      const debit = typeof order.usd === 'bigint' ? order.usd : parseUsdc(order.usd);
      const size = sizeForTotal(debit, r.config.params);
      if (size.refusal !== null) throw new Refusal('venue', size.refusal.id, `${size.refusal.label}: ${size.refusal.detail}`);
      built.push(ix.open({
        authority: toHex(authority), trader_token: traderToken, config: toHex(configPda().address), market: toHex(marketPda(assetId(order.market)).address),
        vault: toHex(vaultPda().address), vault_token: r.vault.tokenAccount, protocol_token: r.config.treasury, positions: toHex(book),
        delegate: session ? toHex(delegatePda(owner).address) : null,
      }, {
        budget: debit, direction: order.side === 'long' ? 0 : 1, rung_bps: Math.round((order.target ?? 0) * 10_000), user_timer_s: order.timer ?? 0,
        min_collateral_out: size.collateral, referrer: null, tier: 0, opener_tag: BigInt(Date.now()) * 100n + BigInt(n + 1),
      }, priceAccountsFor(r.market, r.config, 'open')));
    });
    return bundleOf(built);
  }

  async function buildClose(seq: bigint): Promise<Bundle> {
    const [c, b, k] = await o.rpc.conn.getMultipleAccountsInfo([configPda().address, book, CLOCK], 'confirmed');
    const p = b === null ? null : findBySeq(decodeTraderAccount(new Uint8Array(b.data)), seq);
    if (p === null) throw new Refusal('venue', 'PositionNotFound', `no open position has seq ${seq}`);
    const marketAddress = new PublicKey(toBase58(p.market));
    const m = await o.rpc.conn.getAccountInfo(marketAddress, 'confirmed');
    const from = closableFromSlotOf(p, decodeConfig(new Uint8Array(c!.data)), decodeMarket(new Uint8Array(m!.data)));
    if (from === null || from > clockOf(new Uint8Array(k!.data)).slot) {
      throw new Refusal('venue', 'CLOSE_NOT_YET', `position ${seq} cannot be closed yet (an order, or inside the minimum hold)`, true, 5_000);
    }
    return bundleOf([ix.requestClose({
      authority: toHex(authority), config: toHex(configPda().address), market: toHex(marketAddress), positions: toHex(book),
      delegate: session ? toHex(delegatePda(owner).address) : null,
    }, seq)]);
  }

  async function positions(): Promise<PositionInfo[]> {
    const markets = MARKETS.map((s) => marketPda(assetId(s)).address);
    const [b, k, c, ...m] = await o.rpc.conn.getMultipleAccountsInfo([book, CLOCK, configPda().address, ...markets], 'confirmed');
    if (b === null) return [];
    const clock = clockOf(new Uint8Array(k!.data));
    const config = decodeConfig(new Uint8Array(c!.data));
    const marketOf = new Map(markets.map((a, i) => [toHex(a), m[i] == null ? null : decodeMarket(new Uint8Array(m[i]!.data))]));
    return heldPositions(owner.toBase58(), decodeTraderAccount(new Uint8Array(b.data))).map(({ position: p }) => {
      const filled = p.entryPrice !== 0n;
      const l = filled ? levels(p) : null;
      const mk = marketOf.get(p.market) ?? null;
      return {
        seq: p.seq, market: marketSymbol(p.market), side: sideOf(p.direction), stake: p.collateral,
        entryPrice: filled ? price(p.entryPrice, p.entryExpo) : null,
        barrierPrice: l === null ? null : price(l.barrierPrice, p.entryExpo),
        targetPrice: l?.takeProfitPrice == null ? null : price(l.takeProfitPrice, p.entryExpo),
        state: phase(p, clock.slot), openedAt: Number(p.openedAt),
        timerEndsAt: p.userTimerS === null ? null : Number(p.openedAt) + p.userTimerS,
        closableFromSlot: mk === null ? null : closableFromSlotOf(p, config, mk),
      };
    });
  }

  const settlementOf = (t: ClosedTrade): Settlement => ({
    seq: t.seq, market: marketSymbol(t.market), side: t.direction, stake: t.stake, payout: t.pnl.payout, pnl: t.pnl.payout - t.stake,
    reason: t.reason, settledAt: t.settledAt, signature: t.signature,
  });

  /** Settled positions, newest first. `since` (unix seconds) reads only that far back. */
  async function history(opts: { since?: number; limit?: number } = {}): Promise<Settlement[]> {
    let limit = opts.limit ?? 100;
    if (opts.since !== undefined) {
      const sigs = await o.rpc.conn.getSignaturesForAddress(book, { limit: 1000 }, 'confirmed');
      limit = sigs.filter((s) => (s.blockTime ?? 0) >= opts.since!).length;
      if (limit === 0) return [];
    }
    const config = decodeConfig(new Uint8Array((await o.rpc.conn.getAccountInfo(configPda().address, 'confirmed'))!.data));
    const h = await readTradeHistory(reader, owner, config, { limit });
    return h.trades.filter((t) => opts.since === undefined || (t.settledAt ?? 0) >= opts.since).map(settlementOf);
  }

  /** What a closed position paid, or null while it is open or not found yet. */
  async function settlement(seq: bigint): Promise<Settlement | null> {
    const config = decodeConfig(new Uint8Array((await o.rpc.conn.getAccountInfo(configPda().address, 'confirmed'))!.data));
    const h = await readTradeHistory(reader, owner, config, { limit: 25 });
    const t = h.trades.find((x) => x.seq === seq);
    if (t !== undefined) return settlementOf(t);
    const v = h.voidedOpens.find((x) => x.seq === seq);
    return v === undefined ? null : {
      seq, market: marketSymbol(v.market), side: null, stake: v.stake, payout: v.stakeReturned, pnl: v.stakeReturned - v.stake,
      reason: `returned (${v.reason})`, settledAt: v.blockTime, signature: v.signature,
    };
  }

  return {
    owner,
    market,
    preview,
    positions,
    history,
    settlement,
    async open(orders: Order | Order[]): Promise<Opened> {
      const sent = await transact(sender, await buildOpen(orders), true);
      // The positions this transaction opened: the SDK's receipt keeps only events the venue's own frames emitted.
      const receipt = receiptOf({
        signature: sent.signature!, slot: 0, blockTime: null, err: null, logMessages: sent.logs,
        preTokenBalances: null, postTokenBalances: null, feePayer: null, computeUnits: null, returnData: null,
      });
      const seqs = venueEventsNamed(receipt, 'PositionOpened').map((e) => e.seq);
      return { seq: seqs[0]!, seqs, signature: sent.signature! };
    },
    async close(seq: bigint): Promise<{ signature: string }> {
      return { signature: (await transact(sender, await buildClose(seq), true)).signature! };
    },
    build: { open: buildOpen, close: buildClose },
  };
}

export type KnockoutClient = ReturnType<typeof createKnockoutClient>;

/** Instructions with the compute units the SDK measured for each. */
export function bundleOf(built: BuiltInstruction[], unmeasured = 200_000): Bundle {
  const units = (name: string) => {
    try {
      return computeUnitLimit(name);
    } catch {
      return unmeasured; // the runtime's default for an instruction the SDK does not measure
    }
  };
  const instructions: TransactionInstruction[] = built.map(ourInstruction);
  return { instructions, computeUnits: built.reduce((s, b) => s + units(b.name), 0) };
}
