// Prices for the strategy's signal. The venue fills every open at its own next price, so the bot
// needs no signed price: any good public price works. PRICE_SOURCE picks the adapter.
import { readFileSync } from 'node:fs';

export interface Tick {
  market: string;
  price: number;
  /** Milliseconds since 1970. */
  time: number;
}

export interface PriceSource {
  /** The markets this source can price. */
  markets: string[];
  /** Ticks for `markets` until `signal` aborts. A replay ends at the end of its tape. */
  ticks(markets: string[], signal: AbortSignal): AsyncIterable<Tick>;
  /** The latest price of one market, for a one-shot command. */
  latest(market: string): Promise<Tick>;
}

/**
 * A recorded tape, one JSON object a line: {"time": <ms or ISO text>, "market": "BTC", "price": 1.23}.
 * Lines for other markets are skipped. The bot's clock is the tape's clock.
 */
export function replay(file: string): PriceSource {
  return {
    markets: ['BTC', 'ETH', 'SOL', 'XRP', 'XAU'],
    async *ticks(markets) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [i, line] of lines.entries()) {
        if (line.trim() === '') continue;
        const row = JSON.parse(line) as { time: number | string; market: string; price: number };
        const time = typeof row.time === 'number' ? row.time : Date.parse(row.time);
        if (!Number.isFinite(time) || !(row.price > 0)) throw new Error(`${file} line ${i + 1}: needs a time and a positive price`);
        if (markets.includes(row.market)) yield { market: row.market, price: row.price, time };
      }
    },
    async latest(market) {
      let last: Tick | null = null;
      for await (const t of this.ticks([market], new AbortController().signal)) last = t;
      if (last === null) throw new Error(`${file} has no ${market} price`);
      return last;
    },
  };
}

/**
 * Coinbase Exchange's public ticker websocket. No key and no account. It reconnects with a backoff
 * (1 s, doubling to 30 s, with jitter), and it reconnects when a minute passes with no ticker.
 */
export function coinbase(url = 'wss://ws-feed.exchange.coinbase.com', Socket: typeof WebSocket = WebSocket): PriceSource {
  return {
    markets: ['BTC', 'ETH', 'SOL', 'XRP'],
    async latest(market) {
      const res = await fetch(`https://api.exchange.coinbase.com/products/${market}-USD/ticker`, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json()) as { price?: string };
      if (!res.ok || body.price === undefined) throw new Error(`no ${market} price from the exchange (HTTP ${res.status})`);
      return { market, price: Number(body.price), time: Date.now() };
    },
    async *ticks(markets, signal) {
      const queue: Tick[] = [];
      let wake: (() => void) | null = null;
      const push = (t: Tick) => {
        queue.push(t);
        wake?.();
      };
      let failures = 0;
      let current: WebSocket | null = null;
      signal.addEventListener('abort', () => {
        current?.close();
        wake?.();
      }, { once: true });
      const connect = () => {
        if (signal.aborted) return;
        const ws = new Socket(url);
        current = ws;
        let watchdog = setTimeout(() => ws.close(), 60_000);
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'subscribe', product_ids: markets.map((m) => `${m}-USD`), channels: ['ticker'] }));
        };
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data)) as { type?: string; product_id?: string; price?: string; time?: string };
          if (m.type !== 'ticker' || m.product_id === undefined || m.price === undefined) return;
          failures = 0;
          clearTimeout(watchdog);
          watchdog = setTimeout(() => ws.close(), 60_000);
          const time = m.time === undefined ? Date.now() : Date.parse(m.time);
          push({ market: m.product_id.replace(/-USD$/, ''), price: Number(m.price), time });
        };
        ws.onclose = () => {
          clearTimeout(watchdog);
          if (signal.aborted) return;
          const wait = Math.min(30_000, 1000 * 2 ** failures++) * (0.75 + Math.random() * 0.5);
          setTimeout(connect, wait);
        };
        ws.onerror = () => ws.close();
      };
      connect();
      while (!signal.aborted) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}

export function priceSource(name: string, replayFile: string | undefined): PriceSource {
  if (name === 'replay') {
    if (replayFile === undefined) throw new Error('PRICE_SOURCE=replay needs REPLAY_FILE');
    return replay(replayFile);
  }
  if (name === 'coinbase') return coinbase();
  throw new Error(`PRICE_SOURCE must be coinbase or replay, not ${name}`);
}

/** The recent prices of one market, for priceAgo and range. */
export class History {
  private points: { time: number; price: number }[] = [];
  private keepMs: number;
  constructor(keepMs: number) {
    this.keepMs = keepMs;
  }

  /** Keep one price a second: a later price in the same second replaces the earlier one. */
  add(t: Tick): void {
    const last = this.points.at(-1);
    if (last !== undefined && t.time < last.time) return;
    if (last !== undefined && Math.floor(last.time / 1000) === Math.floor(t.time / 1000)) last.price = t.price;
    else this.points.push({ time: t.time, price: t.price });
    const cut = t.time - this.keepMs;
    let drop = 0;
    while (drop < this.points.length - 1 && this.points[drop + 1]!.time <= cut) drop++;
    if (drop > 0) this.points.splice(0, drop);
  }

  /** The last price at or before `now - seconds`. */
  priceAgo(now: number, seconds: number): number | null {
    const at = now - seconds * 1000;
    let found: number | null = null;
    for (const p of this.points) {
      if (p.time > at) break;
      found = p.price;
    }
    return found;
  }

  range(now: number, seconds: number): { low: number; high: number } | null {
    if (this.priceAgo(now, seconds) === null) return null;
    let low = Infinity;
    let high = -Infinity;
    for (const p of this.points) {
      if (p.time < now - seconds * 1000) continue;
      low = Math.min(low, p.price);
      high = Math.max(high, p.price);
    }
    return low === Infinity ? null : { low, high };
  }
}
