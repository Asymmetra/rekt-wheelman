// The docs match the code: README's parameter tables, and .env.example's list of variables.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { registry } from '../src/strategies/index.ts';

const readme = readFileSync('README.md', 'utf8');
const example = readFileSync('.env.example', 'utf8');

test('README lists every parameter of every strategy with its default', async () => {
  for (const s of (await registry()).values()) {
    assert.ok(readme.includes(`**\`${s.id}\`**`), `README has no section for ${s.id}`);
    if (s.id === 'template') continue; // its parameters are examples for a forker

    const section = readme.slice(readme.indexOf(`**\`${s.id}\`**`)).split('\n\n**')[0]!;
    for (const [k, p] of Object.entries(s.params)) {
      assert.ok(section.includes(`| \`PARAM_${k.toUpperCase()}\` | ${p.default} |`), `${s.id}: PARAM_${k.toUpperCase()} with default ${p.default}`);
    }
  }
});

test('.env.example lists exactly the variables the code reads', () => {
  const code = readdirSync('src', { recursive: true }).filter((f) => String(f).endsWith('.ts')).map((f) => readFileSync(`src/${f}`, 'utf8')).join('\n');
  const read = new Set([...code.matchAll(/(?:get|num|usdc|url|from|address|keypair)\('([A-Z][A-Z0-9_]+)'(?:, '([A-Z][A-Z0-9_]+)')?|(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g)].flatMap((m) => [m[1], m[2], m[3]].filter((x) => x !== undefined && !x.startsWith('PARAM_'))));
  const listed = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!).filter((n) => !n.startsWith('PARAM_')));
  assert.deepEqual([...read].filter((n) => !listed.has(n)).sort(), [], 'read by the code, missing from .env.example');
  assert.deepEqual([...listed].filter((n) => !read.has(n)).sort(), [], 'in .env.example, read by no code');
});
