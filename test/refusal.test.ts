// A program error is read against the program that failed, never by its number alone (1000x row 898).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINUTE_PROGRAM_ID, PROGRAM_ID, errorForCode, minuteErrorForCode } from '@rekt-trading/1000x';
import { failedProgramOf, refusalOf } from '../src/rpc.ts';

const DUEL = 'DUELxkxcjSW9JJBSkC7hbkiZ89iY8G55TETKiQNEB63L';
const err = (code: number) => ({ InstructionError: [1, { Custom: code }] });
const failed = (program: string, code: number) => [`Program ${program} invoke [1]`, `Program ${program} failed: custom program error: 0x${code.toString(16)}`];

test('the failing program is the first failed line (the innermost frame)', () => {
  const logs = [`Program ${MINUTE_PROGRAM_ID} invoke [1]`, `Program ${PROGRAM_ID} invoke [2]`, `Program ${PROGRAM_ID} failed: custom program error: 0x17a2`, `Program ${MINUTE_PROGRAM_ID} failed: custom program error: 0x17a2`];
  assert.equal(failedProgramOf(logs), PROGRAM_ID);
  assert.equal(failedProgramOf(['Program log: x']), null);
});

test('a venue code is read with the venue table', () => {
  const v = errorForCode(6060)!;
  assert.equal(refusalOf(err(6060), failed(PROGRAM_ID, 6060)).code, v.name);
});

test('a Minute code is read with the Minute table', () => {
  const m = minuteErrorForCode(6055)!;
  assert.equal(refusalOf(err(6055), failed(MINUTE_PROGRAM_ID, 6055)).code, m.name);
});

test("another program's code is never read as a venue or Minute error (Duel 6058-6060 overlap the venue's)", () => {
  for (const code of [6058, 6059, 6060]) {
    const r = refusalOf(err(code), failed(DUEL, code));
    assert.equal(r.code, `PROGRAM_ERROR_${code}`);
    assert.ok(r.message.includes(DUEL));
    assert.notEqual(r.code, errorForCode(code)?.name);
  }
});

test('with no failing line, the instruction the error names gives the program', () => {
  const programs = ['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', PROGRAM_ID];
  assert.equal(refusalOf({ InstructionError: [2, { Custom: 6057 }] }, [], programs).code, errorForCode(6057)!.name);
  assert.equal(refusalOf({ InstructionError: [2, { Custom: 6060 }] }, [], ['a', 'b', DUEL]).code, 'PROGRAM_ERROR_6060');
});

test('with nothing to name the program, every reading is named and none is picked', () => {
  const r = refusalOf(err(6060), []);
  assert.equal(r.code, 'ERROR_6060');
  assert.ok(r.message.includes('venue'));
});

test('Wheelman never sends init_streak: the streak is automatic', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const code = readdirSync('src', { recursive: true }).filter((f) => String(f).endsWith('.ts')).map((f) => readFileSync(`src/${f}`, 'utf8')).join('\n');
  assert.ok(!/init_?streak/i.test(code));
});
