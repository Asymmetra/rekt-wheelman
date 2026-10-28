// The price adapters: a replay tape, and the public exchange feed against a fake socket.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { History, coinbase, priceSource, replay, type Tick } from '../src/prices.ts';

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
  assert.deepEqual(priceSource('coinbase', undefined).markets, ['BTC', 'ETH', 'SOL', 'XRP']);
  assert.throws(() => priceSource('replay', undefined), /REPLAY_FILE/);
  assert.throws(() => priceSource('other', undefined), /coinbase or replay/);
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
