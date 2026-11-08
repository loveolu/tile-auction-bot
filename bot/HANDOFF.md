# >>> NEXT SESSION: START HERE (written Sat Nov 7 ~9:20 PM CT) <<<

Status at handoff:
- Bot "Primey" is LIVE and detached (run.sh pid 40709 and caffeinate pid 40742, both owned by launchd; they survive this chat ending). Rating ~2080, rank ~28/194.
- LIVE A/B #2 is running since match 45953: arm b = `{"seedPlan":1,"starve":13,"starveMin":18,"rebidDown":1}` vs arm a = current shipped build (cash7 30). Scorecard: `cd ~/Projects/dallashack/bot && python3 ab.py 45953`. At handoff: a n=3 92.7 avg / place 2.33; b n=1 84 / place 2.00 (too early).
- Laptop: Low Power Mode OFF; was on battery 64% (ask the user to plug in).

Your next steps, in order:
1. Re-arm a log watch: `tail -n 0 -f ~/Projects/dallashack/bot/primey.log | grep --line-buffered -E "ended, score|registered|tournament|exited with|connect error \((1|15|29)\)"`.
2. ~10:15 PM CT: decide the A/B (rule in "LIVE A/B #2" below): ship arm b's params into DEFAULT_PARAMS in src/strategy.ts only if arm b is not worse on place; relaunch plain `./run.sh` at a match boundary; re-attach caffeinate to the NEW run.sh pid; verify with `pgrep -fl caffeinate`. Then LOCK: no more strategy changes.
3. Watch for the tournament to open (status Registration) and run the TOURNAMENT PROCEDURE below immediately.
4. The user will paste external AI reviews. Verify every concrete claim against code/logs before acting; reject anything listed in the evidence log; test new ideas with `npm run sim -- lineup=utd ... compare=` (paired), never ship untested; never restart mid-match (only right after an "ended, score" log line).

Paste-ready prompt for the new session:
"Read your memory and ~/Projects/dallashack/bot/HANDOFF.md (START HERE block first). The bot is live; continue from the next steps listed there."

# HANDOFF — ScrabbleBot "Primey" (team Black and Yellow), HackUTD 2026

Read this first. The bot is RUNNING; do not stop it except at a match boundary and for a reason.

## State (Nov 7 2026, evening)
- Bot id 191 "Primey", team 185. Rating ~2150 ±125, rank ~15/170 after ~120 ladder matches. Locked build (from match 45204): 73,105,78,115,95,89,79,131,110,80 → avg 96, none under 70.
- Process: `./run.sh` (restart loop) → `npm start` (tsx src/index.ts). Log `primey.log`. Decisions `decisions-Primey.jsonl`.
  Machine is held awake by `caffeinate -i -s -w <run.sh pid>`; re-run that if you relaunch run.sh. Get the pid AFTER run.sh is up (`pgrep -f run.sh`), then verify with `pgrep -fl caffeinate`; a stale pid makes caffeinate exit silently.
- Token: `.token-Primey` (never commit, never paste). CLI: `~/.local/bin/spacetime`, logged in.
- Restart safely: `pkill -f "tsx src/index.ts"` (run.sh relaunches in 2 s). Only right after a line containing "ended, score" (a word-play line like "play X (+n)" means the match is still running).

## SHIPPED (Nov 7 evening): `cash7: 30` is now the default (was a live A/B)
- Launched as `BOT_AB='{"cash7":30}' ./run.sh` from match 45368. Arm b = cash a playable 7+ word immediately when balance < 30. Score it: `python3 ab.py 45368`. Since match 45631 the arm is a hash of the match id (stable across reconnects); 45592 and 45609 had mixed arms and are skipped in ab.py.
- Why: audit of 112 live matches — 100+ games buy 15.3 tiles vs 9.1 in <75 games; the split is AFTER the first third (10.7 vs 4.1 tiles). Table price (12.8 vs 12.7) and opponent rating (1820 vs 1938) barely differ. Bad games: first 7-letter word at auction 53 vs 37, 17 auctions spent broke, the bot holds a playable 7-word while broke and cashes it at the last auction. The first 7-word is the gate for the whole match.
- Sim gate passed: utd cash7=30 → score +5.2 ±4.3, place −0.68 ±0.46 (significant); utd cash7=always → neutral; field cash7=30 → −5.2 ±5.3 (n.s.).
- Result after 35 live matches: cash7 arm 92.7 avg / place 2.50 / 5 wins vs control 84.2 / 2.84 / 3 wins. Shipped: DEFAULT_PARAMS has `cash7: 30`; bot relaunched plain `./run.sh` (no BOT_AB) after match 45706. Every match now logs `arm a` = this build.

## Machine / lag finding (Nov 7 evening) — CHECK THIS FIRST ON EVENT DAY
- In lag-hit matches (45609: 54, 45631: 51) the SERVER ran auctions on time (closed within 0.4 s of schedule) but OUR decisions had gaps up to 8 s and 15–25 bids were refused as "Auction closed". The lag is on our machine, not the server.
- Causes found: laptop on battery (60%), macOS Low Power Mode ON (throttles CPU/network), a Brave renderer tab at 220% CPU for 2.5 h (load 4–6). `caffeinate -s` only prevents sleep on AC power.
- Fix on the machine (user must do it — system settings): plug in, turn Low Power Mode off, close heavy browser tabs. Check with `pmset -g | grep lowpowermode` (want 0) and `pmset -g batt`.
- Code fix applied: watchdog limit is a fixed 6 s (was 4×rtt, which inflated with our own stalls) with a 15 s reconnect backoff.

## Rival fingerprint (subagent, Nov 7 evening; scripts in the session scratchpad `fp/`)
- 17 strongest active bots, last 40 matches each. Only GoatBot (1542: flat 12 on 1-point letters, wins 31/40 final tiles) and scrabblemaxxing (1701: floor ~10, 42/24/8 coin reserve) bid predictably. LUCENT, Lbender, aipom, LexForge, RackMaw, Bron show no fixed floor and no public repo. exzell's live settings differ from its repo. Rival-specific counters are worth <1 tile/match: not built.
- About US (the real finding): Primey's median balance is 13 at auction 46 and 6 at auction 58, rivals hold 20–36; we lose ~6 tiles/match by 0–2 coins (267 in 44 matches). The second-to-last tile is the cheapest playable tile (median 8, 16% at ≤2 coins) and we are too broke to buy it. Cash flow is the bottleneck → cash7 (in live A/B). A flat `bump` was tested and REJECTED.

## External AI review (checked Nov 7 evening) — do NOT apply its fixes 2 and 4
1 hold-7-while-broke: correct, = cash7 (live A/B). 2 "turn rebuild floor on": already tested, worse (place +0.5). 3 instant pre-bid: only 0.37 refused bids/match (0.5%), our bid leaves ~57 ms after open (p90 134 ms); low value. 4 tie-bump +1/+2: tested, rejected. 5 Q-without-U: 5 wasted Qs in ~110 matches, <1 coin/match.

## External AI review #2 ("unconventional edges", checked Nov 7 ~9:10 PM) — nothing to ship
1 k=0 "black hole": budget includes incomeShare so wins>0 when broke; live: 2 zero-bids with balance>=3 and nRem>5 in the last 30 matches (~2000 bids). Not real.
2 pre-computed 26-letter bid table: brain.bid takes 6-17 ms cold, 0.1 ms warm on the loaded laptop (bench in scratchpad bidtime.ts); refused bids come from 500-3800 ms RTT / feed lag, not compute. Not worth it; fix the machine load instead.
3 dump at nRem<=2: effectiveNRem already moves the dump earlier when rtt p90 is high. Real end-dump losses: 2 in ~130 matches (45729 DEN, 45741 FOLDER, both after a watchdog reconnect). Early dump wastes the last tile every match. Untested, rejected.
   Side finding: after a reconnect, an ended match whose matchState row is gone stays in `live`; myRack.onInsert then re-submits its last word (FOLDER/45741) at later match starts -> "Match not running". Harmless (1 rejected call). Post-tournament fix: in playWords, `if (!m || m.status.tag !== "Running") return 0`.
4 Swiss variance: advice only; ab.py already scores place and swiss-pts. No change.
5 rival-balance cap and heads-up drain: already implemented (rivalCap, drain 0.8).
Checklist extras: 5/6-letter liquidity floor = starve 13/starveMin 18 (live A/B #2 arm b); glue floor >=10 when rich = rebuild/bump family, both rejected with numbers.

## External AI review #3 ("dynamic budgets / endgame denial / recovery", checked Nov 7 ~9:10 PM)
1 reconnect enters the whole match history: CONFIRMED. matchParticipant.onInsert fired enterMatch for every historical row (2-25 stale "playing" lines per reconnect, each with its own 4-query subscription; the stale FOLDER replays came from this). FIXED in index.ts: `initial` flag, only rows inserted after onApplied enter a match; onApplied still enters the newest. Takes effect at the next relaunch.
2 stale latency shuts the endgame down: real but small. 82 given-up auctions (nRem 0, bid 0, balance>=3) in 212 matches; the normal tail is 2 per match (the final auction's tile is unplayable: server closeAuction ends the match in the same tx, so bidding 0 there is right). Excess beyond that: ~30 auctions total, all in lag matches where bids were being refused anyway. Not changed. Side question being tested: the lag margin `lagK` (2*rtt+300 gives up the second-to-last auction at rtt>350 ms, which is most matches now); param added, default 2 = old behavior; sim lag=300/600 compare lagK=1 pending.
3 rivals can cash a word mid-auction so rivalsMax is not a hard cap: true; affects only lambda in Vickrey (rivalCap was neutral in sim) and the first-price search cap. Low value, not changed.
4 terminal denial (spend dead coins to block the last tile): the final auction's tile cannot be played by anyone (see 2), so denial would have to be at the second-to-last auction, where we already bid all-in (lambdaMin) on useful letters; for useless letters it needs the rival's rack, which we don't know. Not built.
5 rival rack reconstruction from auction_result + word_play: post-tournament idea.
6 final = aggregate score over 3 games, Swiss points share ties: confirmed from tournament.ts; wording above corrected. No bot change (it maximizes score anyway).

## DEEP REVIEW (own, Nov 7 ~9:30 PM; server data for all 219 matches in the session scratchpad, review.py / review_rows.json)
- No decline. Avg by period: pre-lock 86.5, locked+cash7 A/B 85.8, cash7 shipped 80.7 (n=18, 8 PM machine episode), since 9 PM 93.8. Scores are a wide stable distribution (sd ~20); the 70s are its bottom third, not a ceiling. Places since 45204 (6-seat): 1st 20, 2nd 26, 3rd 28, 4th 14, 5th 10, 6th 4.
- What the score is: tiles bought (r=+0.84) and coins spent (r=+0.89). Good (>=100) vs bad (<80): 16.1 vs 9.4 tiles, 193 vs 133 coins, 12.3 vs 14.1 per tile, first 7-word at 31 s vs 47 s, early tiles 5.4 vs 3.5, missed auctions 0.6 vs 2.6. Rival rating (r=-0.12) and table price (r=-0.05) do not matter; rivals' average score does (r=-0.32).
- LATENCY IS THE SERVER since 8 PM: server auction-close lateness p90 by hour 5/14/15/136/438 ms (17h..21h), 1790 ms in match 46373 (rtt p90 4.9 s) while OUR reaction (decision time - opens_at) stayed median 60-70 ms, p90 ~140 ms all evening. One machine episode only: 20:00-20:15 (p90 803 ms, 18% of bids >300 ms). Compute is not it: brain.bid is 6-17 ms, 150 ms worst on 20-tile racks.
- Latency -> score mechanism: with rtt p90 > 350 ms the endgame formula (lagK=2) dumps at bagTotal=2 and stops bidding; unspent coins at the end: median 5 (rtt<=350, n=74) vs median 16 (rtt>350, n=24). About one tile per laggy match, and laggy matches are now the majority. lagK=1 sims (utd, paired): lag300 +5.5±4.1 / +1.9±4.0 (pooled +3.7±2.9, place -0.28±0.23), lag450 +0.4±4.4, lag600 -0.6±4.3.
- Own-load note: sims and analysis on this laptop run on the same CPU as the live bot; keep them off during the tournament.

## SHIPPED 9:20 PM (match 46450 onward): lagK 1 + reconnect fix, plain ./run.sh (A/B #2 bundle NOT shipped: place 2.58 vs 2.38 after 12 matches)
- lagK 1: give up the second-to-last auction only when 1*rttP90+300 > 1000 (rtt > 700 ms) instead of 2*rtt+300 (> 350 ms). Basis in the deep review above (unspent coins med 16 vs 5 in laggy matches) and paired sims.
- Reconnect fix (index.ts): a participant row entered only if its id is newer than the history seen at subscription time (SDK delivers initial rows AFTER onApplied, so a plain flag was not enough; the first relaunch still replayed FOLDER once). In the files now; live from the next restart (the tournament relaunch).
- Post-tournament lead: incomeShare 0.30 sim +4.3 ±4.9, place -0.47 ±0.37 (60 m, utd); 0.65 +1.8 ±3.3 n.s. Needs more seeds + live A/B.
- run.sh pid 47069, caffeinate 47095. Monitor the first matches of the new build against the 9 PM baseline (93.8 avg).

## SAME-TABLE COMPARISON vs the top bots (Nov 7 ~9:40 PM; 6-seat matches we shared, server data; script review.py in the session scratchpad)
Avg score at OUR tables: LexForge-Base 99.4 (n=19), LexForge-1107 98.2 (25), GodOfThudner 93.4 (25), Lbender 92.8 (27), aipom 92.1 (26), RackMaw 90.4 (21), LUCENT 89.3 (25), Primey 85.3 (173), Bron 82.3 (42). Their ladder averages (Bron 135, LUCENT 123) come from thousands of matches vs weak fields; at shared tables nobody averages 120. The real gap is 5-14 points to the LexForge/GodOfThudner tier.
Where the gap is: tiles bought BEFORE the first 7+ word and its timing. Primey 6.2 tiles / 39.5 s; LUCENT 4.4 / 26.5 s; Bron 4.0 / 27 s; GodOfThudner 4.4 / 31 s; LexForge-Base 5.0 / 31 s. Same first-word value (47 vs 39-55 pts). We buy ~2 extra tiles (~26 coins) before the income loop starts and start it ~10 auctions later. Leaders also take more points from short (5-6 letter) words: LexForge 22-24, aipom 32 vs Primey 18. Post-tournament lead #1: early-game completion targeting (letters that finish a 7-word from the current rack) and cheaper 5-6 letter cash plays; brainPremium was neutral vs utd clones but the utd lineup has none of these bots.
Repos: none of LUCENT/Bron/LexForge/RackMaw/GodOfThudner/Waupus/Lbender/aipom/maverick/jamesv3 is public (GitHub code search by name: 0 hits). HackUTD-era public repos (Nov 7-8): Nsujatno/wordgoat (GoatBot? has a benchmark + replay analysis; same "held ADMIXES 30 auctions" failure as ours), IKKNIGHT/nigel-scrabblebot, eedwardkim/scrabblebot-nigel, Aryan61056/tile-hoarders-scrabblebot (replay evaluator), at350/scrabblebot-lexicoin, godfreyponce/scrabblebot-jake, abhikhur27/abhi-and-the-astronauts-scrabblebot, srana3/dumpling-scrabblebot, Kolby-Schulz/scrabblebot, shreyask235/ScrabbleBot, FarrellJoswara/scrabblebot, RafidTawsif51/my-scrabblebot, Sukhman-Singh007/scrabblebot, James-Hodges/ScrabbleBot, prakhyanigam1/scrabblebot, AKdaAKA/scrabblebot-tuned, lluismer/Sepcis.

## External AI review #4 (checked Nov 7 ~10:00 PM) — TWO REAL DEFECTS FOUND
1 Phi() in strategy.ts is NOT a normal CDF: A&S erf approximation without sqrt(2) scaling or the 0.5(1+erf) map. Phi(0)=0, Phi(0-)=1: P(win) at bid 12.99/median 13 = 99.7%, at 13 = 0%, at 14 = 23%. CONFIRMED numerically. Correct CDF added as PhiNew behind param phiFix (default 0). Paired sims with the fix and current params: utd -2.2 ±3.7, elite -2.9 ±4.1; with lambdaScale reset to 1: -6.8 / -10.8. Every parameter (lambdaScale 0.7 above all) was tuned around the bug, so the fix needs a RETUNE (lambdaScale, incomeShare, lambdaMin, premiumCap) before it can ship. Post-tournament task #1.
2 Futures cache keyed only on the rack: plans built at 60 auctions left are reused at 2 left. CONFIRMED in code. Fix: param kKey=1 adds round(k) to the cache key. Sims (lag 300): utd +2.9/+4.8/+3.7 (place -0.15/-0.39/-0.23), elite +1.4/+1.7/+0.3 (place -0.17/-0.28/-0.08); 6/6 positive, 3 significant. SHIPPED 10:05 PM as default (kKey: 1), relaunch at a match boundary.
3 first 7-word late: same as our deep review. 4 sim action order differs from live (sim plays words then bids; live bids then plays): true, sim fidelity item. 5 unit tests never attach a Brain: true, test gap. 6 pool ignores our own starting rack: true, small. 7 first-price spend model: tournament is Vickrey. 8 rebidDown 0 keeps a stale high bid after playing: true, was in the losing A/B bundle, retest alone. 9 pending/reconnect hygiene: known. 10 compute is not the bottleneck: agrees.

## LIVE A/B #2 (restarted ~9:00 PM CT, from match 45953): bundle vs current
- `BOT_AB='{"seedPlan":1,"starve":13,"starveMin":18,"rebidDown":1}' ./run.sh`. Score: `python3 ab.py 45953`. (Matches 45902–45939 ran an earlier arm that also had cash7pick: ignore them.)
- Why cash7pick was dropped: sim utd seedPlan+starve WITHOUT the pick = +5.2 ±3.9, place −0.53 ±0.37 (60 m, significant, best variant); the pick alone was +0.4 (neutral). Completion premium in brain mode (`brainPremium`) on top of the bundle: −0.5 ±3.0 → rejected.
- Sim evidence (utd, paired): seedPlan+cash7pick +3.6 ±3.0, place −0.41 ±0.28 (100 m); starve13/min18 +3.1 ±1.3, place −0.40 ±0.20 (60 m); all three +2.5 ±3.5, place −0.26 (80 m, n.s.); field: no harm for either.
- Decision at ~10:15 PM CT: ship the bundle into DEFAULT_PARAMS only if arm b ≥ arm a on place; otherwise relaunch plain `./run.sh` (current = cash7 30). Then LOCK.

## TIMELINE (real clock): it was Sat Nov 7, 8:30 PM CT at this note. Bracket reportedly 10:45–11:45 PM CT tonight. Lock the build by ~10:15 PM; after that only tournament registration. Devpost needs a public repo link (user will push later; `.gitignore` at project root already excludes `.token-*`, logs, node_modules).

## TOURNAMENT PROCEDURE (the only thing that matters today)
1. When the admin opens it, the id appears on https://scrabblebot.spacetimedb.com/tournament (or `spacetime sql scrabblebot 'SELECT id, status FROM tournament'`, status Registration).
2. `pkill -f run.sh; pkill -f "tsx src/index.ts"; TOURNAMENT_ID=<id> nohup ./run.sh >> primey.log 2>&1 &` then re-run caffeinate.
3. Confirm `grep registered primey.log`. Registration only works from the bot process, only while status is Registration.
4. Leave it alone. The bot handles Vickrey and first-price, 2 to 11 seats, lag, reconnects.
5. Format last time: 4 Swiss rounds (6 pts for 1st … 1 for 6th), top 6 cut, elimination (last place out), then a 3-game final decided by AGGREGATE score over the 3 games (server FINAL_GAMES=3, crown()), not best-of-3. Swiss points = matchSize minus the number of bots strictly above you (ties share the higher place). Ties: total score, then lower bot id.

## Strategy (src/strategy.ts DEFAULT_PARAMS, mode lambda=2 → src/brain.ts)
K-13's method reimplemented: letter value = gain to the best final partition of rack + sampled future tiles (common random numbers), shadow price of a coin solved each auction so spend over remaining auctions = budget, truthful bid value/λ, first-price search, play-or-hold with coin bonus, exact-ish dump at the last auction. Ours on top: live-fitted market medians + phase curve (MARKET/PHASE), lag-aware endgame (effectiveNRem), premium cap (face ≥5 ≤ 0.7× market until last 15), rival-balance truncation, heads-up drain floor, in-process reconnect with lag-scaled watchdog.
Word engine: src/trie.ts (anagram trie, µs queries). Fallback static formula: lambda=0.

## Evidence log — DO NOT retest these
Shipped (paired on identical deals, then live): brain vs static +23; lambdaScale 0.85→0.7 live (place 1.75 vs 2.18); market refit; rivalCap (neutral, harmless); premiumCap (n.s., live overbuying of Z/Q).
Rejected: λ pacing on the old heuristic valuation (−26); in-match price calibration twice (−13/−25; feedback loop on own bids); starvation cash-in starve=25 LIVE (78.8 vs 95.2); aggression lambdaScale 0.55 LIVE and sim (−10; overspends early, then broke holding a 7-word); coinBonus 0.8 (−6); flat bid `bump` +2 on top of cash7 (utd place +0.43 ±0.32, field −12.1 ±7.1; +1 neutral-negative — paying more for near-miss tiles just goes broke sooner); hold-under-45, playMargin, kMax, samples, flex, leftover (all neutral); rebuild floor 0.9 (sim vs verified rivals: place −0.5 WITHOUT it → now 0).
Known failure modes seen live: hot tables (clearing 13–14, LUCENT/gas/Lbender/RackMaw/GoatBot) where our bids sit 1–2 under; feed stalls; server lag spikes to 6 s.

## Harness
- `npm run sim -- lineup=utd matches=40 seed=N compare='{"param":value}'` — paired A/B, 95% CI. `utd` = verified clones of exzell and Tow57 (formulas from their public repos) + our previous version + typical rivals; its prices match live. Other lineups: field, elite, ladder, final, finalfield. Flags: first=1 lag=600 seats=7.
- Ship rule: better in ≥1 field at 95% and worse in none; then live A/B via `BOT_AB='{"param":v}' ./run.sh` (alternates arms per match; `python3 ab.py <first match id>` scores it). 20+ matches per arm minimum.
- The sim overrates us vs weak clones; only `utd` and live are trusted for hot-table questions.

## AFTER the tournament (not before — risk without benefit)
- Remove dead/rejected flags from strategy.ts + brain.ts (bump, brainPremium, calRate, rebuild, cash7pick if not shipped, old static lambda 0/1 path) and their versions.ts entries.
- `git init` at ~/Projects/dallashack (`.gitignore` already excludes .token-*, logs, node_modules), commit, user pushes to a public GitHub repo, link on Devpost.
- Restart the Mac (a stuck `contactsd` uses one core). Only after the bot is stopped.

## Ideas not done (in order of expected value)
1. Per-rival bid models (Nijello's Tobit fits, bananatruck/scrabblebot-evo & 3nvyx/nijello-scabble-bot: K-13/Bron/maverick follow the market; LUCENT flat). K-13 says worth "a few coins".
2. Play-or-hold when broke: the brain holds 7-letter words for 40+ auctions when balance <15 (λ low). A fix must beat `utd` paired, not a threshold rule (starve=25 lost live).
3. Exact partition dump (ours is top-12 greedy, ~1–2 pts).
4. scrabblemaxxing clone (formula in research notes; many interlocking rules).

## Repos & references
clockworklabs/scrabblebot (game, MIT) · aryamehr2k/k13-scrabblebot (champion; USER'S CALL Nov 7: copying its code/details as a base is fine, the goal is to improve on it, not re-derive it) · KarthikSubramanian07/Vickrey-Scrabblebot (MIT, market fit) · dhruv-1100/lala-scrabblebot (ANALYSIS.md) · rohan879/scrabblebot (Lambi) · cayden-h/exzell-scrabblebot · Tow57/scrabblebot-auctioneer · oakb1ack/hackUTD-2026-Scrabble-Bot.

## Tournament optimization — Nov 7 ~10:13 PM
- Added short-horizon duplicate-future sharing in Brain.Futures.add: when k <= 2, identical drawn multisets share partition/delta/afterPlay results. Every RNG draw and every sample's multiplicity are retained. No bidding constants or CDF default changed.
- Full simulation equivalence: 8 UTD Vickrey matches, seed 891000..891007, lag 300: every MatchResult identical; partitions 257305 -> 249300 (-3.1%); elapsed 11.686 -> 11.150 s (-4.6%, single timing run). Four first-price matches also identical; partitions 116694 -> 113204; runtime essentially unchanged (6.110 -> 6.086 s). This is compute reduction, not evidence of higher average score.
- Added cache regression test: identical contexts reuse futures, changing horizon/rack refreshes, duplicate draws retain all 24 sample slots. Seven tests and tsc --noEmit pass.
- Rejected global Trie partition-cache experiment: full-match runtime slower despite small synthetic benchmark gain. Removed completely.
- incomeShare=0.30 screening (40 paired UTD matches, seed 731, lag 300; source snapshot before initial-key initialization fix): score +1.2 +/-6.2, place -0.125 +/-0.472. No parameter change shipped.
