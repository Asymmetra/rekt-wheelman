// Prices for the strategy's signal. The venue fills every open at its own next price, so the bot
// needs no signed price: any good public price works, and a price from your own Pyth key works too.
// PRICE_SOURCE picks the adapter.
import { readFileSync } from 'node:fs';

export interface Tick {
  market: string;
  price: number;
  /** Milliseconds since 1970. */
  time: number;
}

export interface PriceSource {
  /** The markets this source can price up front. A source that finds its markets at run time lists none. */
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

/** Pyth Pro's three stream endpoints. A client needs one of them; it moves to the next when one fails. */
export const PYTH_ROUTERS: readonly string[] = [
  'wss://pyth-lazer-0.dourolabs.app/v1/stream',
  'wss://pyth-lazer-1.dourolabs.app/v1/stream',
  'wss://pyth-lazer-2.dourolabs.app/v1/stream',
];
/** Pyth's public feed list. It needs no key. */
export const PYTH_SYMBOLS_URL = 'https://pyth.dourolabs.app/v1/symbols';
/** The slowest channel Pyth offers is valid for every feed, and the History keeps one price a second. */
const PYTH_CHANNEL = 'fixed_rate@1000ms';
/** Failures in a row, with no price between them, after which the key is the likely cause and the feed says so. */
const PYTH_GIVE_UP = 6;

export interface PythOptions {
  /** The caller's own Pyth Pro key. It is sent to Pyth and nowhere else, and it is never written to a log. */
  apiKey: string;
  /** Market → Pyth feed id, for a market the public list cannot settle by itself. */
  feeds?: Record<string, number>;
  routers?: readonly string[];
  symbolsUrl?: string;
  Socket?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  /** Milliseconds to wait before reconnecting after `failures` failures in a row. A test passes 0. */
  retryMs?: (failures: number) => number;
}

interface PythListing {
  symbol?: string;
  pyth_lazer_id?: number;
  state?: string;
}

/**
 * The Pyth feed id of one market. The market's symbol is looked up in Pyth's public feed list, and a feed is taken
 * only when exactly one stable feed is quoted in USD under that symbol, so nothing here is a table of markets that
 * can go stale. A market the list cannot settle is refused with the way to name its feed.
 */
export function pythFeedFor(market: string, listing: PythListing[]): number {
  const stable = listing.filter((f) => f.state === 'stable' && typeof f.symbol === 'string' && Number.isInteger(f.pyth_lazer_id));
  const quoted = stable.filter((f) => new RegExp(`^[A-Za-z]+(?:\\.[A-Za-z]+)*\\.${market}/USD$`).test(f.symbol!));
  for (const prefix of ['Crypto', 'Metal']) {
    const own = quoted.filter((f) => f.symbol === `${prefix}.${market}/USD`);
    if (own.length === 1) return own[0]!.pyth_lazer_id!;
  }
  if (quoted.length === 1) return quoted[0]!.pyth_lazer_id!;
  throw new Error(
    quoted.length === 0
      ? `Pyth lists no stable ${market}/USD feed: name one with PYTH_FEEDS=${market}=<Pyth feed id>`
      : `Pyth lists ${quoted.length} ${market}/USD feeds: name the one you want with PYTH_FEEDS=${market}=<Pyth feed id>`,
  );
}

/**
 * Pyth Pro's price stream, with the caller's own key. One connection, one subscription to every market asked for.
 * A market is resolved to a feed id on first use (see pythFeedFor) unless PYTH_FEEDS names it. It reconnects with
 * the same backoff as the exchange feed and moves to the next router. After PYTH_GIVE_UP failures in a row with no
 * price in between it stops and says the key is the likely cause, instead of retrying for ever.
 */
export function pyth(opts: PythOptions): PriceSource {
  const routers = opts.routers ?? PYTH_ROUTERS;
  const Socket = opts.Socket ?? WebSocket;
  const get = opts.fetchImpl ?? fetch;
  const listed = new Map<string, number>(Object.entries(opts.feeds ?? {}));
  const resolve = async (market: string): Promise<number> => {
    const known = listed.get(market);
    if (known !== undefined) return known;
    const res = await get(`${opts.symbolsUrl ?? PYTH_SYMBOLS_URL}?query=${encodeURIComponent(market)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Pyth's feed list answered HTTP ${res.status}: name the feed with PYTH_FEEDS=${market}=<Pyth feed id>`);
    const id = pythFeedFor(market, (await res.json()) as PythListing[]);
    listed.set(market, id);
    return id;
  };
  const source: PriceSource = {
    // Any market Pyth quotes: the list is read when a market is first asked for, not fixed here.
    markets: [],
    async latest(market) {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 15_000);
      try {
        for await (const t of source.ticks([market], stop.signal)) return t;
      } finally {
        clearTimeout(timer);
        stop.abort();
      }
      throw new Error(`no ${market} price from Pyth within 15 s`);
    },
    async *ticks(markets, signal) {
      const marketOf = new Map<number, string>();
      for (const m of markets) marketOf.set(await resolve(m), m);
      const queue: (Tick | Error)[] = [];
      let wake: (() => void) | null = null;
      const push = (t: Tick | Error) => {
        queue.push(t);
        wake?.();
      };
      let failures = 0;
      let attempt = 0;
      let lastServerError = '';
      let current: WebSocket | null = null;
      signal.addEventListener('abort', () => {
        current?.close();
        wake?.();
      }, { once: true });
      const connect = () => {
        if (signal.aborted) return;
        // The key rides the standard subprotocol list; no header and no URL parameter carries it.
        const ws = new Socket(routers[attempt++ % routers.length]!, ['pyth-lazer-auth', opts.apiKey]);
        current = ws;
        let sawPrice = false;
        let watchdog = setTimeout(() => ws.close(), 60_000);
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'subscribe',
            subscriptionId: 1,
            priceFeedIds: [...marketOf.keys()],
            properties: ['price', 'exponent'],
            formats: [],
            channel: PYTH_CHANNEL,
            ignoreInvalidFeeds: false,
          }));
        };
        ws.onmessage = (e) => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => ws.close(), 60_000);
          let m: { type?: string; error?: unknown; parsed?: { timestampUs?: string; priceFeeds?: { priceFeedId?: number; price?: string; exponent?: number }[] } };
          try {
            m = JSON.parse(String(e.data));
          } catch {
            return;
          }
          if (m.type === 'subscriptionError' || m.type === 'error') {
            lastServerError = `${m.type}: ${typeof m.error === 'string' ? m.error.slice(0, 160) : 'unspecified'}`;
            ws.close();
            return;
          }
          if (m.type !== 'streamUpdated' || m.parsed?.priceFeeds === undefined) return;
          const time = Number(m.parsed.timestampUs) / 1000;
          for (const f of m.parsed.priceFeeds) {
            const market = marketOf.get(f.priceFeedId ?? -1);
            if (market === undefined || f.price === undefined || typeof f.exponent !== 'number') continue;
            // Divide for a negative exponent: 4012345 / 1000 is the nearest number to 4012.345, 4012345 * 0.001 is not.
            const price = f.exponent < 0 ? Number(f.price) / 10 ** -f.exponent : Number(f.price) * 10 ** f.exponent;
            if (!(price > 0) || !Number.isFinite(price)) continue;
            sawPrice = true;
            failures = 0;
            push({ market, price, time: Number.isFinite(time) ? time : Date.now() });
          }
        };
        ws.onclose = () => {
          clearTimeout(watchdog);
          if (signal.aborted) return;
          if (!sawPrice && ++failures >= PYTH_GIVE_UP) {
            push(new Error(
              `Pyth closed the connection ${failures} times without sending a price: check that PYTH_API_KEY is a valid Pyth Pro key` +
                (lastServerError === '' ? '' : ` (last message from Pyth: ${lastServerError})`),
            ));
            return;
          }
          const wait = opts.retryMs?.(failures) ?? Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) * (0.75 + Math.random() * 0.5);
          setTimeout(connect, wait);
        };
        ws.onerror = () => ws.close();
      };
      connect();
      while (!signal.aborted) {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
  return source;
}

type Env = Record<string, string | undefined>;

/** The caller's own Pyth key: PYTH_API_KEY, or PYTH_API_KEY_FILE naming a file that holds it. Null when neither is set. */
export function pythKey(env: Env): string | null {
  const direct = env.PYTH_API_KEY?.trim();
  if (direct !== undefined && direct !== '') return direct;
  const path = env.PYTH_API_KEY_FILE?.trim();
  if (path === undefined || path === '') return null;
  let key: string;
  try {
    key = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error('PYTH_API_KEY_FILE names a file this process cannot read');
  }
  if (key === '') throw new Error('PYTH_API_KEY_FILE names an empty file');
  return key;
}

/** PYTH_FEEDS: `BTC=1,XAU=346`. A market the public feed list cannot settle is named here. */
export function pythFeeds(text: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (text ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '')) {
    const m = /^([A-Za-z0-9]+)=(\d+)$/.exec(part);
    if (m === null) throw new Error(`PYTH_FEEDS entry ${part.slice(0, 20)} is not <market>=<feed id>`);
    out[m[1]!.toUpperCase()] = Number(m[2]);
  }
  return out;
}

/**
 * What PRICE_SOURCE means for this environment. `auto` is the preset for a caller who may have a Pyth key: Pyth
 * when a key is set, the public exchange feed when not. Everything else is itself.
 */
export function resolveSourceName(name: string, env: Env): string {
  if (name !== 'auto') return name;
  return pythKey(env) === null ? 'coinbase' : 'pyth';
}

export const PRICE_SOURCES = ['coinbase', 'pyth', 'auto', 'replay'] as const;

export function priceSource(name: string, replayFile: string | undefined, env: Env = {}): PriceSource {
  const which = resolveSourceName(name, env);
  if (which === 'replay') {
    if (replayFile === undefined) throw new Error('PRICE_SOURCE=replay needs REPLAY_FILE');
    return replay(replayFile);
  }
  if (which === 'coinbase') return coinbase();
  if (which === 'pyth') {
    const apiKey = pythKey(env);
    if (apiKey === null) throw new Error('PRICE_SOURCE=pyth needs your Pyth key: set PYTH_API_KEY, or PYTH_API_KEY_FILE');
    return pyth({ apiKey, feeds: pythFeeds(env.PYTH_FEEDS) });
  }
  throw new Error(`PRICE_SOURCE must be ${PRICE_SOURCES.join(', ')}, not ${name}`);
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
