#!/usr/bin/env node
// wheelman: Wheelman, the Rekt trading bot and CLI. `wheelman help` lists the commands.
// With `-o json` every command prints one line: { ok: true, data } or { ok: false, error }.
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as cmd from './commands.ts';
import { Refusal, envelopeOf, toJson, type Envelope } from './errors.ts';
import { logToStderr, redact } from './journal.ts';
import { serve } from './mcp.ts';
import { setup } from './setup.ts';

const HELP = `wheelman <command> [arguments] [flags]

  markets                                      every market: open or not, stake bounds, fees, side room
  preview <market> <long|short> <usd>          what an open costs and pays, after every fee
  open <market> <long|short> <usd>             open a position (--minute: a Minute round)
  close <id>                                   ask the venue to close a position
  positions                                    open positions, rounds, balances, today's result
  run [strategy]                               run the bot (STRATEGY and PARAM_* from the environment)
  setup                                        write .env and a wallet (--yes: answers from the environment)
  session start|status|end                     a session key for an agent (--allowance, --expires, --fuel)
  mcp                                          a stdio MCP server with the same commands as tools

flags
  -o json            print one JSON envelope
  --paper            simulated fills; sends nothing (open, close, positions, run, mcp)
  --dry-run          build and simulate on mainnet; sends nothing (open, close, run, session)
  --target <x>       take-profit as a multiple of the stake (2 or more)
  --timer <s>        the position's own timer in seconds (26 or more)
  --minute           a Minute round instead of a Knockout position
  --market <m>       the market of a paper close or paper positions
  --allowance <usd>  session: the most it may spend          --expires <time>  session: 30m, 24h, 7d
  --fuel <sol>       session: SOL for its fees (0.01)         --env <file>      load this file, not .env
  --yes, --force     setup: no prompts; replace .env`;

const BOOLEAN = new Set(['paper', 'dry-run', 'minute', 'yes', 'force', 'help']);
const VALUE = new Set(['output', 'env', 'target', 'timer', 'market', 'allowance', 'expires', 'fuel']);

export interface Parsed {
  words: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-o') {
      flags.output = argv[++i] ?? '';
      continue;
    }
    if (!a.startsWith('--')) {
      words.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (BOOLEAN.has(name)) flags[name] = true;
    else if (VALUE.has(name)) flags[name] = inline ?? argv[++i] ?? '';
    else throw new Refusal('config', 'BAD_ARGUMENT', `unknown flag --${name}`);
  }
  if (flags.output !== undefined && flags.output !== 'json' && flags.output !== 'text') throw new Refusal('config', 'BAD_ARGUMENT', '-o takes json or text');
  return { words, flags };
}

const numberFlag = (f: Parsed['flags'], name: string): number | undefined => {
  if (f[name] === undefined) return undefined;
  const n = Number(f[name]);
  if (!Number.isFinite(n)) throw new Refusal('config', 'BAD_ARGUMENT', `--${name} takes a number`);
  return n;
};

/** Run one command and return its envelope. `signal` stops a running bot. */
export async function execute(p: Parsed, ctx: cmd.Ctx, signal: AbortSignal): Promise<Envelope> {
  const f = p.flags;
  const [command, ...rest] = p.words;
  const args: cmd.Args = {
    paper: f.paper === true, dryRun: f['dry-run'] === true, minute: f.minute === true,
    target: numberFlag(f, 'target'), timer: numberFlag(f, 'timer'), fuel: numberFlag(f, 'fuel'),
    market: typeof f.market === 'string' ? f.market : undefined,
    allowance: typeof f.allowance === 'string' ? f.allowance : undefined, expires: typeof f.expires === 'string' ? f.expires : undefined,
  };
  try {
    const data = await (async () => {
      switch (command) {
        case 'markets': return cmd.markets(ctx);
        case 'preview': return cmd.preview(ctx, { ...args, market: rest[0], side: rest[1], usd: rest[2] });
        case 'open': return cmd.open(ctx, { ...args, market: rest[0], side: rest[1], usd: rest[2] });
        case 'close': return cmd.close(ctx, { ...args, id: rest[0] });
        case 'positions': return cmd.positions(ctx, args);
        case 'run': return cmd.run(ctx, { ...args, strategy: rest[0] }, signal);
        case 'setup': return setup({ yes: f.yes === true, force: f.force === true, say: (l) => (f.output === 'json' ? console.error(l) : console.log(l)) });
        case 'session':
          if (rest[0] === 'start') return cmd.sessionStartCommand(ctx, args);
          if (rest[0] === 'status') return cmd.sessionStatusCommand(ctx);
          if (rest[0] === 'end') return cmd.sessionEndCommand(ctx, args);
          throw new Refusal('config', 'BAD_ARGUMENT', 'session takes start, status or end');
        default:
          throw new Refusal('config', 'UNKNOWN_COMMAND', `unknown command ${command ?? '(none)'}: run wheelman help`);
      }
    })();
    return { ok: true, data };
  } catch (e) {
    return envelopeOf(e);
  }
}

/** Plain text for people: one `key: value` a line, nested values indented. */
export function text(value: unknown, indent = ''): string {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' && v !== null ? `${indent}-\n${text(v, `${indent}  `)}` : `${indent}- ${String(v)}`)).join('\n');
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([k, v]) =>
      typeof v === 'object' && v !== null ? `${indent}${k}:\n${text(v, `${indent}  `)}` : `${indent}${k}: ${typeof v === 'bigint' ? v.toString() : String(v)}`).join('\n');
  }
  return `${indent}${String(value)}`;
}

async function main(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (e) {
    console.log(toJson(envelopeOf(e)));
    return 2;
  }
  const json = p.flags.output === 'json';
  if (p.flags.help === true || p.words[0] === 'help' || p.words.length === 0) {
    console.log(json ? toJson({ ok: true, data: { usage: HELP } }) : HELP);
    return 0;
  }
  try {
    if (typeof p.flags.env === 'string') process.loadEnvFile(p.flags.env);
    else if (existsSync('.env')) process.loadEnvFile('.env');
  } catch {
    console.log(toJson(envelopeOf(new Refusal('config', 'BAD_CONFIG', `${String(p.flags.env)} could not be read`))));
    return 1;
  }
  const ctx = await cmd.makeCtx(process.env, p.words[0] === 'mcp');
  if (p.words[0] === 'mcp') {
    logToStderr(true);
    await serve(ctx, { paper: p.flags.paper === true });
    return 0;
  }
  logToStderr(json);
  const abort = new AbortController();
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => abort.abort());
  const out = await execute(p, ctx, abort.signal);
  if (json) console.log(redact(toJson(out)));
  else if (out.ok) console.log(redact(text(out.data)));
  else console.error(redact(`${out.error.category} ${out.error.code}: ${out.error.message}${out.error.retryable ? ' (retryable)' : ''}`));
  return out.ok ? 0 : 1;
}

// Run when started as a program (also through the `wheelman` link npm makes), not when imported.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // Exit once stdout is written: an idle keep-alive socket must not hold a one-shot command open.
  main(process.argv.slice(2)).then((code) => process.stdout.write('', () => process.exit(code)));
}
