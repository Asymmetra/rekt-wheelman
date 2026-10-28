// A local MCP server on stdio: the CLI's commands as tools, each answering with the same envelope.
// Read tools always. `open` and `close` only when a session key is configured (they then trade with
// it, never with the owner's key), or with `wheelman mcp --paper` (they then trade on paper only).
import { createInterface } from 'node:readline';
import * as cmd from './commands.ts';
import { MARKETS, parseConfig } from './config.ts';
import { Refusal, envelopeOf, toJson, type Envelope } from './errors.ts';
import { redact } from './journal.ts';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const order = {
  market: { type: 'string', enum: MARKETS, description: 'the market' },
  side: { type: 'string', enum: ['long', 'short'] },
  usd: { type: 'string', description: 'what leaves the wallet, in USDC, like "1.50"' },
  target: { type: 'number', description: 'take-profit as a multiple of the stake (2 or more); omit for none' },
  timer: { type: 'number', description: 'the position timer in seconds (26 or more); omit for none' },
  minute: { type: 'boolean', description: 'a Minute round instead of a Knockout position' },
};
const modes = {
  paper: { type: 'boolean', description: 'simulated fills; sends nothing' },
  dry_run: { type: 'boolean', description: 'build and simulate on mainnet; sends nothing' },
};

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint: boolean };
  run: (ctx: cmd.Ctx, a: Record<string, unknown>) => Promise<unknown>;
}

const args = (a: Record<string, unknown>): cmd.Args => ({
  market: a.market as string | undefined, side: a.side as string | undefined, usd: a.usd === undefined ? undefined : String(a.usd),
  target: a.target as number | undefined, timer: a.timer as number | undefined, minute: a.minute === true, id: a.id === undefined ? undefined : String(a.id),
  paper: a.paper === true, dryRun: a.dry_run === true,
});

const READ: Tool[] = [
  { name: 'markets', description: 'Every market: open or not and why, stake bounds, leverage, fees, room left on each side.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: true }, run: (ctx) => cmd.markets(ctx) },
  { name: 'preview', description: 'What an open costs and what it pays at its target and at its barrier, after every fee. Sends nothing.',
    inputSchema: { type: 'object', properties: order, required: ['market', 'side', 'usd'] }, annotations: { readOnlyHint: true, openWorldHint: true },
    run: (ctx, a) => cmd.preview(ctx, args(a)) },
  { name: 'positions', description: 'The wallet\'s open positions and Minute rounds, its balances and today\'s result (paper: the paper account).',
    inputSchema: { type: 'object', properties: { paper: modes.paper } }, annotations: { readOnlyHint: true, openWorldHint: true },
    run: (ctx, a) => cmd.positions(ctx, args(a)) },
  { name: 'session_status', description: 'Where the session key stands: active, expired or ended, what it may still spend, when it expires.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: true }, run: (ctx) => cmd.sessionStatusCommand(ctx) },
];

const trading = (paperOnly: boolean): Tool[] => {
  const force = (a: Record<string, unknown>) => (paperOnly ? { ...a, paper: true } : a);
  const note = paperOnly ? ' Paper only: simulated fills, nothing is sent.' : ' Signed with the session key, inside its allowance and expiry, after the risk limits.';
  return [
    { name: 'open', description: `Open a Knockout position (or a Minute round with minute: true).${note}`,
      inputSchema: { type: 'object', properties: { ...order, ...modes }, required: ['market', 'side', 'usd'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, run: (ctx, a) => cmd.open(ctx, args(force(a))) },
    { name: 'close', description: `Ask the venue to close a Knockout position by its id.${note}`,
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'the position id (its seq)' }, market: order.market, ...modes }, required: ['id'] },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, run: (ctx, a) => cmd.close(ctx, args(force(a))) },
  ];
};

/** The tools this server offers: trading tools only with a session key, or on paper. `--paper` wins over a session key. */
function toolsFor(ctx: cmd.Ctx, paper: boolean): Tool[] {
  let session = false;
  try {
    session = parseConfig(ctx.env, {}, ctx.strategies).session !== null;
  } catch {
    // a bad configuration still serves the read tools, which then say what is wrong
  }
  return paper ? [...READ, ...trading(true)] : session ? [...READ, ...trading(false)] : READ;
}

export async function serve(ctx: cmd.Ctx, o: { paper: boolean; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Promise<void> {
  const output = o.output ?? process.stdout;
  const tools = toolsFor(ctx, o.paper);
  const send = (message: unknown) => output.write(`${redact(toJson(message))}\n`);
  const lines = createInterface({ input: o.input ?? process.stdin, crlfDelay: Infinity });
  const pending: Promise<void>[] = [];

  const answer = async (m: { id?: string | number; method?: string; params?: Record<string, unknown> }) => {
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const asked = String(m.params?.protocolVersion ?? '');
        return reply({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} },
          serverInfo: { name: 'wheelman', version: '1.0.0' },
          instructions: 'Wheelman trades on Rekt Knockout and Minute. Every tool answers with {ok, data} or {ok: false, error: {category, code, message, retryable}}. Retry only when retryable is true.',
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.map(({ run: _run, ...t }) => t) });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === m.params?.name);
        if (tool === undefined) return fail(-32602, `unknown tool ${String(m.params?.name)}`);
        let out: Envelope;
        try {
          out = { ok: true, data: await tool.run(ctx, (m.params?.arguments as Record<string, unknown> | undefined) ?? {}) };
        } catch (e) {
          out = envelopeOf(e instanceof Error || e instanceof Refusal ? e : new Error(String(e)));
        }
        return reply({ content: [{ type: 'text', text: toJson(out) }], isError: !out.ok });
      }
      default:
        if (m.id !== undefined) return fail(-32601, `unknown method ${String(m.method)}`);
    }
  };

  for await (const line of lines) {
    if (line.trim() === '') continue;
    let m: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    // A notification (no id) gets no answer; requests are answered as they finish.
    pending.push(answer(m).then(() => undefined));
  }
  await Promise.all(pending);
}
