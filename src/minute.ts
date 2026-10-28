// Minute rounds, in the same shape as the Knockout client: rounds, preview, round, history, build.
// A round runs on Minute's own clock and has no early exit; the venue's keepers settle it.
import { PublicKey, type AddressLookupTableAccount } from '@solana/web3.js';
import {
  PROGRAM_ID, assetId, collateralForTotal, configPda, connectionReader, decodeConfig, decodeFeeTermsTable, decodeMarket, decodeTraderAccount,
  decodeVault, feeTermsTablePda, findBySeq, marketPda, memoReader, parseUsdc, pricingRemainingAccounts, readTradeHistory, toBase58, toHex,
  vaultPda, withFeeTermsTable, type BuiltInstruction, type ClosedTrade,
} from '@rekt-trading/1000x';
import {
  ROUND_STATUS, decodeMinuteConfig, decodeMinuteEvent, decodePlayerAccount, minuteConfigPda, minuteEventPayloads, minuteIx, minutePlayerPda,
  minutePlayerTokenPda, minuteTraderBookFor, type MinuteConfigView,
} from '@rekt-trading/1000x'; // Minute's API ships in the same package
import { ata, bundleOf, marketSymbol, type KnockoutClientOptions, type Settlement, type Side } from './client.ts';
import { Refusal } from './errors.ts';
import { payoutAt, scaled, termsFor } from './paper.ts';
import { CLOCK, transact, type Bundle, type Sender } from './rpc.ts';

export interface RoundOrder {
  market: string;
  side: Side;
  /** The round's total: what leaves the wallet, in USDC. */
  usd: string | bigint;
}

export interface RoundInfo {
  seq: bigint;
  market: string;
  side: Side;
  /** What the round took from the wallet, and the position it bought. */
  total: bigint;
  stake: bigint;
  entryPrice: number | null;
  openedAt: number;
  deadline: number;
}

export function createMinuteClient(o: KnockoutClientOptions) {
  const owner = o.owner;
  const player = minutePlayerPda(owner);
  const book = minuteTraderBookFor(owner, player.bump).positions;
  const custody = minutePlayerTokenPda(player.address).address;
  const session = o.signer !== null && !o.signer.publicKey.equals(owner);
  const signer = o.signer?.publicKey ?? owner;
  const sender: Sender = { rpc: o.rpc, payer: signer, signer: o.signer, maxPriorityFee: o.maxPriorityFee ?? 100_000, tip: o.tip ?? null };
  const reader = memoReader(connectionReader(o.rpc.conn), o.store === undefined ? {} : { store: o.store });
  let lookupTables: AddressLookupTableAccount[] | null = null;

  async function read(symbol: string) {
    const market = marketPda(assetId(symbol)).address;
    const [c, v, m, f, mc, p, k] = await o.rpc.conn.getMultipleAccountsInfo(
      [configPda().address, vaultPda().address, market, feeTermsTablePda(market).address, minuteConfigPda().address, player.address, CLOCK], 'confirmed');
    if (c === null || v === null || mc === null) throw new Refusal('config', 'VENUE_MISSING', 'the venue or Minute config is missing: is RPC_URL a mainnet endpoint?');
    if (m === null) throw new Refusal('config', 'NO_SUCH_MARKET', `${symbol} is not listed on the venue`);
    return {
      config: decodeConfig(new Uint8Array(c.data)), vault: decodeVault(new Uint8Array(v.data)), market: decodeMarket(new Uint8Array(m.data)),
      feeTable: f === null ? null : decodeFeeTermsTable(new Uint8Array(f.data)), minute: decodeMinuteConfig(new Uint8Array(mc.data)),
      playerExists: p !== null, nowUnix: Buffer.from(k!.data).readBigInt64LE(32),
    };
  }

  async function rounds(): Promise<RoundInfo[]> {
    const [p, b] = await o.rpc.conn.getMultipleAccountsInfo([player.address, book], 'confirmed');
    if (p === null || b === null) return [];
    const venueBook = decodeTraderAccount(new Uint8Array(b.data));
    return decodePlayerAccount(new Uint8Array(p.data)).rounds.flatMap((r) => {
      // A round whose venue position is gone has ended; Minute records it later.
      const v = r.status === ROUND_STATUS.LIVE ? findBySeq(venueBook, r.seq) : null;
      if (v === null) return [];
      return [{
        seq: r.seq, market: marketSymbol(r.market), side: r.direction === 0 ? 'long' : 'short', total: r.openingGross, stake: r.stake,
        entryPrice: v.entryPrice === 0n ? null : Number(v.entryPrice) * 10 ** v.entryExpo, openedAt: Number(r.openedAtUnix), deadline: Number(r.deadlineUnix),
      } satisfies RoundInfo];
    });
  }

  async function preview(order: RoundOrder) {
    const r = await read(order.market);
    const total = typeof order.usd === 'bigint' ? order.usd : parseUsdc(order.usd);
    const t = termsFor({ ...r, nowUnix: r.nowUnix }, 'minute', order.side, total, 0, 0);
    const at = { ...t, engine: { ...t.engine, entryPrice: scaled(1) } };
    return {
      market: order.market, side: order.side, total, stake: t.engine.collateral, leverage: Number(t.engine.tier), timer: t.timerS,
      target: r.minute.params.rungBps === 0 ? null : r.minute.params.rungBps / 10_000,
      payoutAtTarget: r.minute.params.rungBps === 0 ? null : payoutAt(at, 1, 'takeProfit'), payoutAtBarrier: payoutAt(at, 1, 'knockout'),
      minuteFees: { entryBps: r.minute.params.entryFeeBps, exitBps: r.minute.params.exitFeeBps },
    };
  }

  async function buildRound(order: RoundOrder): Promise<Bundle> {
    const r = await read(order.market);
    const m: MinuteConfigView = r.minute;
    if (!r.market.minuteEnabled || r.market.paused || m.pausedOpens || r.config.paused) {
      throw new Refusal('venue', 'MINUTE_CLOSED', `${order.market} takes no Minute round now`, true, 60_000);
    }
    const total = typeof order.usd === 'bigint' ? order.usd : parseUsdc(order.usd);
    if (total < m.params.minStake || total > m.params.maxStake) throw new Refusal('venue', 'StakeOutOfRange', 'the total is outside Minute\'s stake bounds');
    const predicted = collateralForTotal(total - (total * BigInt(m.params.entryFeeBps)) / 10_000n, r.config.params.entryFeeBps).collateral;
    const walletToken = toHex(ata(owner, new PublicKey(toBase58(m.usdcMint))));
    const accounts = {
      config: toHex(minuteConfigPda().address), player: toHex(player.address), player_token: toHex(custody), positions: toHex(book),
      knockout_vault: toHex(vaultPda().address), knockout_vault_token: r.vault.tokenAccount, knockout_program: toHex(new PublicKey(PROGRAM_ID)),
    };
    const built: BuiltInstruction[] = [];
    if (!r.playerExists) {
      // Once per player, signed and paid by the player.
      if (session) throw new Refusal('session', 'NO_PLAYER', 'the owner has no Minute account yet: the owner plays one round first');
      built.push(minuteIx.initPlayer(
        { ...accounts, payer: toHex(owner), player_wallet: toHex(owner), usdc_mint: m.usdcMint },
        { book_slots: m.params.defaultBookSlots, round_slots: m.params.defaultRoundSlots, referrer: '00'.repeat(32) },
      ));
    }
    // A session key pays, and spends the owner's USDC as the SPL delegate the owner approved.
    built.push(minuteIx.openRound(
      { ...accounts, payer: toHex(signer), player_wallet: toHex(owner), funder: toHex(signer), wallet_token: walletToken,
        knockout_config: toHex(configPda().address), knockout_market: toHex(marketPda(assetId(order.market)).address), knockout_protocol_token: r.config.treasury },
      { game_kind: 0, direction: order.side === 'long' ? 0 : 1, total_in: total, min_collateral_out: predicted },
      withFeeTermsTable(pricingRemainingAccounts(r.market), r.market, r.config, 'open'),
    ));
    // A round names Minute's accounts and the venue's: compile it against Minute's lookup table (frozen, read once).
    lookupTables ??= await (async () => {
      const t = (await o.rpc.conn.getAddressLookupTable(new PublicKey(toBase58(m.lookupTable)), { commitment: 'confirmed' })).value;
      return t === null ? [] : [t];
    })();
    return { ...bundleOf(built), lookupTables };
  }

  const settlementOf = (t: ClosedTrade, minute: MinuteConfigView, gross: bigint | null): Settlement => {
    // A round's result also pays Minute's own fees: its entry fee from the total, its exit fee from the payout.
    const total = gross ?? (t.stake * 10_000n) / (10_000n - BigInt(minute.params.entryFeeBps));
    const payout = t.pnl.payout - (t.pnl.payout * BigInt(minute.params.exitFeeBps)) / 10_000n;
    return { seq: t.seq, market: marketSymbol(t.market), side: t.direction, stake: total, payout, pnl: payout - total, reason: t.reason, settledAt: t.settledAt, signature: t.signature };
  };

  async function history(opts: { since?: number; limit?: number } = {}): Promise<Settlement[]> {
    let limit = opts.limit ?? 100;
    if (opts.since !== undefined) {
      const sigs = await o.rpc.conn.getSignaturesForAddress(book, { limit: 1000 }, 'confirmed');
      limit = sigs.filter((s) => (s.blockTime ?? 0) >= opts.since!).length;
      if (limit === 0) return [];
    }
    const [c, mc] = await o.rpc.conn.getMultipleAccountsInfo([configPda().address, minuteConfigPda().address], 'confirmed');
    const h = await readTradeHistory(reader, player.address, decodeConfig(new Uint8Array(c!.data)), { limit });
    const minute = decodeMinuteConfig(new Uint8Array(mc!.data));
    return h.trades.filter((t) => opts.since === undefined || (t.settledAt ?? 0) >= opts.since).map((t) => settlementOf(t, minute, null));
  }

  async function settlement(seq: bigint, gross: bigint | null = null): Promise<Settlement | null> {
    const [c, mc] = await o.rpc.conn.getMultipleAccountsInfo([configPda().address, minuteConfigPda().address], 'confirmed');
    const h = await readTradeHistory(reader, player.address, decodeConfig(new Uint8Array(c!.data)), { limit: 25 });
    const t = h.trades.find((x) => x.seq === seq);
    if (t !== undefined) return settlementOf(t, decodeMinuteConfig(new Uint8Array(mc!.data)), gross);
    const v = h.voidedOpens.find((x) => x.seq === seq);
    return v === undefined ? null : {
      seq, market: marketSymbol(v.market), side: null, stake: gross ?? v.stake, payout: v.stakeReturned, pnl: v.stakeReturned - (gross ?? v.stake),
      reason: `returned (${v.reason})`, settledAt: v.blockTime, signature: v.signature,
    };
  }

  return {
    owner,
    player: player.address,
    book,
    custody,
    rounds,
    preview,
    history,
    settlement,
    async round(order: RoundOrder): Promise<{ seq: bigint; signature: string }> {
      const sent = await transact(sender, await buildRound(order), true);
      const opened = minuteEventPayloads(sent.logs).map(decodeMinuteEvent).find((e) => e?.name === 'RoundOpened');
      return { seq: (opened?.event as { seq: bigint } | undefined)?.seq ?? 0n, signature: sent.signature! };
    },
    build: { round: buildRound },
  };
}

export type MinuteClient = ReturnType<typeof createMinuteClient>;
