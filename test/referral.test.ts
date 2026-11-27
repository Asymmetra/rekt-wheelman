// The referral link in a first trade (`--referrer`): where the link goes, when it is left out, and what is refused.
// Offline: the connection is fake (test/helpers.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { PROGRAM_ID, referralLinkPda, type BuiltInstruction } from '@rekt-trading/1000x';
import { parseArgs } from '../src/cli.ts';
import { linked, referrerToLink } from '../src/client.ts';
import { referrerArg } from '../src/commands.ts';
import { fakeRpc } from './helpers.ts';

const owner = Keypair.generate().publicKey;
const referrer = Keypair.generate().publicKey;
const stub = (name: string): BuiltInstruction => ({ name, data: new Uint8Array([1]), accounts: [], remaining: [] }) as unknown as BuiltInstruction;
const hex = (k: PublicKey) => Buffer.from(k.toBytes()).toString('hex');

test('--referrer is a wallet on the curve; anything else is refused by name', () => {
  assert.equal(parseArgs(['open', 'BTC', 'long', '1', '--referrer', referrer.toBase58()]).flags.referrer, referrer.toBase58());
  assert.equal(referrerArg({}), null);
  assert.ok(referrerArg({ referrer: referrer.toBase58() })!.equals(referrer));
  assert.throws(() => referrerArg({ referrer: 'not-an-address' }), /referrer must be a wallet address/);
  const offCurve = PublicKey.findProgramAddressSync([Buffer.from('x')], new PublicKey(PROGRAM_ID))[0];
  assert.throws(() => referrerArg({ referrer: offCurve.toBase58() }), /on the curve/);
});

test('the link rides in the trade when the owner has none, and is left out once it exists', async () => {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const rpc = fakeRpc(accounts);
  (rpc.conn as unknown as { getAccountInfo: (k: PublicKey) => Promise<unknown> }).getAccountInfo = async (k: PublicKey) => accounts.get(k.toBase58()) ?? null;
  assert.equal(await referrerToLink({ rpc, owner, signer: null }, false), null, 'no referrer given: nothing to link');
  const to = await referrerToLink({ rpc, owner, signer: null, referrer }, false);
  assert.ok(to !== null && to.equals(referrer));

  // Knockout first trade: [init_trader_account, set_referral, open]; a later trade: [set_referral, open].
  const first = linked([stub('init_trader_account'), stub('open')], owner, to, 1);
  assert.deepEqual(first.map((b) => b.name), ['init_trader_account', 'set_referral', 'open']);
  const link = first[1]!;
  const metas = [...link.accounts, ...link.remaining];
  assert.equal(link.accounts[0]!.address, hex(owner), 'the referee is the owner');
  assert.equal(link.accounts[0]!.signer, true, 'the owner signs its own link');
  assert.equal(metas.at(-1)!.address, hex(referrer), "the referrer's wallet rides last, so the venue can make its record");
  // Minute: [set_referral, init_player, open_round].
  assert.deepEqual(linked([stub('init_player'), stub('open_round')], owner, to, 0).map((b) => b.name), ['set_referral', 'init_player', 'open_round']);

  accounts.set(referralLinkPda(owner).address.toBase58(), { data: Buffer.alloc(8), owner: new PublicKey(PROGRAM_ID), lamports: 1, executable: false });
  const again = await referrerToLink({ rpc, owner, signer: null, referrer }, false);
  assert.equal(again, null, 'a link is for life: a second one would refuse the trade, so it is left out');
  assert.deepEqual(linked([stub('open')], owner, again, 0).map((b) => b.name), ['open']);
});

test('a session key cannot carry the link, and the owner cannot refer itself', async () => {
  const rpc = fakeRpc();
  await assert.rejects(referrerToLink({ rpc, owner, signer: Keypair.generate(), referrer }, true), (e: { code?: string }) => e.code === 'REFERRER_NEEDS_OWNER');
  await assert.rejects(referrerToLink({ rpc, owner, signer: null, referrer: owner }, false), /cannot be the owner/);
});
