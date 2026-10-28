// A skeleton for your own strategy. Copy this file, change the id, the parameters and onTick, and
// add it to the list in `registry()` (src/strategies/index.ts), or load it with EXTRA_STRATEGIES.
//
// onTick runs once a second with the latest price. Return the intents you want; return [] to wait.
// The risk guard checks each intent against your limits before anything is sent.
//
//   { kind: 'open', side, stake, takeProfitX, timerS }  a Knockout position (stake in USDC base units)
//   { kind: 'close', id }                               ask the venue to close a Knockout position
//   { kind: 'round', side, stake }                      a Minute round
import type { Strategy } from './index.ts';

export const template: Strategy = {
  id: 'template',
  game: 'knockout',
  description: 'A skeleton that never trades. Copy it to write your own strategy.',
  params: {
    stake_usdc: { kind: 'usdc', default: '1', min: '0.2', max: '1000', help: 'stake per position, in USDC' },
    lookback_s: { kind: 'number', default: '60', min: 5, max: 3600, help: 'a window, in seconds' },
  },
  onTick(ctx) {
    // Everything the strategy may read:
    //   ctx.now, ctx.price, ctx.priceAgo(seconds), ctx.range(seconds)
    //   ctx.positions  this wallet's positions on ctx.market (id, side, stake, entry, openedMs, closing)
    //   ctx.params     the values from PARAM_* in .env, inside the bounds above
    //   ctx.memory     an object you may write to; it lasts as long as the process
    //
    // Example: open a long when the price is above where it was lookback_s ago.
    //   const past = ctx.priceAgo(ctx.params.lookback_s as number);
    //   if (ctx.positions.length === 0 && past !== null && ctx.price > past) {
    //     return [{ kind: 'open', side: 'long', stake: ctx.params.stake_usdc as bigint, takeProfitX: 2, timerS: 60 }];
    //   }
    void ctx;
    return [];
  },
};
