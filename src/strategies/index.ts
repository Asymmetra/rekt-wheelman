// The strategy contract and the registry. A strategy reads prices and its own positions and returns
// intents. It sends nothing: the risk guard checks every intent, then the venue sends it.
import { knockoutFade, knockoutMomentum, knockoutStraddle } from './knockout.ts';
import { minuteSchedule, minuteTrend } from './minute.ts';
import { template } from './template.ts';

export type Game = 'knockout' | 'minute';
export type Side = 'long' | 'short';

/** What a strategy asks for. Money is bigint USDC base units (1_000_000n is one dollar). */
export type Intent =
  /** Knockout: open one position. `takeProfitX` 0 is no target of its own; `timerS` 0 is no timer. */
  | { kind: 'open'; side: Side; stake: bigint; takeProfitX: number; timerS: number; group?: string }
  /** Knockout: ask the venue to close the position with this id (its `seq`). */
  | { kind: 'close'; id: string }
  /** Minute: open one round. */
  | { kind: 'round'; side: Side; stake: bigint };

/** One open position or live round of this wallet on the bot's market, as the chain shows it. */
export interface Position {
  id: string;
  game: Game;
  side: Side;
  stake: bigint;
  /** null while the open is an order that waits for its price. */
  entry: number | null;
  openedMs: number;
  /** A close was requested; the venue completes it. */
  closing: boolean;
}

export interface Context {
  /** Milliseconds since 1970. In a replay this is the tape's time. */
  now: number;
  market: string;
  price: number;
  /** The last price at or before `now - seconds`, or null while the history is shorter. */
  priceAgo(seconds: number): number | null;
  /** The lowest and highest price over the last `seconds`, or null while the history is shorter. */
  range(seconds: number): { low: number; high: number } | null;
  positions: Position[];
  params: Params;
  /** Free memory for the strategy. It lasts as long as the process. */
  memory: Record<string, unknown>;
}

export type Params = Record<string, number | bigint | string>;

/** A parameter: its default, its bounds, one line of help. Values are written as in `.env`. */
export type Param =
  | { kind: 'usdc'; default: string; min: string; max: string; help: string }
  | { kind: 'number'; default: string; min: number; max: number; zeroOff?: boolean; help: string }
  | { kind: 'choice'; default: string; choices: string[]; help: string };

export interface Strategy {
  id: string;
  game: Game;
  description: string;
  params: Record<string, Param>;
  onTick(ctx: Context): Intent[];
}

/** The signed move from `from` to `to`, in basis points. */
export const moveBps = (from: number, to: number): number => ((to - from) / from) * 10_000;

/**
 * The registry: the built-in strategies, plus every strategy exported as `strategies` by the
 * modules listed in EXTRA_STRATEGIES. Add your own there without editing this file.
 */
export async function registry(extraModules: string[] = []): Promise<Map<string, Strategy>> {
  const builtIn = [knockoutMomentum, knockoutFade, knockoutStraddle, minuteTrend, minuteSchedule, template];
  const all = new Map(builtIn.map((s) => [s.id, s]));
  for (const path of extraModules) {
    const mod = (await import(new URL(path, `file://${process.cwd()}/`).href)) as { strategies?: Strategy[] };
    if (!Array.isArray(mod.strategies)) throw new Error(`${path} exports no "strategies" array`);
    for (const s of mod.strategies) {
      if (all.has(s.id)) throw new Error(`two strategies are named ${s.id}`);
      all.set(s.id, s);
    }
  }
  return all;
}
