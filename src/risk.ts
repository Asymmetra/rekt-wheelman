// The risk guard: the one gate between a strategy's intents and a send. It never blocks a close.
// It counts the worst case: every open stake can be lost, so a limit is never passed after the fact.
import type { Intent } from './strategies/index.ts';

export interface Limits {
  /** The largest stake of one position or round. */
  maxStake: bigint;
  /** The most positions and live rounds at once. */
  maxOpen: number;
  /** Stop opening when today's loss (UTC), plus every open stake, would pass this. */
  dailyLoss: bigint;
  /** Never let the wallet's USDC drop below this, even if every open stake is lost. */
  minBalance: bigint;
}

/** What the chain says about the wallet now. */
export interface Book {
  open: number;
  /** The sum of the stakes of the open positions and live rounds. */
  atStake: bigint;
  /** USDC in the wallet. */
  free: bigint;
  /** USDC owed to the wallet and not yet in it (an unclaimed payout, Minute custody). */
  held: bigint;
  /** Realized profit and loss since 00:00 UTC. */
  todayPnl: bigint;
  /** SOL in the wallet, for fees and rent. */
  sol: number;
}

export const MIN_SOL = 0.01;

export interface Verdict {
  allowed: Intent[];
  refused: { intent: Intent; why: string }[];
}

export function guard(intents: Intent[], book: Book, limits: Limits): Verdict {
  const allowed: Intent[] = [];
  const refused: Verdict['refused'] = [];
  let open = book.open;
  let atStake = book.atStake;
  let free = book.free;
  const lossToday = book.todayPnl < 0n ? -book.todayPnl : 0n;

  const why = (stake: bigint): string | null => {
    if (stake <= 0n) return 'the stake is not positive';
    if (stake > limits.maxStake) return `the stake is above MAX_STAKE_USDC (${usd(limits.maxStake)})`;
    if (open + 1 > limits.maxOpen) return `MAX_OPEN (${limits.maxOpen}) positions are open`;
    if (lossToday + atStake + stake > limits.dailyLoss) {
      return `daily loss stop: lost ${usd(lossToday)} today, ${usd(atStake)} at stake, limit ${usd(limits.dailyLoss)}`;
    }
    if (stake > free) return `the wallet holds ${usd(free)} USDC`;
    if (free + book.held - stake < limits.minBalance) return `MIN_BALANCE_USDC (${usd(limits.minBalance)}) would be passed`;
    if (book.sol < MIN_SOL) return `the wallet holds ${book.sol} SOL; fees and rent need ${MIN_SOL}`;
    return null;
  };

  // Intents that share a group (the two sides of a straddle) pass together or not at all.
  const groups = new Map<string, Intent[]>();
  intents.forEach((intent, i) => {
    const key = intent.kind === 'open' && intent.group !== undefined ? `group ${intent.group}` : `intent ${i}`;
    groups.set(key, [...(groups.get(key) ?? []), intent]);
  });
  for (const members of groups.values()) {
    const before = { open, atStake, free };
    let refusal: string | null = null;
    for (const intent of members) {
      if (intent.kind === 'close') continue;
      refusal = why(intent.stake);
      if (refusal !== null) break;
      open += 1;
      atStake += intent.stake;
      free -= intent.stake;
    }
    if (refusal === null) allowed.push(...members);
    else {
      ({ open, atStake, free } = before);
      for (const intent of members) refused.push({ intent, why: refusal });
    }
  }
  return { allowed, refused };
}

export const usd = (n: bigint): string => {
  const sign = n < 0n ? '-' : '';
  const a = n < 0n ? -n : n;
  return `${sign}$${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, '0').slice(0, 2)}`;
};
