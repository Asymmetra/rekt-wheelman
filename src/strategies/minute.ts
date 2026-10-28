// Minute strategies. A round runs on Minute's own clock (sixty seconds unless Minute's config says
// otherwise) and has no early exit. The venue's keepers settle every round.
import { moveBps, type Strategy } from './index.ts';

const stake = { kind: 'usdc', default: '1', min: '0.01', max: '100', help: 'the total each round takes from the wallet, in USDC' } as const;

export const minuteTrend: Strategy = {
  id: 'minute-trend',
  game: 'minute',
  description: 'Each round, take the side of the move over lookback_s; skip a move below min_bps.',
  params: {
    stake_usdc: stake,
    lookback_s: { kind: 'number', default: '30', min: 5, max: 3600, help: 'the window the trend is measured over, in seconds' },
    min_bps: { kind: 'number', default: '2', min: 0, max: 1000, help: 'skip the round when the move is smaller than this, in basis points' },
  },
  onTick(ctx) {
    if (ctx.positions.length > 0) return [];
    const past = ctx.priceAgo(ctx.params.lookback_s as number);
    if (past === null) return [];
    const move = moveBps(past, ctx.price);
    if (move === 0 || Math.abs(move) < (ctx.params.min_bps as number)) return [];
    return [{ kind: 'round', side: move > 0 ? 'long' : 'short', stake: ctx.params.stake_usdc as bigint }];
  },
};

export const minuteSchedule: Strategy = {
  id: 'minute-schedule',
  game: 'minute',
  description: 'Play every Nth minute at a fixed stake and side rule, inside a daily UTC window.',
  params: {
    stake_usdc: stake,
    every_n: { kind: 'number', default: '1', min: 1, max: 1440, help: 'play in every Nth minute of the clock' },
    side: { kind: 'choice', default: 'alternate', choices: ['long', 'short', 'alternate'], help: 'the side of each round' },
    start_hour_utc: { kind: 'number', default: '0', min: 0, max: 23, help: 'the first hour of the window (UTC)' },
    end_hour_utc: { kind: 'number', default: '24', min: 1, max: 24, help: 'the hour the window ends (UTC)' },
  },
  onTick(ctx) {
    if (ctx.positions.length > 0) return [];
    const minute = Math.floor(ctx.now / 60_000);
    const hour = new Date(ctx.now).getUTCHours();
    const p = ctx.params as { every_n: number; side: string; start_hour_utc: number; end_hour_utc: number; stake_usdc: bigint };
    if (hour < p.start_hour_utc || hour >= p.end_hour_utc) return [];
    if (minute % p.every_n !== 0 || ctx.memory.lastMinute === minute) return [];
    ctx.memory.lastMinute = minute;
    const played = (ctx.memory.played as number | undefined) ?? 0;
    ctx.memory.played = played + 1;
    const side = p.side === 'alternate' ? (played % 2 === 0 ? 'long' : 'short') : (p.side as 'long' | 'short');
    return [{ kind: 'round', side, stake: p.stake_usdc }];
  },
};
