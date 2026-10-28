---
name: wheelman
description: Trade on Rekt Knockout and Minute with the wheelman CLI - read markets, preview what an open costs and pays, open and close positions, check positions and the session key, on paper or live. Use when the user asks to trade on Rekt, Knockout or Minute, to check their Rekt positions, or to run Wheelman.
---

# Wheelman

`wheelman` is a command line for Rekt Knockout (positions with a barrier and a take-profit) and Minute
(sixty-second rounds). Run it from the repository folder as `node src/cli.ts <command>`, or as
`wheelman <command>` after `npm link`. Always add `-o json`.

## The answer

Every command prints one JSON line:

- `{"ok": true, "data": ...}`
- `{"ok": false, "error": {"category", "code", "message", "retryable"}}`

Send the same command again only when `retryable` is `true`: then a resend cannot open a second
position. On `false`, read `message`, change something, or ask the user. Categories: `config` (fix the
arguments or the settings), `risk` (a limit the user set), `venue` (the program refused; `code` is its
error name), `rpc`, `send` (`UNCONFIRMED`: run `positions` before anything else), `session`, `paper`.

## Rules

1. **Paper first.** Use `--paper` until the user asks for live trading. Paper sends nothing.
2. **Preview before an open.** `preview` gives the payout at the target and at the barrier (nothing),
   after every fee. Show it to the user.
3. **Live trading uses a session key only.** The user (the owner) runs `wheelman session start`; you
   never hold or ask for the owner's key. Never print a key, a token or an RPC URL.
4. **Never change a limit or a stake the user set** (`MAX_STAKE_USDC`, `MAX_OPEN`, `DAILY_LOSS_USDC`,
   `MIN_BALANCE_USDC`, `PARAM_STAKE_USDC`). A `risk` refusal is the user's limit working.
5. **Report facts.** Say what happened and what it paid. Never state odds, a win rate or an expected
   value, and never present a paper result as what live trading pays.

## Commands

| command | what it does |
|---|---|
| `markets` | every market: open or not and why, stake bounds, leverage, fees |
| `preview BTC long 1.00 --target 2` | what an open costs, and pays at its target and at its barrier |
| `open BTC long 1.00 --target 2 --timer 60` | open a Knockout position (`--paper`, `--dry-run`) |
| `open BTC short 0.25 --minute` | open a Minute round |
| `close 74` | ask the venue to close position 74 (`--paper`, `--dry-run`) |
| `positions` | open positions, rounds, balances, today's result (`--paper`: the paper account) |
| `session status` | the session key: active or not, what it may still spend, when it expires |

Amounts are USDC text with 6 decimals. Ids are text. A position opens as an order: the venue's next
price fills it, so `entryPrice` is `null` for a moment. A Minute round has no early close.

## Set up

1. The owner: `wheelman setup` (wallet, RPC, limits), then
   `wheelman session start --allowance 20 --expires 24h`. It prints `OWNER` and `SESSION_KEYPAIR_PATH`.
2. The agent's settings file holds `RPC_URL`, `OWNER`, `SESSION_KEYPAIR_PATH` and the risk limits, and
   no owner key. Pass it with `--env <file>`.
3. The same commands are MCP tools: `node src/cli.ts mcp --env <file>` (add `--paper` for paper-only
   trading tools).

To install this skill, copy the `skills/wheelman` folder into your agent's skills folder: Claude Code
reads `~/.claude/skills/`, Codex reads `~/.codex/skills/`, Cursor reads `~/.cursor/skills/`.
