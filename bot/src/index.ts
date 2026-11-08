// ScrabbleBot client. Connects as your team's bot, keeps it in the lobby,
// and plays every match with the policy in strategy.ts.
//
// First run:  BOT_NAME=<name> BOT_TOKEN=<token from /team> npm start
//   (or BOT_NONCE=<code> from `spacetime call scrabblebot mint_credential_nonce`)
// Later runs: BOT_NAME=<name> npm start          (token saved to .token-<name>)
// Tournament: BOT_NAME=<name> TOURNAMENT_ID=<id> npm start
//
// The process exits on disconnect; run it under a restart loop for events:
//   while true; do BOT_NAME=<name> npm start; sleep 2; done
import * as fs from "node:fs";
import * as path from "node:path";
import { Identity } from "spacetimedb";
import { DbConnection, type ErrorContext } from "./module_bindings/index.js";
import { Dictionary, emptyCounts, idx, loadWords, reward, type Counts } from "./engine.js";
import { DEFAULT_PARAMS, chooseWords, decideBid, effectiveNRem, type Ctx, type Params } from "./strategy.js";
import { Brain } from "./brain.js";
import { Trie } from "./trie.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORDS = loadWords(path.join(HERE, "..", "wordlist.txt"));
const DICT = new Dictionary(WORDS);
const TRIE = new Trie(WORDS);
// BOT_PARAMS='{"lambda":0}' overrides strategy defaults for a live A/B.
const PARAMS: Params = { ...DEFAULT_PARAMS, ...(JSON.parse(process.env.BOT_PARAMS ?? "{}") as Partial<Params>) };
// BOT_AB='{"lambdaScale":0.7}' plays every other match with these overrides
// (arm "b") and records the arm with each decision, for a live A/B.
const AB = process.env.BOT_AB ? (JSON.parse(process.env.BOT_AB) as Partial<Params>) : null;

const log = (msg: string) => console.log(`[${BOT_NAME}] ${msg}`);
// One JSON line per decision, for auditing live play against the winners' profile.
const DECISIONS = path.join(process.cwd(), `decisions-${BOT_NAME}.jsonl`);
const record = (row: Record<string, unknown>) => fs.appendFile(DECISIONS, JSON.stringify({ t: Date.now(), ...row }) + "\n", () => {});
const warn = (what: string) => (err: unknown) =>
  console.warn(`[${BOT_NAME}] ${what}: ${err instanceof Error ? err.message : err}`);

let myBotId: bigint | null = null;
const bidsPlaced = new Set<bigint>();
// Reducer round trips, newest last. At hackathon peak the server has taken
// 2-4 s per call, which turns a last-auction dump into "Match not running".
const rtts: number[] = [];
let lastAuctionAt = Date.now();
let lastReconnectAt = 0;
function timed<T>(p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  const done = () => { rtts.push(Date.now() - t0); if (rtts.length > 30) rtts.shift(); };
  return p.then((v) => { done(); return v; }, (e) => { done(); throw e; });
}
function rttP90(): number {
  if (rtts.length === 0) return 150;
  const s = [...rtts].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]!;
}
// Words submitted but not yet reflected in my_rack, so we don't play their
// letters twice. Cleared when our score rises by the word's reward.
type Live = { sub: { unsubscribe(): void } | null; pending: Map<string, number>; brain: Brain; params: Params; arm: string };
const live = new Map<bigint, Live>();

function rackFor(conn: DbConnection, matchId: bigint, l: Live): Counts {
  const rack = emptyCounts();
  for (const h of conn.db.myRack.iter()) if (h.matchId === matchId) rack[idx(h.letter)] += h.count;
  const now = Date.now();
  for (const [w, at] of l.pending) {
    if (now - at > 3000) { l.pending.delete(w); continue; }
    for (const ch of w) rack[idx(ch)]--;
  }
  for (let i = 0; i < 26; i++) if (rack[i]! < 0) rack[i] = 0;
  return rack;
}

function ctxFor(conn: DbConnection, matchId: bigint, l: Live): Ctx | null {
  let balance: number | null = null;
  let seats = 0;
  let rivalsMax = 0;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    seats++;
    if (p.botId === myBotId) balance = Number(p.balance);
    else rivalsMax = Math.max(rivalsMax, Number(p.balance));
  }
  if (balance === null) return null;
  const seen = emptyCounts();
  for (const a of conn.db.auction.iter()) if (a.matchId === matchId) seen[idx(a.letter)]++;
  const m = conn.db.matchState.id.find(matchId);
  const bagTotal = m ? m.bagTotal : 99;
  const nRem = effectiveNRem(bagTotal, rttP90(), Number(m?.auctionDurationMs ?? 1000n), l.params.lagK);
  const auctions = 98 - (m?.startingRackSize ?? 5) * Math.max(seats, 2);
  return {
    dict: DICT, rack: rackFor(conn, matchId, l), balance, seen, nRem, params: l.params, brain: l.brain,
    firstPrice: m?.auctionType.tag === "FirstPrice", seats: Math.max(seats, 2), rivalsMax, progress: 1 - bagTotal / auctions,
  };
}

// Plays what the policy says to; returns the reward those words will earn.
function playWords(conn: DbConnection, matchId: bigint): number {
  const l = live.get(matchId);
  if (!l) return 0;
  const m = conn.db.matchState.id.find(matchId);
  if (m && m.status.tag !== "Running") return 0;
  const ctx = ctxFor(conn, matchId, l);
  if (!ctx) return 0;
  let gained = 0;
  for (const w of chooseWords(ctx)) {
    l.pending.set(w, Date.now());
    gained += reward(w);
    timed(conn.reducers.submitWord({ matchId, word: w })).catch(warn(`play ${w}`));
    log(`match ${matchId}: play ${w} (+${reward(w)})`);
    record({ k: "word", match: String(matchId), word: w, reward: reward(w), nRem: ctx.nRem, balance: ctx.balance });
  }
  return gained;
}

function onAuction(conn: DbConnection, a: { id: bigint; matchId: bigint; letter: string; status: { tag: string } }) {
  if (myBotId === null || a.status.tag !== "Open" || bidsPlaced.has(a.id)) return;
  const l = live.get(a.matchId);
  if (!l) return;
  bidsPlaced.add(a.id);
  lastAuctionAt = Date.now();
  const ctx = ctxFor(conn, a.matchId, l);
  if (!ctx) return;
  // The bid goes out first, so it is queued ahead of our words on a slow
  // server; the server keeps only the latest bid, so if the words we play
  // now make a higher bid affordable we send it again after them.
  const wanted = ctx.brain && PARAMS.lambda === 2 ? ctx.brain.bid(ctx, a.letter, String(a.id)) : decideBid(ctx, a.letter);
  const bid = (amount: number) =>
    timed(conn.reducers.submitBid({ auctionId: a.id, amount: BigInt(amount) })).catch(warn(`bid ${amount} on ${a.letter}`));
  if (wanted > 0) bid(Math.min(wanted, ctx.balance));
  const gained = playWords(conn, a.matchId);
  if (gained > 0) {
    const after = decideBid({ ...ctx, rack: rackFor(conn, a.matchId, l), balance: ctx.balance + gained }, a.letter);
    // rebidDown=1: two-way, since the words just played may have made this letter useless.
    if (l.params.rebidDown ? after !== Math.min(wanted, ctx.balance) : after > Math.min(wanted, ctx.balance)) bid(after);
  }
  record({ k: "bid", match: String(matchId(a)), auction: String(a.id), letter: a.letter, bid: wanted, nRem: ctx.nRem, balance: ctx.balance, rtt90: rttP90() });
}
const matchId = (a: { matchId: bigint }) => a.matchId;

function enterMatch(conn: DbConnection, matchId: bigint) {
  if (live.has(matchId)) return;
  // Arm from a hash of the match id, so a reconnect mid-match keeps the same arm.
  let h = Number(matchId % 1000003n);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h ^= h >>> 16;
  const arm = AB && (h & 1) === 1 ? "b" : "a";
  const l: Live = { sub: null, pending: new Map(), brain: new Brain(TRIE), params: arm === "b" ? { ...PARAMS, ...AB } : PARAMS, arm };
  live.set(matchId, l);
  l.sub = conn
    .subscriptionBuilder()
    .onApplied(() => {
      const m = conn.db.matchState.id.find(matchId);
      if (m && m.status.tag !== "Running") { leaveMatch(matchId); joinLobby(conn); return; }
      lastAuctionAt = Date.now();
      log(`match ${matchId}: playing (${m?.auctionType.tag ?? "?"}, arm ${l.arm})`);
      for (const a of conn.db.auction.iter()) if (a.matchId === matchId) onAuction(conn, a);
    })
    .onError((ctx: ErrorContext) => warn(`match ${matchId} subscription`)(ctx.event))
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${matchId}`,
      `SELECT * FROM auction WHERE match_id = ${matchId}`,
      `SELECT * FROM match_participant WHERE match_id = ${matchId}`,
      `SELECT * FROM auction_result WHERE match_id = ${matchId}`,
    ]);
}

function leaveMatch(matchId: bigint) {
  live.get(matchId)?.sub?.unsubscribe();
  live.delete(matchId);
}

function inRunningMatch(conn: DbConnection): boolean {
  for (const id of live.keys()) if (conn.db.matchState.id.find(id)?.status.tag === "Running") return true;
  return false;
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null || inRunningMatch(conn)) return;
  conn.reducers.joinLobby({}).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already in a running match/.test(msg)) warn("join lobby")(err);
  });
}

function onReady(conn: DbConnection) {
  const bot = conn.db.bot.id.find(myBotId!);
  log(`acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`);
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() => log(`registered for tournament ${TOURNAMENT_ID}`))
      .catch(warn(`register for tournament ${TOURNAMENT_ID}`));
  }
  // The initial rows are our whole match history; only rows inserted after
  // onApplied are new matches (each enterMatch opens a subscription).
  let initial = true;
  let newest = -1n;
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      initial = false;
      // Only the newest match can still be running; its state tells us.
      let latest: bigint | null = null;
      for (const p of conn.db.matchParticipant.iter()) if (latest === null || p.matchId > latest) latest = p.matchId;
      if (latest !== null) { newest = latest; enterMatch(conn, latest); }
      joinLobby(conn);
      timers.push(setInterval(() => joinLobby(conn), 20_000));
      // A silently stalled feed mid-match scores 0; rebuild the connection in-process.
      // When the server itself is slow (round trips of seconds) auctions run
      // late too, so the limit scales with measured lag and reconnects back off.
      timers.push(setInterval(() => {
        // Fixed limit: the server keeps auctions on schedule even under load
        // (measured), so silence means OUR feed stalled; a long wait only loses auctions.
        const limit = 6_000;
        if (inRunningMatch(conn) && Date.now() - lastAuctionAt > limit && Date.now() - lastReconnectAt > 15_000) {
          console.error(`[${BOT_NAME}] no auction for ${Math.round(limit / 1000)} s mid-match; reconnecting (rtt p90 ${rttP90()} ms)`);
          lastReconnectAt = Date.now();
          reconnect(conn);
        }
      }, 1_000));
    })
    .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`, "SELECT * FROM my_rack"]);

  // The SDK may deliver the initial rows before or after onApplied; either way only an id newer than the history is a new match.
  conn.db.matchParticipant.onInsert((_c, p) => { if (!initial && p.botId === myBotId && p.matchId > newest) { newest = p.matchId; enterMatch(conn, p.matchId); } });
  conn.db.matchParticipant.onUpdate((_c, old, neu) => {
    if (neu.botId !== myBotId) return;
    const l = live.get(neu.matchId);
    const d = Number(neu.score - old.score);
    if (!l || d <= 0) return;
    for (const w of l.pending.keys()) if (reward(w) === d) { l.pending.delete(w); break; }
  });
  conn.db.auction.onInsert((_c, a) => onAuction(conn, a));
  conn.db.auctionResult.onInsert((_c, r) => {
    const l = live.get(r.matchId);
    if (!l) return;
    const ctx = ctxFor(conn, r.matchId, l);
    if (ctx) l.brain.observe(ctx, String(r.auctionId), r.letter, Number(r.paid), ctx.progress ?? 0);
  });
  conn.db.myRack.onInsert((_c, h) => playWords(conn, h.matchId));
  conn.db.myRack.onUpdate((_c, _o, h) => playWords(conn, h.matchId));
  conn.db.matchState.onUpdate((_c, old, neu) => {
    if (old.status.tag === "Ended" || neu.status.tag !== "Ended" || !live.has(neu.id)) return;
    let score = 0;
    for (const p of conn.db.matchParticipant.iter()) if (p.matchId === neu.id && p.botId === myBotId) score = Number(p.score);
    const arm = live.get(neu.id)?.arm ?? "a";
    log(`match ${neu.id} ended, score ${score}, arm ${arm}, rtt p90 ${rttP90()} ms; back to the lobby`);
    record({ k: "end", match: String(neu.id), score, arm, rtt90: rttP90() });
    leaveMatch(neu.id);
    joinLobby(conn);
  });
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  fs.writeFileSync(TOKEN_PATH, token);
  log(`connected as ${identity.toHexString()}`);
  const resolve = () => conn.db.botCredential.identity.find(identity)?.botId ?? null;
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      myBotId = resolve();
      if (myBotId !== null) return onReady(conn);
      if (!BOT_NONCE) {
        console.error(`[${BOT_NAME}] this token is no bot's credential. Set BOT_TOKEN or BOT_NONCE and re-run.`);
        process.exit(1);
      }
      log("claiming credential with nonce");
      conn.reducers.claimCredential({ code: BOT_NONCE }).catch(warn("claim credential"));
      setTimeout(() => {
        myBotId = resolve();
        if (myBotId === null) { console.error(`[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`); process.exit(1); }
        onReady(conn);
      }, 1500);
    })
    .subscribe(["SELECT * FROM bot_credential", "SELECT * FROM bot"]);
}

// Connection lifecycle. A dropped or stalled socket is rebuilt here within a
// second; the subscriptions and match state are rebuilt by onConnect. The
// process exits only after many failures in a row, for run.sh to relaunch.
let timers: NodeJS.Timeout[] = [];
let current: DbConnection | null = null;
let failures = 0;
let pendingReconnect = false;

function teardown() {
  for (const t of timers) clearInterval(t);
  timers = [];
  live.clear(); // their subscriptions died with the socket
}

function reconnect(conn: DbConnection) {
  if (pendingReconnect || conn !== current) return;
  pendingReconnect = true;
  teardown();
  try { conn.disconnect(); } catch { /* already gone */ }
  setTimeout(connect, 500);
}

function connect() {
  pendingReconnect = false;
  log(`connecting to ${DB_NAME} at ${HOST} (strategy mode ${PARAMS.lambda})`);
  const conn = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? (fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, "utf8").trim() : undefined))
    .onConnect((c, identity, token) => { failures = 0; onConnect(c, identity, token); })
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      failures++;
      console.error(`[${BOT_NAME}] connect error (${failures}): ${err.message}`);
      if (failures >= 30) process.exit(1);
      if (conn === current && !pendingReconnect) { teardown(); pendingReconnect = true; setTimeout(connect, 1_000); }
    })
    .onDisconnect(() => {
      if (conn !== current || pendingReconnect) return; // a reconnect is already scheduled
      log("disconnected; reconnecting");
      teardown();
      pendingReconnect = true;
      setTimeout(connect, 500);
    })
    .build();
  current = conn;
}

connect();
