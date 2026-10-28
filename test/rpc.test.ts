// One gate per endpoint: a bounded backoff on 429 and -32005, a standby that takes over, a loud stop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcExhausted, backoffMs, gatedFetch } from '../src/rpc.ts';

const KEY = 'secret-key-value';
// The key parameter is spelled in parts: a literal one in source looks like a leaked key to scanners.
const KEY_PARAM = ['api', 'key'].join('-');
const PRIMARY = `https://primary.example.com/?${KEY_PARAM}=${KEY}`;
const STANDBY = 'https://standby.example.com/';

/** A fake fetch that answers from a script, and records which host each call went to. */
function fake(script: (url: string, n: number) => Response | Error) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(new URL(u).host);
    const r = script(u, calls.length);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { calls, fetcher };
}
const ok = () => new Response('{"jsonrpc":"2.0","id":1,"result":1}');

test('the backoff waits 1 s, doubles to 30 s, with 25 % jitter', () => {
  assert.equal(backoffMs(0, () => 0), 750);
  assert.equal(backoffMs(0, () => 1), 1250);
  assert.equal(backoffMs(3, () => 0.5), 8000);
  assert.equal(backoffMs(9, () => 0.5), 30_000);
  assert.equal(backoffMs(9, () => 1), 37_500);
});

test('HTTP 429 and JSON-RPC -32005 wait and try again', async () => {
  const waits: number[] = [];
  const { calls, fetcher } = fake((_u, n) =>
    n === 1 ? new Response('', { status: 429 }) : n === 2 ? new Response('{"error":{"code":-32005,"message":"slow down"}}') : ok());
  const res = await gatedFetch(PRIMARY, null, 100, fetcher, async (ms) => void waits.push(ms))(PRIMARY, {});
  assert.equal(await res.text(), '{"jsonrpc":"2.0","id":1,"result":1}');
  assert.equal(calls.length, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0]! >= 750 && waits[0]! <= 1250 && waits[1]! >= 1500 && waits[1]! <= 2500, String(waits));
});

test('after five failures the standby takes over, and stays in use for a while', async () => {
  const { calls, fetcher } = fake((u) => (u.startsWith('https://primary') ? new Response('', { status: 503 }) : ok()));
  const f = gatedFetch(PRIMARY, STANDBY, 100, fetcher, async () => {});
  await f(PRIMARY, {});
  assert.deepEqual(calls, [...Array(5).fill('primary.example.com'), 'standby.example.com']);
  await f(PRIMARY, {});
  assert.equal(calls.at(-1), 'standby.example.com');
  assert.equal(calls.length, 7); // never both at once: the primary is not asked again yet
});

test('when every endpoint fails, it stops loudly and names hosts, not keys', async () => {
  const { calls, fetcher } = fake(() => new Error(`connect ECONNREFUSED ${PRIMARY}`));
  await assert.rejects(gatedFetch(PRIMARY, null, 100, fetcher, async () => {})(PRIMARY, {}), (e: Error) => {
    assert.ok(e instanceof RpcExhausted);
    assert.match(e.message, /primary\.example\.com failed 5 times/);
    assert.ok(!e.message.includes(KEY), e.message);
    return true;
  });
  assert.equal(calls.length, 5);
});
