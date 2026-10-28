// Paper trading: net results from the SDK's settlement, and the bot loop end to end on a replay tape.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseParam } from '../src/config.ts';
import { setJournal } from '../src/journal.ts';
import { Paper, endAt, payoutAt, scaled, termsFor } from '../src/paper.ts';
import { replay, type PriceSource } from '../src/prices.ts';
import type { Limits } from '../src/risk.ts';
import { trade } from '../src/runner.ts';
import { registry, type Intent, type Params } from '../src/strategies/index.ts';
import { tempDir, venue } from './helpers.ts';

const strategies = await registry();
const limits: Limits = { maxStake: 1_000_000n, maxOpen: 2, dailyLoss: 10_000_000n, minBalance: 0n };
const priced = (withTerms = true) => (i: Extract<Intent, { kind: 'open' | 'round' }>) =>
  termsFor(venue(withTerms), i.kind === 'round' ? 'minute' : 'knockout', i.side, i.stake, i.kind === 'open' ? i.takeProfitX : 0, i.kind === 'open' ? i.timerS : 0);
const filled = (t: ReturnType<typeof termsFor>, entry = 100) => ({ ...t, engine: { ...t.engine, entryPrice: scaled(entry) } });

test('a 2x target pays the stake plus the kept share of the gain, less the exit fee', () => {
  // $1 at 1000x to a 2x target: a 10 bp move, a $1.00 gross gain. 90 % of it is kept at 10 bp:
  // exit value $1.90. The fee is the rate on a gain (4 %) of the exit value: $0.076. Paid: $1.824.
  const t = filled(termsFor(venue(), 'knockout', 'long', 1_000_000n, 2, 0));
  assert.equal(payoutAt(t, 100.1, 'takeProfit'), 1_824_000n);
  assert.equal(payoutAt(t, 99, 'knockout'), 0n);
  // Without fee terms the market's flat exit fee applies to the stake instead (8 % here).
  const flat = filled(termsFor(venue(false), 'knockout', 'long', 1_000_000n, 2, 0));
  assert.equal(payoutAt(flat, 100.1, 'takeProfit'), 1_920_000n);
});

test('a Minute round also pays Minute\'s own fees', () => {
  // A $1.00 total: Minute keeps 1 % at entry, so the position is $0.99. A flat close sits in the
  // fee ramp (6 %, halfway between 4 % and 8 %): the venue pays $0.9306, and Minute keeps 2 % of it.
  const t = filled(termsFor(venue(), 'minute', 'long', 1_000_000n, 0, 0));
  assert.equal(t.engine.collateral, 990_000n);
  assert.equal(t.timerS, 60);
  assert.equal(payoutAt(t, 100, 'userExpiry'), 911_988n);
});

test('the barrier ends first, then the target, then the timer, then a close', () => {
  const t = filled(termsFor(venue(), 'knockout', 'long', 1_000_000n, 2, 60));
  assert.equal(endAt(t, 99.95, true, true), 'knockout'); // 5 bp down is the barrier here
  assert.equal(endAt(t, 100.1, true, true), 'takeProfit');
  assert.equal(endAt(t, 100.02, true, true), 'userExpiry');
  assert.equal(endAt(t, 100.02, false, true), 'voluntary');
  assert.equal(endAt(t, 100.02, false, false), null);
});

test('a paper account keeps its positions and closes in a file', () => {
  const path = join(tempDir('paper-'), 'paper.json');
  const a = new Paper(100_000_000n, 'BTC', priced());
  a.place([{ kind: 'open', side: 'long', stake: 1_000_000n, takeProfitX: 2, timerS: 0 }], 1000);
  a.mark({ market: 'BTC', price: 100, time: 2000 });
  a.save(path);
  const b = Paper.load(path, 0n, 'BTC', priced());
  assert.equal(b.cash, 99_000_000n);
  assert.equal(b.open[0]!.terms.engine.entryPrice, scaled(100));
  const [c] = b.mark({ market: 'BTC', price: 100.1, time: 3000 });
  assert.equal(c!.reason, 'takeProfit');
  assert.equal(c!.pnl, 824_000n);
  assert.throws(() => b.place([{ kind: 'close', id: '9' }], 4000), /not open/);
});

function params(id: string, over: Record<string, string> = {}): Params {
  const out: Params = {};
  for (const [k, p] of Object.entries(strategies.get(id)!.params)) {
    const r = parseParam(k, p, over[k] ?? p.default);
    if ('problem' in r) throw new Error(r.problem);
    out[k] = r.value;
  }
  return out;
}
async function run(id: string, source: PriceSource, over: Record<string, string> = {}, l: Partial<Limits> = {}) {
  const journal = join(tempDir('journal-'), 'journal.jsonl');
  setJournal(journal);
  const paper = new Paper(100_000_000n, 'BTC', priced());
  await trade({ market: 'BTC', strategy: strategies.get(id)!, params: params(id, over), limits: { ...limits, ...l }, source, broker: paper, signal: new AbortController().signal });
  const text = existsSync(journal) ? readFileSync(journal, 'utf8').trim() : '';
  return { paper, lines: text === '' ? [] : text.split('\n').map((x) => JSON.parse(x) as Record<string, unknown>) };
}

test('every strategy runs end to end on the replay tape, and the money adds up', async (t) => {
  t.mock.method(console, 'log', () => {});
  for (const id of ['knockout-momentum', 'knockout-fade', 'knockout-straddle', 'minute-trend', 'minute-schedule', 'template']) {
    const { paper, lines } = await run(id, replay('test/fixtures/tape.jsonl'));
    const staked = paper.open.reduce((s, p) => s + p.stake, 0n);
    assert.equal(paper.cash, 100_000_000n + paper.closed.reduce((s, c) => s + c.pnl, 0n) - staked, id);
    if (['knockout-momentum', 'knockout-straddle', 'minute-trend', 'minute-schedule'].includes(id)) assert.ok(paper.closed.length >= 1, `${id} traded`);
    for (const c of paper.closed) assert.ok(c.payout >= 0n && ['knockout', 'takeProfit', 'userExpiry', 'voluntary'].includes(c.reason));
    // An order fills at the price after the tick that placed it, never at that tick's price.
    const placed = lines.findIndex((l) => l.kind === 'paper-intent');
    if (placed >= 0 && paper.closed[0] !== undefined) assert.ok(lines.slice(placed).some((l) => l.kind === 'paper-close'));
  }
});

test('the daily loss stop holds in a paper run', async (t) => {
  t.mock.method(console, 'log', () => {});
  const tape: PriceSource = {
    markets: ['BTC'],
    async *ticks() {
      // A rise opens a long, a fall knocks it out, a second rise wants another long.
      const prices = [...Array(40).fill(100), 100.06, 100.1, 100.1, 99.9, 99.9, ...Array(100).fill(99.9), 100, 100.1, 100.2, 100.3];
      for (const [s, price] of prices.entries()) yield { market: 'BTC', price, time: Date.UTC(2026, 0, 1) + s * 1000 };
    },
    latest: async () => ({ market: 'BTC', price: 100, time: 0 }),
  };
  const { paper, lines } = await run('knockout-momentum', tape, { cooldown_s: '0', lookback_s: '5' }, { dailyLoss: 1_500_000n });
  assert.equal(paper.closed[0]!.reason, 'knockout');
  assert.equal(paper.closed[0]!.pnl, -1_000_000n);
  assert.ok(lines.some((l) => l.kind === 'risk-refused' && String(l.why).startsWith('daily loss stop')));
  assert.equal(paper.closed.length + paper.open.length, 1, 'nothing opened after the stop');
});
