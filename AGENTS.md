# AGENTS.md

Instructions for an agent that sets up, runs, uses or changes Wheelman. `README.md` has the same
facts for people; `.env.example` is the one reference for every variable; `skills/wheelman/SKILL.md`
is the short guide to trading with the CLI.

## Rules

1. **Never print, log, commit or send a secret**: the wallet file, `WALLET_SECRET_KEY`, a session key
   file, `GRPC_TOKEN`, or an RPC URL (providers put the key in the URL). Refer to a key by its path.
2. **Never hold the owner's key to trade.** Trade with a session key (`OWNER` and
   `SESSION_KEYPAIR_PATH`), which the owner starts with `wheelman session start`.
3. **Never commit** `.env`, `wallets/`, `keys/`, `.wheelman/` or any `*keypair*.json`.
4. **Do not raise a risk limit, a stake or a session allowance without the owner's word**:
   `MAX_STAKE_USDC`, `MAX_OPEN`, `DAILY_LOSS_USDC`, `MIN_BALANCE_USDC`, `PARAM_STAKE_USDC`.
5. **Paper and dry run before live**, after every change: `npm run check`, then `--paper`, then
   `--dry-run`, then live.
6. **State no odds.** Report what happened (trades, results from the chain). Never state a win rate,
   an expected value or an edge, and never present a paper result as what live trading pays.

## Use the CLI

Run `node src/cli.ts <command> -o json` (or `wheelman <command> -o json` after `npm link`). Every
command prints one line, `{"ok": true, "data"}` or `{"ok": false, "error": {"category", "code",
"message", "retryable"}}`, and exits 0 on ok, 1 on an error, 2 on a bad flag. Send a command again only
when `retryable` is true; a `send` error with code `UNCONFIRMED` means: run `positions` first.

| command | sends money |
|---|---|
| `markets`, `preview`, `positions`, `session status` | no |
| `open`, `close` with `--paper` or `--dry-run`; `run --paper`, `run --dry-run` | no |
| `open`, `close`, `run`, `session start`, `session end` | yes |

## Set up without prompts

1. Node 22.18 or later: `node --version`. Then `npm install`.
2. Set the answers in the environment and run `node src/cli.ts setup --yes`. It writes `.env` (mode
   600) and, when no wallet is given, creates `wallets/bot-keypair.json` (mode 600) and prints its
   address. It refuses to replace an existing `.env` unless `--force` is added.

   ```sh
   RPC_URL='https://...' STRATEGY=knockout-momentum MARKET=BTC DAILY_LOSS_USDC=5 \
     node src/cli.ts setup --yes
   ```

   Required: `RPC_URL`, `DAILY_LOSS_USDC`. Optional: `KEYPAIR_PATH` (keep a keypair file) or
   `WALLET_IMPORT` (copy one into `wallets/`), `STRATEGY`, `MARKET`, `PARAM_*`, the limits, the RPC
   extras in `.env.example`.
3. Tell the owner the wallet address and what it needs: SOL for fees and rent (0.01 SOL to start) and
   USDC for stakes.
4. For an agent that trades: the owner runs `node src/cli.ts session start --allowance <usd>
   --expires <24h>`, then gives the agent a settings file with `RPC_URL`, the limits, and the
   `OWNER` and `SESSION_KEYPAIR_PATH` the command printed.

## Read the log

Each event is one JSON line in `.wheelman/journal.jsonl` (and a short line on stdout, or stderr under
`-o json` and `mcp`). The `kind` field:

| kind | meaning |
|---|---|
| `ready`, `state` | the configuration is accepted; positions, balances and today's result |
| `sent` | a transaction landed; `seqs` lists the positions it opened |
| `refused` | the venue or the network refused; `code` names it, `retryable` says if a resend is safe |
| `risk-refused` | the risk guard stopped an intent; `why` names the limit |
| `closed` | a position or round ended; `pnl` is its result from the chain |
| `collected` | money owed to the wallet was claimed |
| `stream-closed`, `rpc-standby` | a stream reconnects; the standby RPC took over |
| `simulated` | a dry run's transaction, with its compute units and bytes |
| `paper-*` | paper events; `paper-summary` ends a paper run |

## Change the code

| file | holds |
|---|---|
| `src/cli.ts` | the `wheelman` command line: flags, the envelope, text output |
| `src/commands.ts` | every command, shared by the CLI, the MCP server and the bot |
| `src/mcp.ts` | the stdio MCP server |
| `src/runner.ts` | the bot's loop and the live broker |
| `src/client.ts` | the Knockout client, in the shape of the SDK's (`market`, `preview`, `open`, `positions`, `close`, `settlement`, `history`, `build`) |
| `src/minute.ts` | Minute rounds, in the same shape |
| `src/account.ts` | balances, collecting what is owed, session keys, the transaction cache |
| `src/paper.ts` | paper accounts, priced by the SDK's settlement |
| `src/rpc.ts` | the rate limit, backoff, standby, streams, priority fee, and the one send path |
| `src/config.ts`, `src/setup.ts` | every variable and its bounds; onboarding |
| `src/risk.ts`, `src/prices.ts`, `src/journal.ts`, `src/errors.ts` | the guard, prices, the log, the envelope |
| `src/strategies/` | the strategies and the registry |

- A strategy: copy `src/strategies/template.ts`, add it to `registry()`, add its parameter table to
  `README.md`, and add a test on a fixed price path in `test/strategies.test.ts`.
- A command: one function in `src/commands.ts`, one line in `src/cli.ts`, and a tool in `src/mcp.ts`
  if an agent should have it; a test in `test/commands.test.ts` (and `test/mcp.test.ts`).
- Build every instruction with the SDK. Do not copy SDK logic into Wheelman.
- Money is `bigint` in USDC base units (`1_000_000n` is one dollar); parse text with `parseUsdc`.
- After a change to `src/client.ts`, `src/minute.ts`, `src/account.ts` or `src/rpc.ts`, run the dry
  runs before a live send.
- `npm run check` must pass before a commit.

Documentation: <https://docs.rekt.money>. Contact: support@asymmetra.xyz.
