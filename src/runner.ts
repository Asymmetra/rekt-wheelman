// The bot: prices in, one strategy call a second, the risk guard, then a broker (live or paper).
// `wheelman run` drives it; the one-shot commands call the same broker methods.
import { usd as money, guard, type Book, type Limits } from './risk.ts';
import { balances, collect } from './account.ts';
import { Refusal } from './errors.ts';
import { log } from './journal.ts';
import { History, type PriceSource, type Tick } from './prices.ts';
import type { Handles } from './commands.ts';
import type { Context, Intent, Params, Position, Strategy } from './strategies/index.ts';
import type { Order } from './client.ts';

/** What the loop trades through: the venue (live) or a paper account. */
export interface Broker {
  /** Called on every tick. Returns the realized result of what ended since the last call. */
  onTick(tick: Tick): Promise<bigint>;
  /** This wallet's positions on the bot's market. */
  positions(): Position[];
  book(todayPnl: bigint): Book;
  /** Called right before money moves: a live broker reads the chain again. */
  beforeAct(): Promise<void>;
  /** Carry out the allowed intents. Returns the time until which no new intent is sent (0: none). */
  execute(intents: Intent[], now: number): Promise<number>;
}

/** The slow read that backs up the stream: the bot reads its accounts at least this often. */
const POLL_MS = 30_000;
const utcDay = (ms: number) => Math.floor(ms / 86_400_000);
export const dayStart = (ms = Date.now()) => utcDay(ms) * 86_400;

export async function trade(o: {
  market: string; strategy: Strategy; params: Params; limits: Limits; source: PriceSource; broker: Broker; signal: AbortSignal; todayPnl?: bigint;
}): Promise<void> {
  const history = new History(2 * 3600 * 1000);
  const memory: Record<string, unknown> = {};
  const lastRefusal = new Map<string, number>();
  let todayPnl = o.todayPnl ?? 0n;
  let lastEval = 0;
  let holdUntil = 0;
  let day: number | null = null;
  for await (const tick of o.source.ticks([o.market], o.signal)) {
    if (tick.market !== o.market) continue;
    history.add(tick);
    day ??= utcDay(tick.time);
    if (utcDay(tick.time) !== day) {
      day = utcDay(tick.time);
      todayPnl = 0n;
      log('new-day', {});
    }
    todayPnl += await o.broker.onTick(tick);
    if (tick.time - lastEval < 1000) continue;
    lastEval = tick.time;

    const ctx: Context = {
      now: tick.time, market: o.market, price: tick.price,
      priceAgo: (s) => history.priceAgo(tick.time, s), range: (s) => history.range(tick.time, s),
      positions: o.broker.positions(), params: o.params, memory,
    };
    const intents = o.strategy.onTick(ctx);
    if (intents.length === 0 || tick.time < holdUntil) continue;

    await o.broker.beforeAct();
    const verdict = guard(intents, o.broker.book(todayPnl), o.limits);
    for (const r of verdict.refused) {
      if (tick.time - (lastRefusal.get(r.why) ?? -Infinity) < 60_000) continue;
      lastRefusal.set(r.why, tick.time);
      log('risk-refused', { intent: r.intent.kind, why: r.why });
    }
    if (verdict.allowed.length > 0) holdUntil = Math.max(holdUntil, await o.broker.execute(verdict.allowed, tick.time));
  }
}

/** Positions as a strategy sees them, with their market. */
type Held = Position & { market: string };

/** The live broker: the chain is the state, read on a stream hint, before each send, and every 30 s. */
export class Live implements Broker {
  private h: Handles;
  private market: string;
  private dirty = true;
  private lastRead = 0;
  private lastCollect = 0;
  private realized = 0n;
  private held: Held[] = [];
  private known = new Map<string, bigint>(); // open id -> stake, to see a position end
  private ended = new Map<string, { stake: bigint; tries: number }>();
  private wallet = { usdc: 0n, owed: 0n, custody: 0n, payerSol: 0 };

  constructor(h: Handles, market: string) {
    this.h = h;
    this.market = market;
  }

  wake(): void {
    this.dirty = true;
  }

  async onTick(): Promise<bigint> {
    if (this.dirty || Date.now() - this.lastRead > POLL_MS) await this.refresh();
    const r = this.realized;
    this.realized = 0n;
    return r;
  }

  positions(): Position[] {
    return this.held.filter((p) => p.market === this.market);
  }

  book(todayPnl: bigint): Book {
    return {
      open: this.held.length, atStake: this.held.reduce((s, p) => s + p.stake, 0n),
      free: this.wallet.usdc, held: this.wallet.owed + this.wallet.custody, todayPnl, sol: this.wallet.payerSol,
    };
  }

  async beforeAct(): Promise<void> {
    await this.refresh();
  }

  async execute(intents: Intent[], now: number): Promise<number> {
    let hold = 0;
    for (const batch of batches(intents)) {
      try {
        log('sent', { ...(await sendBatch(this.h, this.market, batch)) });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        log('refused', { category: e.category, code: e.code, message: e.message, retryable: e.retryable });
        hold = Math.max(hold, now + e.waitMs);
      }
    }
    this.dirty = true;
    return hold;
  }

  /** Read the chain, and account for every position that ended since the last read. */
  async refresh(): Promise<void> {
    const [held, b] = await Promise.all([heldBy(this.h), balances(this.h.rpc, this.h.owner, this.h.sender.payer)]);
    this.held = held;
    this.wallet = b;
    this.lastRead = Date.now();
    this.dirty = false;
    const now = new Set(held.map((p) => p.id));
    for (const [id, stake] of this.known) if (!now.has(id)) this.ended.set(id, { stake, tries: 0 });
    this.known = new Map(held.map((p) => [p.id, p.stake]));
    for (const [id, e] of this.ended) {
      const s = this.h.game === 'minute' ? await this.h.minute.settlement(BigInt(id), e.stake) : await this.h.knockout.settlement(BigInt(id));
      if (s !== null) {
        this.realized += s.pnl;
        log('closed', { id, reason: s.reason, payout: money(s.payout), pnl: money(s.pnl) });
        this.ended.delete(id);
      } else if (++e.tries >= 10) {
        // Not found after ten reads: count the whole stake as lost, so the loss stop errs safe.
        this.realized -= e.stake;
        log('closed', { id, reason: 'not found on chain; counted as a loss', pnl: money(-e.stake) });
        this.ended.delete(id);
      }
    }
    if (b.owed + b.custody > 0n && Date.now() - this.lastCollect > 300_000) {
      this.lastCollect = Date.now();
      try {
        const c = await collect(this.h.sender, this.h.owner, true);
        if (c !== null) log('collected', { signature: c.signature });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        log('refused', { category: e.category, code: e.code, message: e.message });
      }
    }
  }
}

/** Every position and live round of the wallet, on every market. */
export async function heldBy(h: Handles): Promise<Held[]> {
  if (h.game === 'minute') {
    return (await h.minute.rounds()).map((r) => ({
      id: r.seq.toString(), game: 'minute', market: r.market, side: r.side, stake: r.total, entry: r.entryPrice, openedMs: r.openedAt * 1000, closing: false,
    }));
  }
  return (await h.knockout.positions()).map((p) => ({
    id: p.seq.toString(), game: 'knockout', market: p.market, side: p.side, stake: p.stake, entry: p.entryPrice,
    openedMs: p.openedAt * 1000, closing: p.state.startsWith('Exit') || p.state.startsWith('Stamped'),
  }));
}

/** Today's realized result (UTC), from the chain. */
export async function realizedToday(h: Handles): Promise<bigint> {
  const since = dayStart();
  const list = h.game === 'minute' ? await h.minute.history({ since }) : await h.knockout.history({ since });
  return list.reduce((s, x) => s + x.pnl, 0n);
}

/** Intents that share a group (the two sides of a straddle) go in one transaction. */
function batches(intents: Intent[]): Intent[][] {
  const out = new Map<string, Intent[]>();
  intents.forEach((i, n) => {
    const key = i.kind === 'open' && i.group !== undefined ? `group ${i.group}` : `intent ${n}`;
    out.set(key, [...(out.get(key) ?? []), i]);
  });
  return [...out.values()];
}

const orderOf = (market: string, i: Extract<Intent, { kind: 'open' }>): Order => ({ market, side: i.side, usd: i.stake, target: i.takeProfitX, timer: i.timerS });

/** Send one batch of intents: one transaction. */
export async function sendBatch(h: Handles, market: string, batch: Intent[]) {
  const first = batch[0]!;
  if (first.kind === 'close') return { what: 'close', id: first.id, ...(await h.knockout.close(BigInt(first.id))) };
  if (first.kind === 'round') {
    const r = await h.minute.round({ market, side: first.side, usd: first.stake });
    return { what: 'round', seq: r.seq.toString(), signature: r.signature };
  }
  const orders = batch.filter((i) => i.kind === 'open').map((i) => orderOf(market, i));
  const opened = await h.knockout.open(orders);
  return { what: 'open', signature: opened.signature, seqs: opened.seqs.map(String) };
}
