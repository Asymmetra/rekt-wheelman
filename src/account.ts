// The owner's wallet beyond trading: balances, collecting what is owed, session keys for agents,
// and a local cache of settled transactions (they never change, so each is fetched once).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  MAX_DELEGATE_DURATION_S, MAX_DELEGATE_WINDOW_S, MIN_DELEGATE_DURATION_S, authorizeSession, configPda, decodeConfig, decodeTradeDelegate, decodeTraderAccount, decodeVault,
  delegatePda, endSession, ix, sessionStanding, toBase58, toHex, traderPda, vaultPda, type MemoReaderOptions,
} from '@rekt-trading/1000x';
import { minuteConfigPda, minuteIx, minutePlayerPda, minutePlayerTokenPda, minuteTraderBookFor } from '@rekt-trading/1000x'; // Minute's API ships in the same package
import { ata, bundleOf, tokenAmount } from './client.ts';
import { Refusal } from './errors.ts';
import { CLOCK, transact, type Rpc, type Sender } from './rpc.ts';

// The SDK uses these types in an exported option but does not export them.
export type FrozenStore = NonNullable<MemoReaderOptions['store']>;
type FrozenTx = Parameters<FrozenStore['set']>[1];

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export interface Balances {
  sol: number;
  /** USDC in the wallet. */
  usdc: bigint;
  /** A payout the venue holds for the wallet (unclaimed), on its own book and on its Minute book. */
  owed: bigint;
  /** USDC in the wallet's Minute account, swept back to the wallet by `collect`. */
  custody: bigint;
  /** SOL on the key that pays the fees: the owner, or a session key. */
  payerSol: number;
}

export async function balances(rpc: Rpc, owner: PublicKey, payer: PublicKey = owner): Promise<Balances> {
  const minuteBook = minuteTraderBookFor(owner, minutePlayerPda(owner).bump).positions;
  const custody = minutePlayerTokenPda(minutePlayerPda(owner).address).address;
  const [w, t, b, mb, c, p] = await rpc.conn.getMultipleAccountsInfo([owner, ata(owner, USDC_MINT), traderPda(owner).address, minuteBook, custody, payer], 'confirmed');
  const pending = (a: typeof b) => (a === null ? 0n : decodeTraderAccount(new Uint8Array(a.data)).pendingPayout);
  return { sol: (w?.lamports ?? 0) / 1e9, usdc: tokenAmount(t?.data), owed: pending(b) + pending(mb), custody: tokenAmount(c?.data), payerSol: (p?.lamports ?? 0) / 1e9 };
}

/** Claim what the venue holds for the wallet, and sweep its Minute account. Anyone may send both. */
export async function collect(s: Sender, owner: PublicKey, send: boolean): Promise<{ signature: string | null } | null> {
  const player = minutePlayerPda(owner);
  const minuteBook = minuteTraderBookFor(owner, player.bump).positions;
  const custody = minutePlayerTokenPda(player.address).address;
  const [cfg, vault, b, mb, c] = await s.rpc.conn.getMultipleAccountsInfo([configPda().address, vaultPda().address, traderPda(owner).address, minuteBook, custody], 'confirmed');
  const books = ([[traderPda(owner).address, b], [minuteBook, mb]] as const).flatMap(([address, account]) => {
    const book = account === null ? null : decodeTraderAccount(new Uint8Array(account.data));
    return book !== null && book.pendingPayout > 0n ? [{ address, destination: book.payoutDestination }] : [];
  });
  const sweep = tokenAmount(c?.data) > 0n;
  if (books.length === 0 && !sweep) return null;
  if (cfg === null || vault === null) throw new Refusal('venue', 'VENUE_MISSING', 'the venue config or vault is missing');
  const config = decodeConfig(new Uint8Array(cfg.data));
  const vaultToken = decodeVault(new Uint8Array(vault.data)).tokenAccount;
  const built = [];
  for (const { address, destination } of books) {
    built.push(ix.claimPayout({ payer: toHex(s.payer), owner_token: destination, positions: toHex(address), vault: toHex(vaultPda().address), vault_token: vaultToken }));
  }
  if (sweep) {
    built.push(minuteIx.sweep({
      payer: toHex(s.payer), player: toHex(player.address), player_token: toHex(custody), destination: toHex(ata(owner, USDC_MINT)),
      config: toHex(minuteConfigPda().address), knockout_config: toHex(configPda().address), knockout_vault: toHex(vaultPda().address),
      knockout_vault_token: vaultToken, knockout_protocol_token: config.treasury,
    }));
  }
  return { signature: (await transact(s, bundleOf(built), send)).signature };
}

/** A session that trades for the owner: a key the owner authorises, with an allowance and an expiry. */
export interface SessionPlan {
  /** The most USDC the session may spend in total (the SPL allowance) and per window. */
  allowance: bigint;
  /** How long the session may trade, in seconds. */
  seconds: number;
  /** SOL sent to the session key for its own fees. */
  fuelSol: number;
}

function checkSessionPlan(p: SessionPlan): void {
  if (p.allowance <= 0n) throw new Refusal('config', 'BAD_ALLOWANCE', 'the allowance must be above 0');
  if (p.seconds < MIN_DELEGATE_DURATION_S || p.seconds > MAX_DELEGATE_DURATION_S) {
    throw new Refusal('config', 'BAD_EXPIRY', `the expiry must be from ${MIN_DELEGATE_DURATION_S} to ${MAX_DELEGATE_DURATION_S} seconds`);
  }
  if (!(p.fuelSol > 0 && p.fuelSol <= 1)) throw new Refusal('config', 'BAD_FUEL', 'the fuel must be above 0 and at most 1 SOL');
}

/**
 * Authorise a session key: one transaction, signed by the owner. It creates the owner's book when
 * there is none, authorises the key (expiry, spend window, SPL allowance) and sends it SOL for fees.
 * The key is written (mode 600) BEFORE the send, and removed only when the program refuses.
 */
export async function sessionStart(s: Sender, owner: PublicKey, path: string, plan: SessionPlan, send: boolean, maxStake: bigint) {
  checkSessionPlan(plan);
  if (send && existsSync(path)) throw new Refusal('session', 'SESSION_EXISTS', `${path} exists: end that session first (wheelman session end)`);
  const key = Keypair.generate();
  const me = owner;
  const traderToken = ata(me, USDC_MINT);
  const [b, v] = await s.rpc.conn.getMultipleAccountsInfo([traderPda(me).address, vaultPda().address], 'confirmed');
  const built = [];
  if (b === null) {
    if (v === null) throw new Refusal('venue', 'VENUE_MISSING', 'the venue vault is missing');
    built.push(ix.initTraderAccount({
      trader: toHex(me), payer: toHex(me), positions: toHex(traderPda(me).address), vault: toHex(vaultPda().address),
      vault_token: decodeVault(new Uint8Array(v.data)).tokenAccount, payout_destination: toHex(traderToken),
    }, 12));
  }
  built.push(...authorizeSession({
    owner: toHex(me), delegateKey: toHex(key.publicKey), delegate: toHex(delegatePda(me).address), traderToken: toHex(traderToken),
    config: toHex(configPda().address), restrictions: 0, allowance: plan.allowance, maxCollateral: maxStake,
    // The SPL allowance is what bounds the session. The program also asks the spend window to admit
    // at least one maximum stake, so the window is the larger of the two.
    terms: {
      durationS: plan.seconds, windowSeconds: Math.max(60, Math.min(plan.seconds, MAX_DELEGATE_WINDOW_S)),
      windowLimit: plan.allowance > maxStake ? plan.allowance : maxStake,
    },
  }));
  const bundle = bundleOf(built);
  bundle.instructions.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: key.publicKey, lamports: Math.round(plan.fuelSol * 1e9) }));
  if (send) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600, flag: 'wx' });
  }
  try {
    const sent = await transact(s, bundle, send);
    return { session: key.publicKey.toBase58(), owner: me.toBase58(), allowance: plan.allowance, expiresInS: plan.seconds, fuelSol: plan.fuelSol, signature: sent.signature, units: sent.units, keyFile: send ? path : null };
  } catch (e) {
    // Remove the key only on a decoded refusal: a send that may have landed keeps it.
    if (send && e instanceof Refusal && e.category === 'venue') rmSync(path, { force: true });
    throw e;
  }
}

/** Where a session stands, from the chain. */
export async function sessionStatus(rpc: Rpc, owner: PublicKey, key: PublicKey | null) {
  const [d, t, k, w] = await rpc.conn.getMultipleAccountsInfo([delegatePda(owner).address, ata(owner, USDC_MINT), CLOCK, key ?? owner], 'confirmed');
  const delegate = d === null ? null : decodeTradeDelegate(new Uint8Array(d.data));
  const nowUnix = Buffer.from(k!.data).readBigInt64LE(32);
  const s = sessionStanding({ delegate, tokenAccount: t === null ? null : new Uint8Array(t.data), nowUnix });
  return {
    state: s.kind, action: s.action, headline: s.headline,
    session: delegate === null ? null : toBase58(delegate.delegate),
    keyMatches: key === null || delegate === null ? null : toBase58(delegate.delegate) === key.toBase58(),
    remaining: s.session?.remaining ?? null, expiresInS: s.session?.expiresInS ?? null,
    keySol: key === null ? null : (w?.lamports ?? 0) / 1e9,
  };
}

/** End a session: the owner closes the delegate and drops the allowance; the key's SOL comes back. */
export async function sessionEnd(s: Sender, owner: PublicKey, key: Keypair | null, path: string, send: boolean) {
  const me = owner;
  const [d, w] = await s.rpc.conn.getMultipleAccountsInfo([delegatePda(me).address, key?.publicKey ?? me], 'confirmed');
  if (d === null) throw new Refusal('session', 'NO_SESSION', 'the owner has no session to end');
  const delegate = decodeTradeDelegate(new Uint8Array(d.data));
  const bundle = bundleOf(endSession({ owner: toHex(me), delegate: toHex(delegatePda(me).address), traderToken: delegate.tokenAccount }));
  const fuel = key === null ? 0 : (w?.lamports ?? 0);
  if (key !== null && fuel > 0) bundle.instructions.push(SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: me, lamports: fuel }));
  const sent = await transact({ ...s, cosigners: key === null || fuel === 0 ? [] : [key] }, bundle, send);
  if (send && key !== null) rmSync(path, { force: true });
  return { ended: toBase58(delegate.delegate), returnedSol: fuel / 1e9, signature: sent.signature, units: sent.units };
}

/** Settled transactions on disk, one JSON line each, so a restart reads none of them twice. */
export function fileStore(dir: string): FrozenStore {
  const file = join(dir, 'transactions.jsonl');
  const memory = new Map<string, FrozenTx>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line === '') continue;
      try {
        const [signature, tx] = JSON.parse(line) as [string, FrozenTx];
        memory.set(signature, tx);
      } catch {
        // a torn last line: that one transaction is read again
      }
    }
  }
  return {
    get: (signature) => memory.get(signature),
    set: (signature, tx) => {
      memory.set(signature, tx);
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, `${JSON.stringify([signature, tx])}\n`);
    },
  };
}
