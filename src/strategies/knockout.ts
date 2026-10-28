// Knockout strategies. A position ends at its barrier (the stake is gone), at its take-profit, at its
// own timer, or when the bot asks to close it. The venue's keepers complete every close.
import { moveBps, type Context, type Intent, type Param, type Strategy } from './index.ts';

const stake: Param = { kind: 'usdc', default: '1', min: '0.2', max: '1000', help: 'stake per position, in USDC' };
const takeProfit = (d: string): Param => ({
  kind: 'number', default: d, min: 2, max: 1000, zeroOff: true,
  help: 'take-profit as a multiple of the stake (2 or more), 0 for none',
});
const timeStop = (d: string): Param => ({
  kind: 'number', default: d, min: 26, max: 86_400, zeroOff: true,
  help: 'the position timer in seconds (26 or more): the venue closes the position then; 0 for none',
});
const cooldown = (d: string): Param => ({ kind: 'number', default: d, min: 0, max: 86_400, help: 'seconds to wait after a position ends' });

/** True while the strategy has a position, or ended one less than `cooldown_s` ago. */
function busy(ctx: Context): boolean {
  if (ctx.positions.length > 0) {
    ctx.memory.lastBusy = ctx.now;
    return true;
  }
  const last = ctx.memory.lastBusy as number | undefined;
  return last !== undefined && ctx.now - last < (ctx.params.cooldown_s as number) * 1000;
}

function open(ctx: Context, side: 'long' | 'short', group?: string): Intent {
  return {
    kind: 'open',
    side,
    stake: ctx.params.stake_usdc as bigint,
    takeProfitX: ctx.params.take_profit_x as number,
    timerS: ctx.params.time_stop_s as number,
    ...(group === undefined ? {} : { group }),
  };
}

export const knockoutMomentum: Strategy = {
  id: 'knockout-momentum',
  game: 'knockout',
  description: 'Open in the direction of a move larger than trigger_bps over lookback_s.',
  params: {
    stake_usdc: stake,
    lookback_s: { kind: 'number', default: '30', min: 5, max: 3600, help: 'the window the move is measured over, in seconds' },
    trigger_bps: { kind: 'number', default: '5', min: 1, max: 1000, help: 'the smallest move that opens a position, in basis points' },
    take_profit_x: takeProfit('2'),
    time_stop_s: timeStop('60'),
    cooldown_s: cooldown('60'),
  },
  onTick(ctx) {
    if (busy(ctx)) return [];
    const past = ctx.priceAgo(ctx.params.lookback_s as number);
    if (past === null) return [];
    const move = moveBps(past, ctx.price);
    if (Math.abs(move) < (ctx.params.trigger_bps as number)) return [];
    return [open(ctx, move > 0 ? 'long' : 'short')];
  },
};

export const knockoutFade: Strategy = {
  id: 'knockout-fade',
  game: 'knockout',
  description: 'Open against a sharp move; close when the price is back where the move started.',
  params: {
    stake_usdc: stake,
    lookback_s: { kind: 'number', default: '20', min: 5, max: 3600, help: 'the window the move is measured over, in seconds' },
    trigger_bps: { kind: 'number', default: '10', min: 1, max: 1000, help: 'the smallest move that opens a position, in basis points' },
    take_profit_x: takeProfit('2'),
    time_stop_s: timeStop('30'),
    cooldown_s: cooldown('60'),
    close_on_revert: { kind: 'choice', default: 'yes', choices: ['yes', 'no'], help: 'close when the price returns to where the move started' },
  },
  onTick(ctx) {
    const waiting = busy(ctx);
    const live = ctx.positions.find((p) => p.entry !== null && !p.closing);
    const from = ctx.memory.from as number | undefined;
    if (live && from !== undefined && ctx.params.close_on_revert === 'yes') {
      const back = live.side === 'long' ? ctx.price >= from : ctx.price <= from;
      return back ? [{ kind: 'close', id: live.id }] : [];
    }
    if (waiting) return [];
    const past = ctx.priceAgo(ctx.params.lookback_s as number);
    if (past === null) return [];
    const move = moveBps(past, ctx.price);
    if (Math.abs(move) < (ctx.params.trigger_bps as number)) return [];
    ctx.memory.from = past;
    return [open(ctx, move > 0 ? 'short' : 'long')];
  },
};

export const knockoutStraddle: Strategy = {
  id: 'knockout-straddle',
  game: 'knockout',
  description: 'In a quiet market, open a long and a short of the same stake together.',
  params: {
    stake_usdc: { ...stake, help: 'stake of each side, in USDC' },
    quiet_s: { kind: 'number', default: '60', min: 5, max: 3600, help: 'the window the quiet filter looks at, in seconds' },
    quiet_bps: { kind: 'number', default: '3', min: 0.1, max: 1000, help: 'open only when the range over quiet_s is at most this, in basis points' },
    take_profit_x: takeProfit('3'),
    time_stop_s: timeStop('120'),
    cooldown_s: cooldown('120'),
  },
  onTick(ctx) {
    if (busy(ctx)) return [];
    const r = ctx.range(ctx.params.quiet_s as number);
    if (r === null || moveBps(r.low, r.high) > (ctx.params.quiet_bps as number)) return [];
    const group = `straddle-${ctx.now}`;
    return [open(ctx, 'long', group), open(ctx, 'short', group)];
  },
};
