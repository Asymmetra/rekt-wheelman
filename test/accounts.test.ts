// The accounts a Minute round's venue open carries follow the market's feed kind.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTRUCTIONS_SYSVAR_HEX, govTablePda, toHex, type MarketView } from '@rekt-trading/1000x';
import { openRoundAccounts } from '../src/minute.ts';
import { venue } from './helpers.ts';

const { config, market } = venue(false);
const withKind = (kind: number): MarketView =>
  ({ ...market, feedKind: [kind, 0, 0, 0], feedCount: 1, feeds: ['ab'.repeat(32), '', '', ''], assetId: '01'.repeat(32), feeTermsRegs: 0 }) as unknown as MarketView;

test('a round on a feed-kind-3 market carries the governance table', () => {
  const accounts = openRoundAccounts(withKind(3), config);
  assert.equal(accounts[0], toHex(govTablePda().address));
  assert.ok(!accounts.includes('ab'.repeat(32)), 'the feed id is not an account');
});

test('a round on a feed-kind-2 market carries the Instructions sysvar, as before', () => {
  const accounts = openRoundAccounts(withKind(2), config);
  assert.equal(accounts[0], INSTRUCTIONS_SYSVAR_HEX);
  assert.ok(accounts.length > 0, 'Minute refuses an empty list');
});
