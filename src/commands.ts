// The commands, one function each. The CLI (src/cli.ts) and the MCP server (src/mcp.ts) call these
// same functions, and `run` drives the same broker, so there is one code path for every surface.
// Each returns plain data: money as USDC text with 6 decimals, ids as text.
import { join } from 'node:path';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { parseUsdc, traderPda } from '@rekt-trading/1000x';
import { USDC_MINT, balances, collect, fileStore, sessionEnd, sessionStart, sessionStatus } from './account.ts';
import { ata, createKnockoutClient, type KnockoutClient, type Side } from './client.ts';
import { MARKETS, parseConfig, type Config, type Needs } from './config.ts';
import { Refusal } from './errors.ts';
import { log, setJournal } from './journal.ts';
import { createMinuteClient, type MinuteClient } from './minute.ts';
import { Paper, readVenue, termsFor, type Venue } from './paper.ts';
import { priceSource, type PriceSource } from './prices.ts';
import { guard, type Book } from './risk.ts';
import { checkCluster, makeRpc, transact, watch, type Rpc, type Sender } from './rpc.ts';
import { Live, dayStart, heldBy, realizedToday, sendBatch, trade } from './runner.ts';
import { registry, type Game, type Intent, type Strategy } from './strategies/index.ts';

export type Env = Record<string, string | undefined>;

/** Arguments, as the CLI flags and the MCP tool inputs name them. */
export interface Args {
  market?: string;
  side?: string;
  usd?: string;
  target?: number;
  timer?: number;
  minute?: boolean;
  id?: string;
  paper?: boolean;
  dryRun?: boolean;
  strategy?: string;
  allowance?: string;
  expires?: string;
  fuel?: number;
}

/** Built once per process. `agent`: the MCP server, which never signs with the owner's key. */
export interface Ctx {
  env: Env;
  strategies: Map<string, Strategy>;
  agent: boolean;
  prices: PriceSource | null;
  rpcs: Map<string, Promise<Rpc>>;
  /** Tests replace the connection: everything above it (config, guard, envelope) runs as usual. */
  connect?: (cfg: Config, game: Game, signer: Keypair | null) => Promise<Handles>;
}

export interface Handles {
  cfg: Config;
  rpc: Rpc;
  owner: PublicKey;
  game: Game;
  sender: Sender;
  knockout: KnockoutClient;
  minute: MinuteClient;
  /** The venue state that prices a paper open (tests give a fixed one). */
  venue: (market: string) => Promise<Venue>;
}

export async function makeCtx(env: Env, agent = false): Promise<Ctx> {
  const extra = (env.EXTRA_STRATEGIES ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return { env, strategies: await registry(extra), agent, prices: null, rpcs: new Map() };
}

/** Parse what the command needs, and connect: the cluster is checked once per endpoint. */
async function handles(ctx: Ctx, needs: Needs, game: Game = 'knockout'): Promise<Handles> {
  const cfg = parseConfig(ctx.env, needs, ctx.strategies);
  setJournal(join(cfg.stateDir, 'journal.jsonl'));
  // An agent signs only with a session key; the owner's key never reaches it.
  const signer = ctx.agent ? cfg.session : (cfg.session ?? cfg.wallet);
  if (ctx.connect !== undefined) return ctx.connect(cfg, game, signer);
  let rpc = ctx.rpcs.get(cfg.rpcUrl);
  if (rpc === undefined) {
    rpc = (async () => {
      const r = makeRpc(cfg);
      await checkCluster(r);
      return r;
    })();
    ctx.rpcs.set(cfg.rpcUrl, rpc);
  }
  const owner = cfg.owner ?? PublicKey.default;
  const o = { rpc: await rpc, owner, signer, maxPriorityFee: cfg.maxPriorityFee, tip: cfg.tip, store: fileStore(cfg.stateDir) };
  return {
    cfg, rpc: o.rpc, owner, game, knockout: createKnockoutClient(o), minute: createMinuteClient(o),
    sender: { rpc: o.rpc, payer: signer?.publicKey ?? owner, signer, maxPriorityFee: cfg.maxPriorityFee, tip: cfg.tip },
    venue: (market) => readVenue(o.rpc, market),
  };
}

export const usdc = (n: bigint): string => {
  const a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, '0')}`;
};
const bad = (message: string) => new Refusal('config', 'BAD_ARGUMENT', message);
const marketArg = (a: Args): string => {
  const m = (a.market ?? '').toUpperCase();
  if (!MARKETS.includes(m)) throw bad(`market must be one of ${MARKETS.join(', ')}`);
  return m;
};
const sideArg = (a: Args): Side => {
  if (a.side !== 'long' && a.side !== 'short') throw bad('side must be long or short');
  return a.side;
};
const usdArg = (a: Args): bigint => {
  try {
    const v = parseUsdc(a.usd ?? '');
    if (v > 0n) return v;
  } catch {
    // refused below
  }
  throw bad('usd must be an amount of USDC above 0, like 1.50');
};
type Spend = Extract<Intent, { kind: 'open' | 'round' }>;
const intentOf = (a: Args): Spend =>
  a.minute === true
    ? { kind: 'round', side: sideArg(a), stake: usdArg(a) }
    : { kind: 'open', side: sideArg(a), stake: usdArg(a), takeProfitX: a.target ?? 0, timerS: a.timer ?? 0 };

// ---- read commands ----

export async function markets(ctx: Ctx) {
  const h = await handles(ctx, {});
  const out = [];
  for (const symbol of MARKETS) {
    try {
      const m = await h.knockout.market(symbol);
      out.push({
        symbol: m.symbol, open: m.open, why: m.why, minute: m.minute, leverage: m.leverage,
        stake: { min: usdc(m.stake.min), max: usdc(m.stake.max) }, fees: m.fees,
        sideRoom: { long: m.sideRoom.long === null ? null : usdc(m.sideRoom.long), short: m.sideRoom.short === null ? null : usdc(m.sideRoom.short) },
      });
    } catch (e) {
      if (!(e instanceof Refusal && e.code === 'NO_SUCH_MARKET')) throw e;
    }
  }
  return out;
}

export async function preview(ctx: Ctx, a: Args) {
  const market = marketArg(a);
  const side = sideArg(a);
  const usd = usdArg(a);
  const h = await handles(ctx, {});
  if (a.minute === true) {
    const p = await h.minute.preview({ market, side, usd });
    return {
      game: 'minute', market, side, total: usdc(p.total), stake: usdc(p.stake), leverage: p.leverage, timer: p.timer, target: p.target,
      payoutAtTarget: p.payoutAtTarget === null ? null : usdc(p.payoutAtTarget), payoutAtBarrier: usdc(p.payoutAtBarrier), minuteFees: p.minuteFees,
    };
  }
  const p = await h.knockout.preview({ market, side, usd, target: a.target ?? 0, timer: a.timer ?? 0 });
  return {
    game: 'knockout', market, side, debit: usdc(p.debit), stake: usdc(p.stake), leverage: p.leverage, barrierBps: p.barrierBps,
    target: p.target, targetBps: p.targetBps, timer: p.timer, payoutAtTarget: p.payoutAtTarget === null ? null : usdc(p.payoutAtTarget), payoutAtBarrier: usdc(p.payoutAtBarrier),
  };
}

export async function positions(ctx: Ctx, a: Args) {
  if (a.paper === true) {
    const h = await handles(ctx, {});
    const { paper, save } = await paperAccount(h, a.market ?? h.cfg.market);
    await markPaper(ctx, paper);
    save();
    return paperView(paper);
  }
  const h = await handles(ctx, { key: 'address' });
  const [k, r, b, today] = await Promise.all([h.knockout.positions(), h.minute.rounds(), balances(h.rpc, h.owner, h.sender.payer), todayResult(h)]);
  return {
    owner: h.owner.toBase58(),
    positions: k.map((p) => ({
      id: p.seq.toString(), market: p.market, side: p.side, stake: usdc(p.stake), entryPrice: p.entryPrice, barrierPrice: p.barrierPrice,
      targetPrice: p.targetPrice, state: p.state, openedAt: p.openedAt, timerEndsAt: p.timerEndsAt,
    })),
    rounds: r.map((x) => ({ id: x.seq.toString(), market: x.market, side: x.side, total: usdc(x.total), entryPrice: x.entryPrice, deadline: x.deadline })),
    balances: { sol: b.sol, usdc: usdc(b.usdc), owed: usdc(b.owed), minuteAccount: usdc(b.custody), feePayerSol: b.payerSol },
    today: usdc(today),
  };
}

const todayResult = async (h: Handles) => (await realizedToday({ ...h, game: 'knockout' })) + (await realizedToday({ ...h, game: 'minute' }));

// ---- trading commands: paper, dry run, or live; every one through the risk guard ----

export async function open(ctx: Ctx, a: Args) {
  const market = marketArg(a);
  const intent = intentOf(a);
  const game: Game = intent.kind === 'round' ? 'minute' : 'knockout';
  if (a.paper === true) {
    const h = await handles(ctx, { limits: true }, game);
    const { paper, save } = await paperAccount(h, market);
    await markPaper(ctx, paper);
    check(intent, paper.book(paper.realizedSince(dayStart() * 1000)), h);
    const [id] = paper.place([intent], Date.now());
    await markPaper(ctx, paper); // the next price fills the order
    save();
    const p = paper.open.find((x) => x.id === id);
    return { paper: true, id, market, side: intent.side, stake: usdc(intent.stake), entryPrice: p?.entry ?? null, usdc: usdc(paper.cash) };
  }
  const h = await handles(ctx, { limits: true, key: a.dryRun === true ? 'address' : 'signer' }, game);
  if (a.dryRun !== true) needSigner(ctx, h);
  const live = new Live(h, market);
  await live.refresh();
  check(intent, live.book(await todayResult(h)), h);
  if (a.dryRun === true) {
    const bundle = intent.kind === 'round'
      ? await h.minute.build.round({ market, side: intent.side, usd: intent.stake })
      : await h.knockout.build.open({ market, side: intent.side, usd: intent.stake, target: a.target ?? 0, timer: a.timer ?? 0 });
    const s = await transact(h.sender, bundle, false);
    return { dryRun: true, simulated: true, units: s.units, bytes: s.bytes };
  }
  const sent = await sendBatch(h, market, [intent]);
  log('sent', sent);
  return sent;
}

export async function close(ctx: Ctx, a: Args) {
  if (a.id === undefined || !/^\d+$/.test(a.id)) throw bad('id must be a position id (its seq)');
  if (a.paper === true) {
    const h = await handles(ctx, {});
    const { paper, save } = await paperAccount(h, a.market ?? h.cfg.market);
    await markPaper(ctx, paper);
    paper.place([{ kind: 'close', id: a.id }], Date.now());
    const closed = await markPaper(ctx, paper); // the next price prices the close
    save();
    const c = closed.find((x) => x.id === a.id);
    return { paper: true, id: a.id, closed: c !== undefined, ...(c === undefined ? {} : { reason: c.reason, exitPrice: c.exit, payout: usdc(c.payout), pnl: usdc(c.pnl) }) };
  }
  const h = await handles(ctx, { key: a.dryRun === true ? 'address' : 'signer' });
  if (a.dryRun === true) {
    const s = await transact(h.sender, await h.knockout.build.close(BigInt(a.id)), false);
    return { dryRun: true, simulated: true, units: s.units, bytes: s.bytes };
  }
  needSigner(ctx, h);
  const sent = await h.knockout.close(BigInt(a.id));
  log('sent', { what: 'close', id: a.id, ...sent });
  return { id: a.id, ...sent };
}

/** The risk guard, as the bot applies it: one refusal names the limit. */
function check(intent: Intent, book: Book, h: Handles): void {
  const v = guard([intent], book, h.cfg.limits);
  if (v.refused.length > 0) throw new Refusal('risk', 'RISK_LIMIT', v.refused[0]!.why);
}

function needSigner(ctx: Ctx, h: Handles): void {
  if (h.sender.signer === null) {
    throw new Refusal('session', 'NO_SESSION', ctx.agent ? 'trading from an agent needs a session key: run `wheelman session start` as the owner' : 'there is no key to sign with');
  }
}

// ---- sessions ----

const durationS = (text: string | undefined): number => {
  const m = /^(\d+)([smhd]?)$/.exec(text ?? '24h');
  if (m === null) throw bad('expires must be a duration like 3600, 30m, 24h or 7d');
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
};

export async function sessionStartCommand(ctx: Ctx, a: Args) {
  const h = await handles(ctx, { key: a.dryRun === true ? 'address' : 'owner' });
  let allowance: bigint;
  try {
    allowance = parseUsdc(a.allowance ?? '');
  } catch {
    throw bad('allowance must be an amount of USDC, like 20');
  }
  const ownerSender = { ...h.sender, payer: h.owner, signer: h.cfg.wallet };
  const maxStake = (await h.knockout.market(h.cfg.market)).stake.max;
  const r = await sessionStart(ownerSender, h.owner, h.cfg.sessionPath, { allowance, seconds: durationS(a.expires), fuelSol: a.fuel ?? 0.01 }, a.dryRun !== true, maxStake);
  return {
    ...r, allowance: usdc(r.allowance),
    agentEnv: a.dryRun === true ? null : { OWNER: r.owner, SESSION_KEYPAIR_PATH: h.cfg.sessionPath },
  };
}

export async function sessionStatusCommand(ctx: Ctx) {
  const h = await handles(ctx, { key: 'address' });
  const s = await sessionStatus(h.rpc, h.owner, h.cfg.session?.publicKey ?? null);
  return { ...s, remaining: s.remaining === null ? null : usdc(s.remaining) };
}

export async function sessionEndCommand(ctx: Ctx, a: Args) {
  const h = await handles(ctx, { key: a.dryRun === true ? 'address' : 'owner' });
  return sessionEnd({ ...h.sender, payer: h.owner, signer: h.cfg.wallet }, h.owner, h.cfg.session, h.cfg.sessionPath, a.dryRun !== true);
}

// ---- the bot ----

export async function run(ctx: Ctx, a: Args, signal: AbortSignal) {
  if (a.strategy !== undefined) ctx.env = { ...ctx.env, STRATEGY: a.strategy };
  const pre = parseConfig(ctx.env, { strategy: true, limits: true }, ctx.strategies);
  const game = pre.strategy!.game;
  const live = a.paper !== true && a.dryRun !== true;
  if (live && pre.priceSource === 'replay') throw new Refusal('config', 'BAD_CONFIG', 'a replay is for paper mode: set PRICE_SOURCE=coinbase to trade live');
  const h = await handles(ctx, { strategy: true, limits: true, key: live ? 'signer' : a.dryRun === true ? 'address' : undefined }, game);
  const { cfg } = h;
  log('ready', { mode: a.paper ? 'paper' : a.dryRun ? 'dry-run' : 'live', strategy: cfg.strategy!.id, market: cfg.market, rpc: h.rpc.host, owner: cfg.owner?.toBase58() ?? 'none' });
  if (a.dryRun === true) return dryRun(h);
  const source = ctx.prices ?? priceSource(cfg.priceSource, cfg.replayFile);
  const loop = { market: cfg.market, strategy: cfg.strategy!, params: cfg.params, limits: cfg.limits, source, signal };
  if (a.paper === true) {
    // A replay runs on a fresh paper account; a live price runs on the one the paper commands use.
    const { paper, save } = await paperAccount(h, cfg.market, cfg.priceSource === 'replay');
    await trade({ ...loop, broker: paper, todayPnl: paper.realizedSince(dayStart() * 1000) });
    save();
    const s = paper.summary();
    const summary = { ...s, result: usdc(s.result), usdc: usdc(s.usdc) };
    log('paper-summary', summary);
    return summary;
  }
  const broker = new Live(h, cfg.market);
  await broker.refresh();
  const today = await realizedToday(h);
  const b = broker.book(today);
  log('state', { open: b.open, usdc: usdc(b.free), sol: b.sol, today: usdc(today) });
  await watch(cfg, watched(h), () => broker.wake(), signal);
  await trade({ ...loop, broker, todayPnl: today });
  return { stopped: true };
}

/** The accounts whose change wakes the bot. */
const watched = (h: Handles): PublicKey[] =>
  h.game === 'minute' ? [h.minute.book, h.minute.player, h.minute.custody] : [traderPda(h.owner).address, ata(h.owner, USDC_MINT)];

/** Build and simulate the transactions this configuration sends. Nothing is sent. */
async function dryRun(h: Handles) {
  const { cfg } = h;
  const held = await heldBy(h);
  const stake = (cfg.params.stake_usdc as bigint | undefined) ?? 1_000_000n;
  const order = (side: Side) => ({ market: cfg.market, side, usd: stake, target: (cfg.params.take_profit_x as number | undefined) ?? 0, timer: (cfg.params.time_stop_s as number | undefined) ?? 0 });
  const out: Record<string, unknown>[] = [];
  const attempt = async (what: string, build: () => Promise<Parameters<typeof transact>[1]>) => {
    try {
      const s = await transact(h.sender, await build(), false);
      out.push({ what, simulated: true, units: s.units, bytes: s.bytes });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      out.push({ what, simulated: false, code: e.code, message: e.message });
    }
    log('simulated', out.at(-1)!);
  };
  if (h.game === 'minute') await attempt('round', () => h.minute.build.round({ market: cfg.market, side: 'long', usd: stake }));
  else {
    const straddle = cfg.strategy!.id === 'knockout-straddle';
    await attempt(straddle ? 'open long and short' : 'open', () => h.knockout.build.open(straddle ? [order('long'), order('short')] : order('long')));
    const live = held.find((p) => p.market === cfg.market && p.entry !== null);
    await attempt(`close ${live?.id ?? '(none open: a seq that does not exist)'}`, () => h.knockout.build.close(BigInt(live?.id ?? '999999999')));
  }
  if ((await collect(h.sender, h.owner, false)) !== null) out.push({ what: 'collect', simulated: true });
  return out;
}

// ---- the paper account ----

async function paperAccount(h: Handles, market: string, fresh = false) {
  const venue = await h.venue(market);
  const path = join(h.cfg.stateDir, 'paper.json');
  const price = (i: Extract<Intent, { kind: 'open' | 'round' }>) =>
    termsFor(venue, i.kind === 'round' ? 'minute' : 'knockout', i.side, i.stake, i.kind === 'open' ? i.takeProfitX : 0, i.kind === 'open' ? i.timerS : 0);
  const paper = fresh ? new Paper(h.cfg.paperUsdc, market, price) : Paper.load(path, h.cfg.paperUsdc, market, price);
  return { paper, save: () => (fresh ? undefined : paper.save(path)) };
}

/** One price per market the paper account holds, now: it fills orders and ends what it ends. */
async function markPaper(ctx: Ctx, paper: Paper) {
  ctx.prices ??= priceSource(ctx.env.PRICE_SOURCE ?? 'coinbase', ctx.env.REPLAY_FILE);
  const closed = [];
  for (const m of new Set([paper.market, ...paper.open.map((p) => p.market)])) {
    const t = await ctx.prices.latest(m);
    // A price read now is later than any order or close placed before it.
    closed.push(...paper.mark({ ...t, time: Math.max(t.time, Date.now() + 1) }));
  }
  return closed;
}

function paperView(paper: Paper) {
  return {
    paper: true, usdc: usdc(paper.cash),
    positions: paper.open.map((p) => ({ id: p.id, game: p.game, market: p.market, side: p.side, stake: usdc(p.stake), entryPrice: p.entry, closing: p.closing })),
    closed: paper.closed.slice(-20).map((c) => ({ ...c, stake: usdc(c.stake), payout: usdc(c.payout), pnl: usdc(c.pnl) })),
    today: usdc(paper.realizedSince(dayStart() * 1000)),
  };
}

