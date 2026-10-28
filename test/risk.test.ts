// Every risk limit trips, a close is never blocked, and a straddle passes whole or not at all.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guard, type Book, type Limits } from '../src/risk.ts';
import type { Intent } from '../src/strategies/index.ts';

const $ = (d: number) => BigInt(Math.round(d * 1_000_000));
const limits: Limits = { maxStake: $(2), maxOpen: 3, dailyLoss: $(10), minBalance: $(5) };
const book: Book = { open: 0, atStake: 0n, free: $(100), held: 0n, todayPnl: 0n, sol: 1 };
const open = (stake: number, group?: string): Intent => ({ kind: 'open', side: 'long', stake: $(stake), takeProfitX: 2, timerS: 60, ...(group ? { group } : {}) });
const why = (intents: Intent[], b: Partial<Book> = {}, l: Partial<Limits> = {}) =>
  guard(intents, { ...book, ...b }, { ...limits, ...l }).refused.map((r) => r.why);

test('a trade inside every limit passes', () => {
  assert.deepEqual(guard([open(1)], book, limits), { allowed: [open(1)], refused: [] });
});

test('the stake limit trips', () => {
  assert.match(why([open(2.01)])[0]!, /MAX_STAKE_USDC/);
  assert.match(why([open(0)])[0]!, /not positive/);
});

test('the open-positions limit trips, counting this tick too', () => {
  assert.match(why([open(1)], { open: 3 })[0]!, /MAX_OPEN/);
  const r = guard([open(1), open(1), open(1), open(1)], book, limits);
  assert.equal(r.allowed.length, 3);
  assert.match(r.refused[0]!.why, /MAX_OPEN/);
});

test('the daily loss stop counts today\'s loss and every open stake', () => {
  assert.match(why([open(1)], { todayPnl: -$(9.5) })[0]!, /daily loss stop/);
  assert.match(why([open(2)], { todayPnl: -$(7), atStake: $(1.5), open: 1 })[0]!, /daily loss stop/);
  assert.deepEqual(why([open(1)], { todayPnl: $(50) }), []); // a gain does not lift the limit, nor trip it
  assert.deepEqual(why([open(2)], { todayPnl: -$(8) }), []); // exactly at the limit is allowed
});

test('the wallet balance and the minimum balance trip', () => {
  assert.match(why([open(1)], { free: $(0.5) })[0]!, /the wallet holds/);
  assert.match(why([open(2)], { free: $(6) })[0]!, /MIN_BALANCE_USDC/);
  assert.deepEqual(why([open(2)], { free: $(6), held: $(1) }), []); // money owed to the wallet counts
});

test('too little SOL for fees and rent trips', () => {
  assert.match(why([open(1)], { sol: 0.001 })[0]!, /SOL/);
});

test('a close passes when every other limit is tripped', () => {
  const close: Intent = { kind: 'close', id: '9' };
  const r = guard([close, open(1)], { ...book, open: 3, todayPnl: -$(100), free: 0n, sol: 0 }, limits);
  assert.deepEqual(r.allowed, [close]);
  assert.equal(r.refused.length, 1);
});

test('the two sides of a straddle pass together or not at all', () => {
  assert.equal(guard([open(1, 's'), open(1, 's')], book, limits).allowed.length, 2);
  const one = guard([open(1, 's'), open(1, 's')], { ...book, open: 2 }, limits);
  assert.deepEqual(one.allowed, []);
  assert.equal(one.refused.length, 2);
  // A refused group gives back what it took, so the next intent is judged on the real numbers.
  const next = guard([open(1, 's'), open(1, 's'), open(1)], { ...book, open: 1, atStake: $(1) }, { ...limits, maxOpen: 2 });
  assert.deepEqual(next.allowed, [open(1)]);
});
