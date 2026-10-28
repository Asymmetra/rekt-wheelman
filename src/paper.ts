// Paper trading: the same commands, risk guard and loop, against simulated fills. Nothing is sent.
// Every result is priced by the SDK's own settlement arithmetic (`settle`), with the terms a real
// position freezes at open: the barrier, the target, the exit fee and the market's fee terms (the
// share of a gain the venue keeps). A Minute round also pays Minute's own fees. Two things differ
// from live: the fill is the next price the bot sees (not the venue's), and a one-shot command
// checks the barrier only at the prices it sees (`wheelman run --paper` sees every tick).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assetId, barrierMicroBps, collateralForTotal, configPda, decodeConfig, decodeFeeTermsTable, decodeMarket, feeTermsTablePda, marketPda, exitFeeBpsFor, favourableMove, governedFrom, openFeeTerms, openPreview, settle, sizeForTotal,
  type ConfigView, type FeeTerms, type FeeTermsTableView, type MarketView, type Position as Engine,
} from '@rekt-trading/1000x';
import { decodeMinuteConfig, minuteConfigPda, type MinuteConfigView } from '@rekt-trading/1000x'; // Minute's API ships in the same package
import { CLOCK, type Rpc } from './rpc.ts';
import { Refusal } from './errors.ts';
import { log } from './journal.ts';
import type { Tick } from './prices.ts';
import { usd, type Book } from './risk.ts';
import type { Broker } from './runner.ts';
import type { Game, Intent, Position, Side } from './strategies/index.ts';

type Governed = ReturnType<typeof governedFrom>;

/** What a position freezes when it opens: everything `settle` needs to price its end. */
export interface Terms {
  engine: Engine;
  feeTerms: FeeTerms | null;
  governed: Governed;
  /** Minute's own fees, in bps of the round's total, or null for a Knockout position. */
  minute: { entryBps: number; exitBps: number } | null;
  timerS: number;
}

/** The venue state that prices an open: read once from the chain. */
export interface Venue {
  config: ConfigView;
  market: MarketView;
  feeTable: FeeTermsTableView | null;
  minute: MinuteConfigView | null;
  nowUnix: bigint;
}

/** The venue state that prices a paper open, in one read. */
export async function readVenue(rpc: Rpc, symbol: string): Promise<Venue> {
  const market = marketPda(assetId(symbol)).address;
  const [c, m, f, mc, k] = await rpc.conn.getMultipleAccountsInfo(
    [configPda().address, market, feeTermsTablePda(market).address, minuteConfigPda().address, CLOCK], 'confirmed');
  if (c === null) throw new Refusal('config', 'VENUE_MISSING', 'the venue config is missing: is RPC_URL a mainnet endpoint?');
  if (m === null) throw new Refusal('config', 'NO_SUCH_MARKET', `${symbol} is not listed on the venue`);
  return {
    config: decodeConfig(new Uint8Array(c.data)), market: decodeMarket(new Uint8Array(m.data)),
    feeTable: f === null ? null : decodeFeeTermsTable(new Uint8Array(f.data)), minute: mc === null ? null : decodeMinuteConfig(new Uint8Array(mc.data)),
    nowUnix: Buffer.from(k!.data).readBigInt64LE(32),
  };
}

/** Prices are numbers outside the engine and bigint inside it, on one fixed scale. */
export const scaled = (price: number): bigint => BigInt(Math.round(price * 1e8));

/**
 * The terms an open of `total` (what leaves the wallet) freezes now. A Minute round takes Minute's
 * own target, timer and leverage, and pays Minute's entry fee from inside the total.
 */
export function termsFor(v: Venue, game: Game, side: Side, total: bigint, takeProfitX: number, timerS: number): Terms {
  const p = v.config.params;
  const m = game === 'minute' ? v.minute : null;
  if (game === 'minute' && m === null) throw new Refusal('venue', 'MINUTE_MISSING', 'the Minute config is missing');
  let collateral: bigint;
  if (m !== null) {
    collateral = collateralForTotal(total - (total * BigInt(m.params.entryFeeBps)) / 10_000n, p.entryFeeBps).collateral;
  } else {
    const size = sizeForTotal(total, p);
    if (size.refusal !== null) throw new Refusal('venue', size.refusal.id, `${size.refusal.label}: ${size.refusal.detail}`);
    collateral = size.collateral;
  }
  const rungBps = m !== null ? m.params.rungBps : Math.round(takeProfitX * 10_000);
  const timer = m !== null ? m.params.initialTimerS : timerS;
  const preview = openPreview(v.config, v.market, collateral, rungBps, v.nowUnix, timer > 0 ? timer : null, m?.params.tier ?? 0);
  const fee = openFeeTerms(v.config, v.market, v.feeTable);
  // An open under fee terms freezes the terms' loss rate as its exit-fee bound; otherwise the market's
  // rate, or the venue's. (The program's rule; the SDK has no builder for an open's engine position.)
  const exitFeeBps = fee.kind === 'terms' ? BigInt(fee.entry.lossBps) : exitFeeBpsFor(BigInt(v.market.exitFeeBps), p.exitFeeBps);
  return {
    // Built the way the SDK builds an engine position from a book slot.
    engine: {
      collateral, tier: preview.tier as Engine['tier'], direction: side, entryPrice: 0n, muBps: p.muBps,
      exitFeeBps, payoutCapMultiple: p.payoutCapMultiple,
      takeProfit: preview.takeProfitMicroBp, rungBps, userTimerSet: timer > 0,
    },
    feeTerms: fee.kind === 'terms' ? fee.entry : null,
    governed: governedFrom(v.config, v.nowUnix),
    minute: m === null ? null : { entryBps: m.params.entryFeeBps, exitBps: m.params.exitFeeBps },
    timerS: timer,
  };
}

export type EndReason = 'knockout' | 'takeProfit' | 'userExpiry' | 'voluntary';

/** What the trader receives at `price` for `reason`: the SDK's settlement, net of every fee it models. */
export function payoutAt(t: Terms, price: number, reason: EndReason): bigint {
  const terminal = reason === 'knockout' ? 'knockedOut' : reason === 'takeProfit' ? 'tookProfit' : 'live';
  const paid = settle(t.engine, scaled(price), reason, t.governed, terminal, 'current', undefined, t.feeTerms ?? undefined).payouts.trader;
  return t.minute === null ? paid : paid - (paid * BigInt(t.minute.exitBps)) / 10_000n;
}

/** Which end, if any, this price brings: the barrier first, then the target, the timer, a close. */
export function endAt(t: Terms, price: number, timerDue: boolean, closeDue: boolean): EndReason | null {
  const moved = favourableMove(t.engine, scaled(price));
  if (moved <= -barrierMicroBps(t.engine.tier, t.engine.muBps)) return 'knockout';
  if (t.engine.takeProfit !== null && moved >= t.engine.takeProfit) return 'takeProfit';
  if (timerDue) return 'userExpiry';
  if (closeDue) return 'voluntary';
  return null;
}

export interface PaperPosition extends Position {
  market: string;
  placedAt: number;
  closeAt: number | null;
  terms: Terms;
}

export interface PaperClose {
  id: string;
  game: Game;
  market: string;
  side: Side;
  stake: bigint;
  entry: number;
  exit: number;
  reason: EndReason;
  payout: bigint;
  pnl: bigint;
  time: number;
}

/** A paper account. `price` freezes the venue's terms for each open. */
export class Paper implements Broker {
  cash: bigint;
  open: PaperPosition[] = [];
  closed: PaperClose[] = [];
  seq = 0;
  market: string;
  price: (i: Extract<Intent, { kind: 'open' | 'round' }>) => Terms;

  constructor(cash: bigint, market: string, price: (i: Extract<Intent, { kind: 'open' | 'round' }>) => Terms) {
    this.cash = cash;
    this.market = market;
    this.price = price;
  }

  /** Fill every order placed before this tick at its price, and end what this price ends. */
  mark(t: Tick): PaperClose[] {
    const done: PaperClose[] = [];
    for (const p of [...this.open]) {
      if (p.market !== t.market) continue;
      if (p.entry === null) {
        if (t.time > p.placedAt) {
          p.entry = t.price;
          p.openedMs = t.time;
          p.terms.engine.entryPrice = scaled(t.price);
        }
        continue;
      }
      const timerDue = p.terms.timerS > 0 && t.time >= p.openedMs + p.terms.timerS * 1000;
      const reason = endAt(p.terms, t.price, timerDue, p.closeAt !== null && t.time > p.closeAt);
      if (reason === null) continue;
      const payout = payoutAt(p.terms, t.price, reason);
      this.open.splice(this.open.indexOf(p), 1);
      this.cash += payout;
      const c: PaperClose = { id: p.id, game: p.game, market: p.market, side: p.side, stake: p.stake, entry: p.entry, exit: t.price, reason, payout, pnl: payout - p.stake, time: t.time };
      this.closed.push(c);
      done.push(c);
    }
    return done;
  }

  /** Place orders and close requests. Returns the ids of the orders placed. */
  place(intents: Intent[], now: number): string[] {
    const ids: string[] = [];
    for (const i of intents) {
      if (i.kind === 'close') {
        const p = this.open.find((x) => x.id === i.id);
        if (p === undefined) throw new Refusal('paper', 'NO_SUCH_POSITION', `paper position ${i.id} is not open`);
        if (p.entry === null) throw new Refusal('paper', 'NOT_FILLED', `paper position ${i.id} is an order that waits for its price`, true, 5_000);
        p.closeAt ??= now;
        p.closing = true;
        continue;
      }
      if (i.stake > this.cash) throw new Refusal('paper', 'NOT_ENOUGH_USDC', `the paper account holds ${usd(this.cash)}`);
      const terms = this.price(i);
      const id = String(++this.seq);
      this.open.push({
        id, game: i.kind === 'round' ? 'minute' : 'knockout', market: this.market, side: i.side, stake: i.stake, entry: null,
        openedMs: now, closing: false, placedAt: now, closeAt: null, terms,
      });
      this.cash -= i.stake;
      ids.push(id);
    }
    return ids;
  }

  positions(): Position[] {
    return this.open.map(({ id, game, side, stake, entry, openedMs, closing }) => ({ id, game, side, stake, entry, openedMs, closing }));
  }

  /** Today's result (UTC), from the paper account's own closes. */
  realizedSince(sinceMs: number): bigint {
    return this.closed.filter((c) => c.time >= sinceMs).reduce((s, c) => s + c.pnl, 0n);
  }

  book(todayPnl: bigint): Book {
    return { open: this.open.length, atStake: this.open.reduce((s, p) => s + p.stake, 0n), free: this.cash, held: 0n, todayPnl, sol: 1 };
  }

  // The Broker interface, so the loop runs on paper unchanged.
  async onTick(t: Tick): Promise<bigint> {
    let pnl = 0n;
    for (const c of this.mark(t)) {
      pnl += c.pnl;
      log('paper-close', { ...c, stake: usd(c.stake), payout: usd(c.payout), pnl: usd(c.pnl) });
    }
    return pnl;
  }

  async beforeAct(): Promise<void> {}

  async execute(intents: Intent[], now: number): Promise<number> {
    try {
      const ids = this.place(intents, now);
      for (const { kind, ...i } of intents) log('paper-intent', { intent: kind, ...i, ...('stake' in i ? { stake: usd(i.stake) } : {}) });
      if (ids.length > 0) log('paper-open', { ids });
      return 0;
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      log('refused', { code: e.code, message: e.message });
      return now + e.waitMs;
    }
  }

  /** Counts and the result: facts about this paper account, not a forecast. */
  summary() {
    const by = (reason: string) => this.closed.filter((c) => c.reason === reason).length;
    return {
      opened: this.closed.length + this.open.length, closed: this.closed.length, open: this.open.length,
      knockout: by('knockout'), takeProfit: by('takeProfit'), timer: by('userExpiry'), close: by('voluntary'),
      result: this.closed.reduce((s, c) => s + c.pnl, 0n), usdc: this.cash,
    };
  }

  // A paper account kept in a file, for one-shot commands. bigint is written as "123n".
  static load(path: string, cash: bigint, market: string, price: Paper['price']): Paper {
    const paper = new Paper(cash, market, price);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return paper;
    }
    const s = JSON.parse(text, (_k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Pick<Paper, 'cash' | 'open' | 'closed' | 'seq'>;
    Object.assign(paper, { cash: s.cash, open: s.open, closed: s.closed, seq: s.seq });
    return paper;
  }

  save(path: string): void {
    const state = { cash: this.cash, open: this.open, closed: this.closed, seq: this.seq };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 1));
  }
}
