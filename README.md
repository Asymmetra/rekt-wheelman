# Wheelman

Wheelman, the Rekt trading bot and CLI: a bot, a command line and a local MCP server for Rekt
Knockout and Minute. You run it on your own machine, with your own wallet and your own RPC endpoint.
It uses the Rekt SDK, `@rekt-trading/1000x` from npm, for both games, and it sends nothing the risk
limits have not allowed.

**Status: 1.0.0, on mainnet.** Wheelman runs from a clone of this repository. It is not an npm package.

- Documentation: <https://docs.rekt.money>
- Contact: support@asymmetra.xyz
- License: Apache-2.0 (see `LICENSE`)

## Start in two minutes

Node 22.18 or later. There is no build step: Node runs the TypeScript directly. `npm link` puts
`wheelman` on your path; without it, run `node src/cli.ts` in its place. Run it from a clone: `npx`
and `npm install -g` from a git URL do not work, because Node does not run TypeScript from
`node_modules`.

```sh
git clone <this repository's URL> wheelman && cd wheelman
npm install && npm link
wheelman setup                           # wallet, RPC, strategy, risk limits; writes .env (mode 600)
wheelman markets                         # every market, its stake bounds and fees
wheelman preview BTC long 1 --target 2   # what an open costs and pays, after every fee
wheelman open BTC long 1 --paper         # a paper position: simulated, nothing sent
wheelman run --paper                     # the bot on paper
wheelman run --dry-run                   # builds and simulates the real transactions; sends nothing
wheelman run                             # the bot, trading
```

The wallet needs SOL for fees and rent (0.01 SOL is enough to start) and USDC for stakes.

## The CLI

| command | what it does |
|---|---|
| `markets` | every market: open or not and why, stake bounds, leverage, fees, room left on a side |
| `preview <market> <long\|short> <usd>` | the stake, the barrier, and the payout at the target and at the barrier, after every fee |
| `open <market> <long\|short> <usd>` | one Knockout position (`--target`, `--timer`), or a Minute round (`--minute`) |
| `close <id>` | asks the venue to close a position; the venue's keepers complete it |
| `positions` | open positions, live rounds, balances, today's result |
| `run [strategy]` | the bot |
| `setup` | onboarding; `--yes` takes every answer from the environment |
| `session start\|status\|end` | a session key for an agent (below) |
| `mcp` | a stdio MCP server with the same commands as tools (below) |

- `--paper` on `open`, `close`, `positions` and `run`: simulated fills on a paper account in
  `.wheelman/paper.json`. Nothing is sent.
- `--dry-run` on `open`, `close`, `run` and `session`: builds the real transaction, simulates it on
  mainnet, prints its compute units and bytes, and sends nothing. With no key, set `OWNER`.
- `-o json` prints one line: `{"ok": true, "data": ...}` or
  `{"ok": false, "error": {"category", "code", "message", "retryable"}}`. `retryable` is true only
  where sending the same request again cannot open a second position. The exit code is 0 on ok, 1 on
  an error, 2 on a bad flag.

Every `open`, from the CLI, an agent or the bot, passes the same risk limits. Amounts in the output
are USDC with 6 decimals; ids are text.

## Agents

Users bring their own agent (Claude Code, Codex, Cursor, or any MCP client). Wheelman hosts no agent
and holds no model key.

- **Session keys.** `wheelman session start --allowance 20 --expires 24h` (signed by the owner,
  once) authorises a freshly generated key to trade for the owner's wallet: at most the allowance in USDC, until
  the expiry. It also creates the owner's book when there is none and sends the key 0.01 SOL for its
  own fees (`--fuel`). The key is written to `wallets/session-keypair.json` (mode 600) before the
  transaction is sent. The command prints the two settings the agent needs: `OWNER` and
  `SESSION_KEYPAIR_PATH`. `wheelman session end` (the owner) ends it, drops the allowance and
  returns the key's SOL. The owner's key never goes to the agent.
- **MCP.** `wheelman mcp --env agent.env` serves `markets`, `preview`, `positions` and
  `session_status`. With a session key configured it adds `open` and `close`, signed by the
  session key; with `--paper` it adds them as paper-only. It never signs with the owner's key.

  | client | how to add it |
  |---|---|
  | Claude Code | `claude mcp add wheelman -- node /path/to/wheelman/src/cli.ts mcp --env /path/to/agent.env` |
  | Codex | in `~/.codex/config.toml`: `[mcp_servers.wheelman]`, `command = "node"`, `args = ["/path/to/wheelman/src/cli.ts", "mcp", "--env", "/path/to/agent.env"]` |
  | Cursor | in `.cursor/mcp.json`: `{"mcpServers": {"wheelman": {"command": "node", "args": ["/path/to/wheelman/src/cli.ts", "mcp", "--env", "/path/to/agent.env"]}}}` |

  `agent.env` holds `RPC_URL`, `OWNER`, `SESSION_KEYPAIR_PATH` and the risk limits, and no owner key.
- **Skill.** `skills/wheelman/SKILL.md` teaches an agent the CLI: copy the folder into your agent's
  skills folder.

## How it works

- **An open is an order.** The venue fills it at its own next price, after a short delay, or returns
  the whole stake. Wheelman needs prices only for a strategy's signal and for paper fills.
- **The venue closes positions.** A position ends at its barrier (the stake is gone), at its
  take-profit, at its timer, or after a close request. The venue's keepers send every close. A
  Minute round runs on Minute's clock and has no early close.
- **The chain is the state.** Positions, balances and today's settled results are read from the
  chain, so a restart or a fresh container is safe. `.wheelman/` holds the log, the paper account
  and a cache of settled transactions (they never change, so each is fetched once).
- **One loop.** Once a second the strategy reads the latest price and its own positions and returns
  intents. The risk guard checks each one. Each transaction is simulated first and sent only when it
  simulated clean. The result is read from the chain (the opened `seq`, the settlement).
- **One code path.** The CLI, the MCP server and the bot call the same functions. The venue layer
  (`src/client.ts`) has the shape of the SDK's Knockout client: `market`, `preview`, `open`,
  `positions`, `close`, `settlement`, `history`, `build`.

## Strategies

The bot runs one strategy. Pick one with `STRATEGY`, and set its parameters with `PARAM_<NAME>`. Every parameter has a default
and a bound, and the bot refuses a value outside the bound. The defaults are starting points, not
recommendations.

**`knockout-momentum`** (Knockout). Open in the direction of a move larger than trigger_bps over lookback_s.

| variable | default | bounds | meaning |
|---|---|---|---|
| `PARAM_STAKE_USDC` | 1 | 0.2 to 1000 | stake per position, in USDC |
| `PARAM_LOOKBACK_S` | 30 | 5 to 3600 | the window the move is measured over, in seconds |
| `PARAM_TRIGGER_BPS` | 5 | 1 to 1000 | the smallest move that opens a position, in basis points |
| `PARAM_TAKE_PROFIT_X` | 2 | 2 to 1000, or 0 | take-profit as a multiple of the stake, 0 for none |
| `PARAM_TIME_STOP_S` | 60 | 26 to 86400, or 0 | the position timer: the venue closes the position then; 0 for none |
| `PARAM_COOLDOWN_S` | 60 | 0 to 86400 | seconds to wait after a position ends |

**`knockout-fade`** (Knockout). Open against a sharp move; close when the price is back where the move started.

| variable | default | bounds | meaning |
|---|---|---|---|
| `PARAM_STAKE_USDC` | 1 | 0.2 to 1000 | stake per position, in USDC |
| `PARAM_LOOKBACK_S` | 20 | 5 to 3600 | the window the move is measured over, in seconds |
| `PARAM_TRIGGER_BPS` | 10 | 1 to 1000 | the smallest move that opens a position, in basis points |
| `PARAM_TAKE_PROFIT_X` | 2 | 2 to 1000, or 0 | take-profit as a multiple of the stake, 0 for none |
| `PARAM_TIME_STOP_S` | 30 | 26 to 86400, or 0 | the position timer: the venue closes the position then; 0 for none |
| `PARAM_COOLDOWN_S` | 60 | 0 to 86400 | seconds to wait after a position ends |
| `PARAM_CLOSE_ON_REVERT` | yes | yes, no | close when the price returns to where the move started |

**`knockout-straddle`** (Knockout). In a quiet market, open a long and a short of the same stake
together, in one transaction. A knockout ends one side; the other side runs to its take-profit or
its timer. One wallet may hold both sides of a market.

| variable | default | bounds | meaning |
|---|---|---|---|
| `PARAM_STAKE_USDC` | 1 | 0.2 to 1000 | stake of each side, in USDC |
| `PARAM_QUIET_S` | 60 | 5 to 3600 | the window the quiet filter looks at, in seconds |
| `PARAM_QUIET_BPS` | 3 | 0.1 to 1000 | open only when the range over quiet_s is at most this, in basis points |
| `PARAM_TAKE_PROFIT_X` | 3 | 2 to 1000, or 0 | take-profit as a multiple of the stake, 0 for none |
| `PARAM_TIME_STOP_S` | 120 | 26 to 86400, or 0 | the position timer: the venue closes the position then; 0 for none |
| `PARAM_COOLDOWN_S` | 120 | 0 to 86400 | seconds to wait after a position ends |

**`minute-trend`** (Minute). Each round, take the side of the move over lookback_s; skip a move below min_bps.

| variable | default | bounds | meaning |
|---|---|---|---|
| `PARAM_STAKE_USDC` | 1 | 0.01 to 100 | the total each round takes from the wallet, in USDC |
| `PARAM_LOOKBACK_S` | 30 | 5 to 3600 | the window the trend is measured over, in seconds |
| `PARAM_MIN_BPS` | 2 | 0 to 1000 | skip the round when the move is smaller than this, in basis points |

**`minute-schedule`** (Minute). Play every Nth minute at a fixed stake and side rule, inside a daily UTC window.

| variable | default | bounds | meaning |
|---|---|---|---|
| `PARAM_STAKE_USDC` | 1 | 0.01 to 100 | the total each round takes from the wallet, in USDC |
| `PARAM_EVERY_N` | 1 | 1 to 1440 | play in every Nth minute of the clock |
| `PARAM_SIDE` | alternate | long, short, alternate | the side of each round |
| `PARAM_START_HOUR_UTC` | 0 | 0 to 23 | the first hour of the window (UTC) |
| `PARAM_END_HOUR_UTC` | 24 | 1 to 24 | the hour the window ends (UTC) |

**`template`** (Knockout). A skeleton that never trades: copy `src/strategies/template.ts` to write
your own. A strategy is `{ id, game, params, onTick(ctx) }`; `onTick` returns intents and sends
nothing. Add it to `registry()` in `src/strategies/index.ts`, or load it with `EXTRA_STRATEGIES`.

The venue's own bounds also apply: the stake must be inside the venue's limits (Minute's for a
round), which Wheelman reads from the chain.

## Configuration

Environment variables only: `.env` on your machine (or `--env <file>`), the host's settings
elsewhere. `.env.example` lists every variable with one line on each. The ones you set:

| variable | meaning |
|---|---|
| `RPC_URL` | required: your HTTPS RPC endpoint |
| `KEYPAIR_PATH` or `WALLET_SECRET_KEY` | the owner's wallet |
| `OWNER`, `SESSION_KEYPAIR_PATH` | an agent's settings: the wallet's address and its session key |
| `STRATEGY`, `MARKET`, `PARAM_*` | what the bot trades |
| `MAX_STAKE_USDC`, `MAX_OPEN`, `DAILY_LOSS_USDC`, `MIN_BALANCE_USDC` | the risk limits |
| `PRICE_SOURCE` | `coinbase` (live, no key) or `replay` (a tape, paper mode) |

Wheelman checks every variable before its first RPC call and refuses a bad value with the reason.

## Risk limits

The risk guard sits between every intent and the venue: the bot's, `open`'s and an agent's. It never
blocks a close. It counts the worst case, every open stake lost, so no limit is passed after the fact.

| variable | default | Wheelman opens nothing that would |
|---|---|---|
| `MAX_STAKE_USDC` | 1 | stake more than this in one position or round |
| `MAX_OPEN` | 2 | hold more than this many positions and rounds at once |
| `DAILY_LOSS_USDC` | required | lose more than this today (UTC), counting every open stake as lost |
| `MIN_BALANCE_USDC` | 0 | leave the wallet below this, counting every open stake as lost |

**Wheelman refuses to trade without a daily loss stop.** Today's loss is read from the chain, so a
restart does not reset it. A session key adds the owner's own ceiling: its allowance and expiry.

## Paper mode

Paper results are priced by the SDK's own settlement arithmetic, with the terms a real position
freezes at open: the barrier, the target, the exit fee and the market's fee terms (the share of a
gain the venue keeps). A Minute round also pays Minute's own fees. Two things differ from live: the
fill is the next price Wheelman sees, not the venue's, and a one-shot command checks the barrier only
at the prices it reads (`run --paper` sees every tick). The borrow fee is not modelled; it is 0 today.
A paper result tests what Wheelman does; it does not say what live trading pays.

## RPC: any provider

Drop in any endpoint: Helius, Triton, QuickNode, or your own node. Wheelman uses little:

- **Stream first, poll last.** The bot subscribes to its own accounts (websocket, or Yellowstone gRPC
  with `GRPC_URL`), reads once after every reconnect, and reads at least every 30 s as a fallback.
- **Only its own accounts.** One `getMultipleAccounts` reads the venue, a market and the wallet's
  book. When a position ends, it reads its own book's latest transactions once to learn what it
  paid. It never scans a program's accounts.
- **One rate limit and one backoff per endpoint.** On HTTP 429 or JSON-RPC -32005 it waits 1 s,
  doubles to 30 s with jitter, and stops loudly after 5 attempts. `RPC_FALLBACK_URL` takes over only
  while `RPC_URL` fails.
- **`confirmed` on every call.** The blockhash and the priority fee are cached for a few seconds.
- **One send, one bounded rebroadcast.** It simulates first, sends with `maxRetries: 0`, sends the
  same bytes again every 2 s, and stops when the transaction confirms or its blockhash expires. On a
  Helius endpoint it asks Helius for the priority fee; elsewhere it uses recent fees. `SEND_URL` may
  point at a send-only endpoint.
- **No key in a log.** Every log line names the host only and redacts keys from URLs and errors.
- **It refuses early:** a non-mainnet endpoint, an unlisted market or a stake the venue does not take
  stops it before any spend.

## Prices

A price is needed only for a strategy's signal and for paper fills. `PRICE_SOURCE=coinbase` reads
Coinbase's public ticker (no key, no account) for BTC, ETH, SOL and XRP. `PRICE_SOURCE=replay` reads
a tape for paper mode: one JSON line a price, `{"time": 1767225600000, "market": "BTC", "price": 100000}`.
To add a source, write one function in `src/prices.ts` that returns a `PriceSource`.

## Hosting

The same variables work everywhere. One process, no database, no web server. A fatal error exits
non-zero, so every host restarts it. `Dockerfile` and `render.yaml` are templates for your own host:
you run Wheelman, with your own wallet; nobody hosts it for you.

- **Any server:** `npm ci --omit=dev && npm start` (that is `wheelman run`), under your process manager.
- **Docker:** `docker build -t wheelman .` then
  `docker run --env-file .env -v "$PWD/wallets:/app/wallets:ro" wheelman`.
- **Render:** `render.yaml` describes one background worker. Set `RPC_URL` and `DAILY_LOSS_USDC` in
  the dashboard and put the keypair in a Secret File named `bot-keypair.json` (or set
  `WALLET_SECRET_KEY`).

## Safety

- Wallet and session key files are written with mode 600 and never printed, logged or sent. Back up
  the wallet.
- Use a wallet for Wheelman alone, and fund it with what you are ready to lose. At the barrier a
  position pays nothing.
- Give an agent a session key, never the wallet. Size its allowance for one session and end it when
  you are done: a token allowance has no clock of its own.
- Never commit `.env`, `wallets/` or a keypair file; `.gitignore` excludes them.
- Use `--paper` and `--dry-run` before trading, and after every change you make.

## Development

`npm run check` runs the type check and the tests (Node's own test runner, no network).
