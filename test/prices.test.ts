// The price adapters: a replay tape, and the public exchange feed against a fake socket.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { History, coinbase, priceSource, pyth, pythFeedFor, pythFeeds, pythKey, replay, resolveSourceName, type Tick } from '../src/prices.ts';

const collect = async (it: AsyncIterable<Tick>, n = Infinity) => {
  const out: Tick[] = [];
  for await (const t of it) {
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
};

test('a replay reads its tape in order and keeps only the markets asked for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tape-'));
  const file = join(dir, 'tape.jsonl');
  writeFileSync(file, ['{"time":1000,"market":"BTC","price":10}', '{"time":"1970-01-01T00:00:02Z","market":"ETH","price":2}', '', '{"time":3000,"market":"BTC","price":11}'].join('\n'));
  assert.deepEqual(await collect(replay(file).ticks(['BTC'], new AbortController().signal)), [
    { market: 'BTC', price: 10, time: 1000 },
    { market: 'BTC', price: 11, time: 3000 },
  ]);
  writeFileSync(file, '{"time":1000,"market":"BTC","price":-1}\n');
  await assert.rejects(collect(replay(file).ticks(['BTC'], new AbortController().signal)), /line 1/);
});

test('the fixture tape is one BTC price a second', async () => {
  const ticks = await collect(replay('test/fixtures/tape.jsonl').ticks(['BTC'], new AbortController().signal));
  assert.equal(ticks.length, 361);
  assert.ok(ticks.every((t, i) => i === 0 || t.time - ticks[i - 1]!.time === 1000));
});

test('the exchange feed subscribes to the markets, reads tickers, and reconnects', async () => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      sockets.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }
    send(s: string) {
      this.sent.push(s);
      setTimeout(() => {
        this.onmessage?.({ data: '{"type":"subscriptions"}' });
        this.onmessage?.({ data: '{"type":"ticker","product_id":"BTC-USD","price":"100.5","time":"2026-01-01T00:00:00Z"}' });
        if (sockets.length === 1) this.onclose?.(); // the first connection drops
        else this.onmessage?.({ data: '{"type":"ticker","product_id":"SOL-USD","price":"2.25","time":"2026-01-01T00:00:01Z"}' });
      }, 0);
    }
    close() {}
  }
  const abort = new AbortController();
  const ticks = await collect(coinbase('wss://fake', FakeSocket as unknown as typeof WebSocket).ticks(['BTC', 'SOL'], abort.signal), 3);
  abort.abort();
  assert.deepEqual(JSON.parse(sockets[0]!.sent[0]!), { type: 'subscribe', product_ids: ['BTC-USD', 'SOL-USD'], channels: ['ticker'] });
  assert.equal(sockets.length, 2);
  assert.deepEqual(ticks.map((t) => [t.market, t.price]), [['BTC', 100.5], ['BTC', 100.5], ['SOL', 2.25]]);
  assert.equal(ticks[0]!.time, Date.parse('2026-01-01T00:00:00Z'));
});

test('a price source is picked by name, and an unknown name is refused', () => {
  assert.deepEqual(priceSource('coinbase', undefined).markets, ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE']);
  assert.throws(() => priceSource('replay', undefined), /REPLAY_FILE/);
  assert.throws(() => priceSource('other', undefined), /coinbase, pyth, auto, replay/);
});

test('the history answers priceAgo and range, and forgets what is too old', () => {
  const h = new History(10_000);
  for (let s = 0; s <= 20; s++) h.add({ market: 'BTC', price: 100 + s, time: s * 1000 });
  assert.equal(h.priceAgo(20_000, 5), 115);
  assert.equal(h.priceAgo(20_000, 10), 110);
  assert.equal(h.priceAgo(20_000, 15), null); // older than what it keeps
  assert.deepEqual(h.range(20_000, 3), { low: 117, high: 120 });
  h.add({ market: 'BTC', price: 50, time: 20_500 }); // the same second replaces the price
  assert.equal(h.priceAgo(20_500, 0), 50);
});

// ---- Pyth, with the caller's own key ----

const listing = [
  { symbol: 'Crypto.BTC/USD', pyth_lazer_id: 1, state: 'stable' },
  { symbol: 'Crypto.WBTC/USD', pyth_lazer_id: 77, state: 'stable' },
  { symbol: 'Crypto.XAUT/USD', pyth_lazer_id: 172, state: 'stable' },
  { symbol: 'Metal.XAU/USD', pyth_lazer_id: 346, state: 'stable' },
  { symbol: 'Metal.XAU/USD_DEPRECATED', pyth_lazer_id: 1521, state: 'inactive' },
  { symbol: 'Crypto.Index.XAUM/USD', pyth_lazer_id: 3207, state: 'stable' },
];

test('a market is matched to exactly one stable USD feed, and anything unclear is refused with the way out', () => {
  assert.equal(pythFeedFor('BTC', listing), 1); // not WBTC
  assert.equal(pythFeedFor('XAU', listing), 346); // not XAUT, not the retired feed
  assert.equal(pythFeedFor('XAUM', listing), 3207); // the one feed there is
  assert.throws(() => pythFeedFor('DOGE', listing), /PYTH_FEEDS=DOGE=<Pyth feed id>/);
  const twice = [
    { symbol: 'Equity.US.SPY/USD', pyth_lazer_id: 5, state: 'stable' },
    { symbol: 'Commodity.SPY/USD', pyth_lazer_id: 6, state: 'stable' },
  ];
  assert.throws(() => pythFeedFor('SPY', twice), /2 SPY\/USD feeds/);
});

class PythSocket {
  static made: { url: string; protocols: unknown; sent: string[] }[] = [];
  static script: (n: number, ws: PythSocket) => void = () => {};
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  n: number;
  constructor(url: string, protocols: unknown) {
    this.n = PythSocket.made.push({ url, protocols, sent: this.sent });
    setTimeout(() => this.onopen?.(), 0);
  }
  send(s: string) {
    this.sent.push(s);
    setTimeout(() => PythSocket.script(this.n, this), 0);
  }
  close() {}
}
const frame = (id: number, price: string, exponent: number, us = '1767225600000000') =>
  JSON.stringify({ type: 'streamUpdated', subscriptionId: 1, parsed: { timestampUs: us, priceFeeds: [{ priceFeedId: id, price, exponent }] } });
const fakeList = (async () => ({ ok: true, status: 200, json: async () => listing })) as unknown as typeof fetch;

test('the Pyth feed sends the key as the subscription protocol, subscribes by feed id, and reads decimal prices', async () => {
  PythSocket.made = [];
  PythSocket.script = (n, ws) => {
    if (n === 1) {
      ws.onmessage?.({ data: '{"type":"subscribed","subscriptionId":1}' });
      ws.onmessage?.({ data: frame(1, '10050000000000', -8) });
      ws.onclose?.(); // the first router drops
    } else {
      ws.onmessage?.({ data: frame(346, '4012345', -3) });
      ws.onmessage?.({ data: frame(999, '5', 0) }); // a feed nobody asked for
      ws.onmessage?.({ data: JSON.stringify({ type: 'streamUpdated', parsed: { timestampUs: '1', priceFeeds: [{ priceFeedId: 1 }] } }) }); // no price yet
      ws.onmessage?.({ data: frame(1, '10060000000000', -8, '1767225601000000') });
    }
  };
  const src = pyth({ apiKey: 'sekret-pyth-key', Socket: PythSocket as unknown as typeof WebSocket, fetchImpl: fakeList, retryMs: () => 0, routers: ['wss://a', 'wss://b'] });
  const abort = new AbortController();
  const ticks = await collect(src.ticks(['BTC', 'XAU'], abort.signal), 3);
  abort.abort();
  assert.deepEqual(PythSocket.made.map((m) => [m.url, m.protocols]), [['wss://a', ['pyth-lazer-auth', 'sekret-pyth-key']], ['wss://b', ['pyth-lazer-auth', 'sekret-pyth-key']]]);
  const sub = JSON.parse(PythSocket.made[0]!.sent[0]!);
  assert.deepEqual(sub, { type: 'subscribe', subscriptionId: 1, priceFeedIds: [1, 346], properties: ['price', 'exponent'], formats: [], channel: 'fixed_rate@1000ms', ignoreInvalidFeeds: false });
  assert.ok(!JSON.stringify(sub).includes('sekret-pyth-key'));
  assert.deepEqual(ticks.map((t) => [t.market, t.price]), [['BTC', 100500], ['XAU', 4012.345], ['BTC', 100600]]);
  assert.equal(ticks[0]!.time, 1767225600000);
});

test('the Pyth feed stops with a message about the key after repeated refusals, and the message holds no key', async () => {
  PythSocket.made = [];
  PythSocket.script = (_n, ws) => {
    ws.onmessage?.({ data: '{"type":"error","error":"unauthorized"}' });
    ws.onclose?.();
  };
  const src = pyth({ apiKey: 'sekret-pyth-key', feeds: { BTC: 1 }, Socket: PythSocket as unknown as typeof WebSocket, retryMs: () => 0 });
  await assert.rejects(collect(src.ticks(['BTC'], new AbortController().signal)), (e: Error) => {
    assert.match(e.message, /6 times without sending a price: check that PYTH_API_KEY is a valid Pyth Pro key/);
    assert.match(e.message, /unauthorized/);
    assert.ok(!e.message.includes('sekret-pyth-key'));
    return true;
  });
  assert.equal(PythSocket.made.length, 6);
});

test('latest asks Pyth once, returns the first price and does not hang', async () => {
  PythSocket.made = [];
  PythSocket.script = (_n, ws) => ws.onmessage?.({ data: frame(1, '10050000000000', -8) });
  const src = pyth({ apiKey: 'k-abcd', feeds: { BTC: 1 }, Socket: PythSocket as unknown as typeof WebSocket });
  const t = await src.latest('BTC');
  assert.deepEqual([t.market, t.price], ['BTC', 100500]);
});

test('the key comes from PYTH_API_KEY or from a file, feeds are parsed, and auto picks by the key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pythkey-'));
  const file = join(dir, 'key');
  assert.equal(pythKey({}), null);
  assert.equal(pythKey({ PYTH_API_KEY: ' abc ' }), 'abc');
  writeFileSync(file, 'from-file\n');
  assert.equal(pythKey({ PYTH_API_KEY_FILE: file }), 'from-file');
  assert.equal(pythKey({ PYTH_API_KEY: 'direct', PYTH_API_KEY_FILE: file }), 'direct');
  writeFileSync(file, '\n');
  assert.throws(() => pythKey({ PYTH_API_KEY_FILE: file }), /empty file/);
  assert.throws(() => pythKey({ PYTH_API_KEY_FILE: join(dir, 'nope') }), /cannot read/);
  assert.deepEqual(pythFeeds(' btc=1, XAU=346 '), { BTC: 1, XAU: 346 });
  assert.throws(() => pythFeeds('BTC'), /not <market>=<feed id>/);
  assert.equal(resolveSourceName('auto', {}), 'coinbase');
  assert.equal(resolveSourceName('auto', { PYTH_API_KEY: 'k' }), 'pyth');
  assert.equal(resolveSourceName('coinbase', { PYTH_API_KEY: 'k' }), 'coinbase'); // a key never switches an explicit choice
  assert.throws(() => priceSource('pyth', undefined, {}), /needs your Pyth key/);
  assert.deepEqual(priceSource('auto', undefined, {}).markets, ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE']);
  assert.deepEqual(priceSource('auto', undefined, { PYTH_API_KEY: 'k-abcd' }).markets, []);
});
