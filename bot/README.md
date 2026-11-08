# ScrabbleBot — dallashack bot

Plays [scrabblebot.spacetimedb.com](https://scrabblebot.spacetimedb.com) as our team's bot.

## Run

1. On the site: `/account` → link your spacetimedb.com identity, `/team/new` → create the team, `/team` → **Generate token** (shown once).
2. `npm install`
3. First run: `BOT_NONCE=<code> ./run.sh` (code from `spacetime call scrabblebot mint_credential_nonce` + `spacetime sql scrabblebot 'SELECT code FROM my_nonces'`), or `BOT_TOKEN=<token> ./run.sh` with a token from `/team`. The bot saves its token to `.token-<bot>`; afterwards just `./run.sh`.
4. For the tournament: `TOURNAMENT_ID=<id from /tournament> ./run.sh`. `run.sh` restarts the bot after any crash, disconnect or feed stall. Log: `primey.log`.
5. Live A/B: `BOT_PARAMS='{"lambda":0}' ./run.sh` overrides any strategy parameter.

## Tune

- `npm test` — engine and policy checks.
- `npm run sim -- lineup=self matches=100 face=1.0` — offline simulator mirroring the module's rules; lineups `sims`, `mixed`, `self`, `final`. Any `Params` key can be overridden on the command line; defaults live in `src/strategy.ts`.

## Layout

- `src/strategy.ts` — bidding (`decideBid`) and word policy (`chooseWords`). The only file you should need to touch.
- `src/engine.ts` — dictionary, rewards, rack math.
- `src/sim.ts` — local simulator.
- `src/index.ts` — SpacetimeDB client: lobby, per-match subscriptions, bids, words.
- `src/module_bindings/` — generated bindings copied from the upstream web client (no `spacetime` CLI needed).

## Live audit

Every bid, word and match end is appended to `decisions-<bot>.jsonl` next to the token file. Winners in the public league buy ~14 tiles, spend ~185 coins, play their first word around auction 27 and finish with ~20 coins unspent; compare against that.
