// RPC for any provider. The rules: stream first and poll last; read only the bot's own accounts;
// one rate limit and one backoff per endpoint; `confirmed` on every call; send with
// maxRetries 0 and one bounded rebroadcast; never log a key.
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount, type Keypair, type TransactionInstruction,
} from '@solana/web3.js';
import {
  PACKET_LIMIT_BYTES, PROGRAM_ID, confirmSignature, connectionSignatureReader, errorForCode, minuteErrorForCode, programErrorCode,
  type Confirmation,
} from '@rekt-trading/1000x';
import type { Config } from './config.ts';
import { Refusal } from './errors.ts';
import { hostOf, log, redact } from './journal.ts';

/** The Clock sysvar: slot and unix time in the same read as the accounts. */
export const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const ATTEMPTS = 5;

/** An endpoint that failed 5 times. Nothing was sent by the failing call, so it is retryable. */
export class RpcExhausted extends Refusal {
  constructor(message: string) {
    super('rpc', 'RPC_UNAVAILABLE', message, true, 60_000);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait 1 s, doubling to 30 s, with 25 % jitter either way. */
export const backoffMs = (attempt: number, rand: () => number = Math.random): number =>
  Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + rand() * 0.5);

/** A token bucket: at most `perSecond` requests a second, shared by every caller of one endpoint. */
function bucket(perSecond: number): () => Promise<void> {
  let tokens = perSecond;
  let last = Date.now();
  return async function take() {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(perSecond, tokens + ((now - last) / 1000) * perSecond);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(((1 - tokens) / perSecond) * 1000);
    }
  };
}

/**
 * A fetch for one endpoint, with its standby. HTTP 429, a 5xx, JSON-RPC -32005 or a network error
 * waits and tries again, 5 times, then the standby takes over for 60 s; then the bot stops loudly.
 * The primary and the standby are never used at the same time.
 */
export function gatedFetch(primary: string, standby: string | null, perSecond: number, fetcher: typeof fetch = fetch, pause = sleep) {
  const take = bucket(perSecond);
  let primaryDownUntil = 0;
  return async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const urls = standby !== null && Date.now() < primaryDownUntil ? [standby] : [primary, ...(standby === null ? [] : [standby])];
    let problem = '';
    for (const url of urls) {
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        await take();
        try {
          const res = await fetcher(url, init);
          const body = await res.text();
          if (res.status !== 429 && res.status < 500 && !/"code"\s*:\s*-32005/.test(body)) {
            return new Response(body, { status: res.status, headers: { 'content-type': 'application/json' } });
          }
          problem = `HTTP ${res.status}`;
        } catch (e) {
          problem = (e as Error).message;
        }
        if (attempt < ATTEMPTS - 1) await pause(backoffMs(attempt));
      }
      if (url === primary && standby !== null) {
        primaryDownUntil = Date.now() + 60_000;
        log('rpc-standby', { from: hostOf(primary), to: hostOf(standby) });
      }
    }
    throw new RpcExhausted(redact(`${urls.map(hostOf).join(' and ')} failed ${ATTEMPTS} times: ${problem}`));
  };
}

export interface Rpc {
  conn: Connection;
  send: Connection;
  /** A raw JSON-RPC call through the same gate (for provider methods web3.js does not have). */
  call(method: string, params: unknown[]): Promise<unknown>;
  host: string;
}

export function makeRpc(cfg: Pick<Config, 'rpcUrl' | 'fallbackUrl' | 'sendUrl' | 'maxRps'>): Rpc {
  const reads = gatedFetch(cfg.rpcUrl, cfg.fallbackUrl, cfg.maxRps);
  // Sends have their own gate, so reads never delay a send.
  const sends = cfg.sendUrl === cfg.rpcUrl ? gatedFetch(cfg.rpcUrl, cfg.fallbackUrl, cfg.maxRps) : gatedFetch(cfg.sendUrl, null, cfg.maxRps);
  const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed', fetch: reads as typeof fetch, disableRetryOnRateLimit: true });
  const send = new Connection(cfg.sendUrl, { commitment: 'confirmed', fetch: sends as typeof fetch, disableRetryOnRateLimit: true });
  return {
    conn,
    send,
    host: hostOf(cfg.rpcUrl),
    async call(method, params) {
      const res = await reads(cfg.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error !== undefined) throw new Error(redact(`${method}: ${body.error.message ?? 'error'}`));
      return body.result;
    },
  };
}

/** Refuse to run against any cluster but mainnet. */
export async function checkCluster(rpc: Rpc): Promise<void> {
  const genesis = await rpc.conn.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) throw new Refusal('config', 'NOT_MAINNET', `${rpc.host} is not a Solana mainnet endpoint (genesis ${genesis})`);
}

let feeCache: { at: number; key: string; fee: number } | null = null;

/** The priority fee in micro-lamports per compute unit, cached 10 s, never above `max`. */
async function priorityFee(rpc: Rpc, writable: PublicKey[], max: number): Promise<number> {
  const key = writable.map((k) => k.toBase58()).join();
  if (feeCache !== null && feeCache.key === key && Date.now() - feeCache.at < 10_000) return feeCache.fee;
  let fee: number;
  if (rpc.host.endsWith('helius-rpc.com')) {
    const r = (await rpc.call('getPriorityFeeEstimate', [{ accountKeys: writable.map((k) => k.toBase58()), options: { recommended: true } }])) as { priorityFeeEstimate?: number };
    fee = r.priorityFeeEstimate ?? 0;
  } else {
    const samples = (await rpc.conn.getRecentPrioritizationFees({ lockedWritableAccounts: writable })).map((s) => s.prioritizationFee).sort((a, b) => a - b);
    fee = samples.length === 0 ? 0 : samples[Math.floor(samples.length * 0.75)]!;
  }
  fee = Math.min(max, Math.ceil(fee));
  feeCache = { at: Date.now(), key, fee };
  return fee;
}

/**
 * Send signed bytes with maxRetries 0, send the same bytes again every 2 s, and stop when the
 * cluster confirms the signature or the blockhash expires (judged by getEpochInfo's block height).
 */
async function sendAndConfirm(rpc: Rpc, tx: VersionedTransaction, lastValidBlockHeight: number): Promise<{ signature: string; out: Confirmation }> {
  const bytes = tx.serialize();
  const options = { skipPreflight: true, maxRetries: 0 } as const;
  const signature = await rpc.send.sendRawTransaction(bytes, options);
  let done = false;
  const again = (async () => {
    while (!done) {
      await sleep(2000);
      if (!done) await rpc.send.sendRawTransaction(bytes, options).catch(() => undefined);
    }
  })();
  try {
    const out = await confirmSignature(connectionSignatureReader(rpc.conn), signature, lastValidBlockHeight, {
      waitMs: 150_000,
      pollMs: 1000,
      heightAfterMs: 30_000,
      heightEveryMs: 5000,
    });
    return { signature, out };
  } finally {
    done = true;
    await again;
  }
}

/** Who pays and signs a transaction, and what it may spend on fees. */
export interface Sender {
  rpc: Rpc;
  /** The fee payer: the owner, or a session key that signs and pays. */
  payer: PublicKey;
  /** null in a dry run with no key: the simulation then skips the signature check. */
  signer: Keypair | null;
  /** Other keys that sign the same transaction (a session key returning its fuel). */
  cosigners?: Keypair[];
  maxPriorityFee: number;
  tip: { lamports: number; account: PublicKey } | null;
}

/** Instructions and the compute units they need. */
export interface Bundle {
  instructions: TransactionInstruction[];
  computeUnits: number;
  lookupTables?: AddressLookupTableAccount[];
}

export interface Sent {
  signature: string | null;
  units: number;
  bytes: number;
  logs: string[];
}

const blockhashes = new WeakMap<Rpc, { at: number; blockhash: string; lastValidBlockHeight: number }>();
const WAIT: Record<string, number> = { immediately: 5_000, 'after-state-changes': 30_000, 'after-governance': 600_000, never: 600_000 };

/**
 * The one path every transaction takes: the compute budget, the priority fee, an optional tip,
 * the size check, a simulation, and (when `send`) one send with a bounded rebroadcast, confirmed
 * by the cluster. A refusal at any step throws a Refusal; nothing is sent after a failed simulation.
 */
export async function transact(s: Sender, bundle: Bundle, send: boolean): Promise<Sent> {
  const writable = [...new Set(bundle.instructions.flatMap((x) => x.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))];
  const fee = await priorityFee(s.rpc, writable.map((k) => new PublicKey(k)), s.maxPriorityFee);
  const list = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: bundle.computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }),
    ...bundle.instructions,
  ];
  if (s.tip !== null && s.tip.lamports > 0) list.push(SystemProgram.transfer({ fromPubkey: s.payer, toPubkey: s.tip.account, lamports: s.tip.lamports }));
  let hash = blockhashes.get(s.rpc);
  if (hash === undefined || Date.now() - hash.at > 5_000) {
    hash = { at: Date.now(), ...(await s.rpc.conn.getLatestBlockhash('confirmed')) };
    blockhashes.set(s.rpc, hash);
  }
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: s.payer, recentBlockhash: hash.blockhash, instructions: list }).compileToV0Message(bundle.lookupTables ?? []));
  if (s.signer !== null) tx.sign([s.signer, ...(s.cosigners ?? [])]);
  const bytes = tx.serialize().length;
  if (bytes > PACKET_LIMIT_BYTES) throw new Refusal('send', 'TOO_LARGE', `the transaction is ${bytes} bytes; the limit is ${PACKET_LIMIT_BYTES}`);

  // Simulate first, always. Without a key (a dry run), skip the signature check.
  const sim = await s.rpc.conn.simulateTransaction(tx, { commitment: 'confirmed', sigVerify: s.signer !== null, replaceRecentBlockhash: s.signer === null });
  if (sim.value.err !== null) throw refusalOf(sim.value.err, sim.value.logs ?? []);
  const units = sim.value.unitsConsumed ?? 0;
  if (!send) return { signature: null, units, bytes, logs: sim.value.logs ?? [] };
  if (s.signer === null) throw new Refusal('config', 'NO_SIGNER', 'there is no key to sign with');

  const { signature, out } = await sendAndConfirm(s.rpc, tx, hash.lastValidBlockHeight);
  blockhashes.delete(s.rpc);
  // An expired blockhash with no landing can never land: a resend is safe. An unknown is not.
  if (out.confirmation === 'expired') throw new Refusal('send', 'EXPIRED', `${signature} did not land before its blockhash expired`, true, 5_000);
  if (out.confirmation !== 'confirmed') {
    throw new Refusal('send', 'UNCONFIRMED', `${signature} is not confirmed: read your positions before you send again`, false, 60_000);
  }
  if (out.err !== null) throw refusalOf(out.err, out.landed?.logMessages ?? []);
  return { signature, units: out.landed?.computeUnits ?? units, bytes, logs: out.landed?.logMessages ?? [] };
}

/** Name a failure with the SDK's catalogue, from the program that failed. */
function refusalOf(err: unknown, logs: string[]): Refusal {
  const code = programErrorCode(err);
  const failed = logs.find((l) => / failed: /.test(l)) ?? '';
  if (code === null) return new Refusal('venue', 'TRANSACTION_ERROR', JSON.stringify(err), false);
  if (failed.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')) {
    return new Refusal('venue', 'TOKEN_TRANSFER_FAILED', `the USDC transfer failed (token error ${code}): does the wallet hold the stake?`, true);
  }
  if (failed !== '' && !failed.includes(PROGRAM_ID)) {
    const m = minuteErrorForCode(code);
    // Minute's refusals carry no retry class; these three clear when the state changes.
    const later = ['OpensPaused', 'VenueOpensPaused', 'NoFreeRoundSlot'].includes(m?.name ?? '');
    if (m !== null) return new Refusal('venue', m.name, `Minute ${m.name} (${code}): ${m.msg ?? ''}`.trim(), later);
  }
  const v = errorForCode(code);
  if (v === null) return new Refusal('venue', `ERROR_${code}`, `the program refused with code ${code}`, false);
  const retryable = v.retryable === 'immediately' || v.retryable === 'after-state-changes';
  return new Refusal('venue', v.name, `${v.name} (${code}): ${v.fix}`, retryable, WAIT[v.retryable] ?? 60_000);
}

/**
 * Wake the bot when one of its accounts changes: a websocket accountSubscribe, or a Yellowstone
 * gRPC stream when GRPC_URL is set. A hint only says "read now"; the bot then reads the accounts
 * over HTTP. After every (re)connect it reads once, because a stream has no replay.
 */
export async function watch(cfg: Config, accounts: PublicKey[], onHint: (why: string) => void, signal: AbortSignal): Promise<void> {
  if (cfg.grpcUrl !== null) return grpcWatch(cfg.grpcUrl, cfg.grpcToken, accounts, onHint, signal);
  let failures = 0;
  let current: WebSocket | null = null;
  signal.addEventListener('abort', () => current?.close(), { once: true });
  const open = () => {
    if (signal.aborted) return;
    const ws = new WebSocket(cfg.wsUrl);
    current = ws;
    ws.onopen = () => {
      accounts.forEach((a, i) => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'accountSubscribe', params: [a.toBase58(), { encoding: 'base64', commitment: 'confirmed' }] }));
      });
    };
    let acked = 0;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; method?: string; result?: unknown; error?: { message?: string } };
      if (m.method === 'accountNotification') onHint('account changed');
      else if (m.error !== undefined) log('stream-refused', { detail: redact(m.error.message ?? 'error') });
      else if (m.id !== undefined && ++acked === accounts.length) {
        failures = 0;
        onHint('stream subscribed');
      }
    };
    ws.onclose = () => {
      if (signal.aborted) return;
      log('stream-closed', { host: hostOf(cfg.wsUrl) });
      setTimeout(open, backoffMs(failures++));
    };
    ws.onerror = () => ws.close();
  };
  open();
}

async function grpcWatch(url: string, token: string | null, accounts: PublicKey[], onHint: (why: string) => void, signal: AbortSignal): Promise<void> {
  const name = '@triton-one/yellowstone-grpc';
  let mod: { default: new (u: string, t: string | undefined, o: undefined) => any; CommitmentLevel: { CONFIRMED: number } };
  try {
    mod = await import(name);
  } catch {
    throw new Error(`GRPC_URL needs the gRPC client: run npm install ${name}`);
  }
  let failures = 0;
  const open = async () => {
    if (signal.aborted) return;
    try {
      const client = new mod.default(url, token ?? undefined, undefined);
      await client.connect();
      const stream = await client.subscribe();
      signal.addEventListener('abort', () => stream.destroy(), { once: true });
      const retry = () => {
        if (signal.aborted) return;
        log('stream-closed', { host: hostOf(url) });
        setTimeout(open, backoffMs(failures++));
      };
      stream.on('error', () => stream.destroy());
      stream.on('close', retry);
      stream.on('data', (u: { account?: unknown }) => u.account !== undefined && onHint('account changed'));
      // The bot's own accounts only, never an empty filter (that would stream everything).
      const request = {
        accounts: { bot: { account: accounts.map((a) => a.toBase58()), owner: [], filters: [] } },
        slots: {}, transactions: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {},
        accountsDataSlice: [], commitment: mod.CommitmentLevel.CONFIRMED,
      };
      stream.write(request, (err: unknown) => {
        if (err) return stream.destroy();
        failures = 0;
        onHint('stream subscribed');
      });
    } catch (e) {
      log('stream-refused', { host: hostOf(url), detail: redact((e as Error).message) });
      setTimeout(open, backoffMs(failures++));
    }
  };
  // Load the client now, so a missing package stops the bot at start.
  void open();
}
