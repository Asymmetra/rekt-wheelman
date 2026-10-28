// Every strategy on fixed price paths. A path is one price a second.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseParam } from '../src/config.ts';
import { History } from '../src/prices.ts';
import { registry, type Intent, type Params, type Position, type Strategy } from '../src/strategies/index.ts';

const all = await registry();
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function params(s: Strategy, over: Record<string, string> = {}): Params {
  const out: Params = {};
  for (const [k, p] of Object.entries(s.params)) {
    const r = parseParam(k, p, over[k] ?? p.default);
    if ('problem' in r) throw new Error(r.problem);
    out[k] = r.value;
  }
  return out;
}

/** Run a strategy over a path. `positions(t)` says what the wallet holds at second t. */
function run(id: string, path: number[], opts: { over?: Record<string, string>; positions?: (t: number) => Position[]; start?: number } = {}) {
  const s = all.get(id)!;
  const p = params(s, opts.over);
  const history = new History(3600_000);
  const memory = {};
  const out: { t: number; intents: Intent[] }[] = [];
  path.forEach((price, t) => {
    const now = (opts.start ?? T0) + t * 1000;
    history.add({ market: 'BTC', price, time: now });
    const intents = s.onTick({
      now, market: 'BTC', price, priceAgo: (x) => history.priceAgo(now, x), range: (x) => history.range(now, x),
      positions: opts.positions?.(t) ?? [], params: p, memory,
    });
    if (intents.length > 0) out.push({ t, intents });
  });
  return out;
}

/** A path from (second, price) corners, straight lines between them. */
function path(...corners: [number, number][]): number[] {
  const out: number[] = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const [ta, pa] = corners[i]!;
    const [tb, pb] = corners[i + 1]!;
    for (let t = ta; t < tb; t++) out.push(pa + ((pb - pa) * (t - ta)) / (tb - ta));
  }
  out.push(corners.at(-1)![1]);
  return out;
}

const held = (side: 'long' | 'short', entry: number | null = 100): Position => ({ id: '7', game: 'knockout', side, stake: 1_000_000n, entry, openedMs: T0, closing: false });

test('knockout-momentum opens with a rise and against nothing on a flat path', () => {
  assert.deepEqual(run('knockout-momentum', path([0, 100], [120, 100])), []);
  const up = run('knockout-momentum', path([0, 100], [40, 100], [50, 100.2], [60, 100.2]));
  assert.equal(up[0]!.intents[0]!.kind, 'open');
  const first = up[0]!.intents[0] as Extract<Intent, { kind: 'open' }>;
  assert.equal(first.side, 'long');
  assert.equal(first.stake, 1_000_000n);
  assert.equal(first.takeProfitX, 2);
  assert.equal(first.timerS, 60);
  // The move first passes 5 bp at second 43 (100.06 against 100).
  assert.equal(up[0]!.t, 43);
  const down = run('knockout-momentum', path([0, 100], [40, 100], [50, 99.8], [60, 99.8]));
  assert.equal((down[0]!.intents[0] as Extract<Intent, { kind: 'open' }>).side, 'short');
});

test('knockout-momentum waits while it holds a position, and for the cooldown after', () => {
  const rise = path([0, 100], [40, 100], [50, 100.1], [100, 100.1], [300, 101]);
  // A position from second 46 to 99 (last seen); the cooldown is 60 s, so the next open is at 159 or later.
  const out = run('knockout-momentum', rise, { over: { trigger_bps: '1', lookback_s: '10' }, positions: (t) => (t >= 46 && t < 100 ? [held('long')] : []) });
  const times = out.map((o) => o.t);
  assert.ok(times.every((t) => t < 46 || t >= 159), `opened at ${times.join(',')}`);
  assert.equal(times.find((t) => t >= 46), 159);
});

test('knockout-fade opens against a sharp move and closes when the price is back', () => {
  const p = path([0, 100], [30, 100], [35, 100.12], [60, 100.12], [70, 99.99], [80, 99.99]);
  const opens = run('knockout-fade', p);
  const first = opens[0]!.intents[0] as Extract<Intent, { kind: 'open' }>;
  assert.equal(first.side, 'short');
  assert.equal(first.timerS, 30);
  // Hold the short from the open on; the close comes once the price is back at the start level.
  const at = opens[0]!.t;
  const withClose = run('knockout-fade', p, { positions: (t) => (t > at ? [held('short', 100.11)] : []) });
  const close = withClose.find((o) => o.intents[0]!.kind === 'close')!;
  assert.deepEqual(close.intents, [{ kind: 'close', id: '7' }]);
  assert.ok(p[close.t]! <= 100, `closed at ${p[close.t]}`);
  assert.deepEqual(run('knockout-fade', p, { over: { close_on_revert: 'no' }, positions: (t) => (t > at ? [held('short', 100.11)] : []) }).filter((o) => o.intents[0]!.kind === 'close'), []);
});

test('knockout-straddle opens a long and a short together in a quiet market only', () => {
  const quiet = run('knockout-straddle', path([0, 100], [100, 100.01]));
  assert.ok(quiet.length > 0);
  const [a, b] = quiet[0]!.intents as Extract<Intent, { kind: 'open' }>[];
  assert.deepEqual([a!.side, b!.side], ['long', 'short']);
  assert.equal(a!.stake, b!.stake);
  assert.equal(a!.group, b!.group);
  assert.equal(quiet[0]!.t, 60); // the first second with a full quiet_s window
  // A 10 bp range is not quiet.
  assert.deepEqual(run('knockout-straddle', path([0, 100], [30, 100.1], [60, 100], [100, 100.1])), []);
});

test('minute-trend takes the side of the move and skips a small one', () => {
  const up = run('minute-trend', path([0, 100], [40, 100.05]));
  assert.deepEqual(up[0]!.intents, [{ kind: 'round', side: 'long', stake: 1_000_000n }]);
  assert.equal((run('minute-trend', path([0, 100], [40, 99.95]))[0]!.intents[0] as { side: string }).side, 'short');
  assert.deepEqual(run('minute-trend', path([0, 100], [40, 100.01])), []); // 1 bp is below min_bps 2
  assert.deepEqual(run('minute-trend', path([0, 100], [40, 100.05]), { positions: () => [held('long')] }), []);
});

test('minute-schedule plays every Nth minute, alternates sides, and keeps to its window', () => {
  const flat = path([0, 100], [600, 100]);
  const plays = run('minute-schedule', flat, { over: { every_n: '2' } });
  assert.deepEqual(plays.map((o) => o.t), [0, 120, 240, 360, 480, 600]);
  assert.deepEqual(plays.map((o) => (o.intents[0] as { side: string }).side).slice(0, 3), ['long', 'short', 'long']);
  assert.deepEqual(run('minute-schedule', flat, { over: { start_hour_utc: '1' } }), []); // the path is at 00:xx UTC
  assert.deepEqual(run('minute-schedule', flat, { positions: () => [held('long')] }), []);
});

test('the template never trades', () => {
  assert.deepEqual(run('template', path([0, 100], [100, 110])), []);
});

test('every parameter default is inside its own bounds', () => {
  for (const s of all.values()) assert.doesNotThrow(() => params(s), s.id);
});
