// Offline simulator mirroring spacetimedb/src/game.ts (bag, dealing, Vickrey
// close with random tie-break, sim-bot bids with jitter, sim word play), with
// paired evaluation so strategy changes are judged on identical deals.
//
//   npm run sim -- lineup=field matches=200                # baseline report
//   npm run sim -- lineup=field matches=200 compare='{"premium":1}'  # paired A/B
//   npm run sim -- lineup=field first=1 lag=600 fieldScale=1.1 seats=7
//
// lineups: sims (us + module sims), field (us + rivals fitted to the live
// league), elite (us + Bron/LUCENT-level clones), ladder (us + frozen earlier
// versions of us), final / finalfield (heads-up). Random streams are split so
// the deal never depends on anyone's decisions (common random numbers).
import * as path from "node:path";
import { BAG, Dictionary, LETTER_VALUE, emptyCounts, idx, loadWords, reward, total, type Counts } from "./engine.js";
import { DEFAULT_PARAMS, MARKET, chooseWords, decideBid, effectiveNRem, type Params } from "./strategy.js";
import { VERSIONS } from "./versions.js";
import { Brain } from "./brain.js";
import { Trie } from "./trie.js";

let TRIE: Trie | undefined;

type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive";
// Rivals fitted to the live league by the Vickrey-Scrabblebot project (MIT):
// market = log-normal around the median winning bid per letter; ramp, flat
// and hunter = regression families of the top ladder bots. elite = market
// scaled to what Bron/LUCENT actually win with, and their word tempo.
type Clone = "market" | "ramp" | "flat" | "hunter" | "elite" | "exzell" | "tow57";
export type Player = { name: string; sim?: SimStrategy; clone?: Clone; params?: Params };
const PHASE = [1.20,1.11,1.06,1.03,1.03,1.00,0.99,1.02,0.99,1.02,1.03,1.03,1.03,1.11,1.20,1.28,1.11];
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface SimOpts {
  firstPrice: boolean;
  fieldScale: number;   // × every clone bid (calibrate the price curve to live)
  lagMs: number;        // median server round trip; calls arriving after the close are refused
  seats: number;        // players seated (clone bids scale up at bigger tables)
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

function simBid(s: SimStrategy, letter: string, balance: number, jitter: number): number {
  const v = LETTER_VALUE[idx(letter)]!;
  const base = s === "Cheapskate" ? v - 1 : s === "ValueBidder" ? v : v + ("AEIOU".includes(letter) ? 4 : 2);
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

function cloneBid(kind: Clone, letter: string, balance: number, progress: number, z: number, u: number, o: SimOpts): number {
  const li = idx(letter);
  const face = LETTER_VALUE[li]!;
  let b: number;
  if (kind === "market" || kind === "elite") {
    if (u < 0.01) return 0;
    // MARKET is the median of the highest rival bid; for the max over five
    // such clones to land there, each clone's own median is 1/1.45 of it.
    b = (MARKET[li]! / 1.45) * PHASE[Math.min(16, Math.floor(progress * 17))]! * Math.exp(0.328 * z);
    if (kind === "elite") b *= 1.25 + 0.6 * Math.max(0, progress - 0.8) * 5; // Bron: ~1.25× market, all-in late
  } else if (kind === "ramp") b = -2.5 + 2.8 * face + 15 * progress + 11 * balance / 100 + 6.2 * z;
  else if (kind === "flat") b = 7 + 2.75 * face + 3 * progress + 4.3 * balance / 100 + 4.7 * z;
  else b = 4.4 + 3.94 * face + 7.1 * progress + 3.2 * balance / 100 + 4.3 * z;
  b *= o.fieldScale * (o.seats > 6 ? 1 + 0.25 * (o.seats - 6) : 1);
  if (o.firstPrice) b *= 0.8;
  return Math.max(0, Math.min(balance, Math.round(b)));
}

// exzell: a letter-utility table × pacing, with floors on common letters.
const EXZ_T: Record<string, number> = { Z:16.7,X:11.5,J:10.9,K:9.8,H:9.3,Y:8.7,F:7.8,M:7.7,C:7.4,W:6.6,P:6.5,B:6.2,D:6.0,G:6.0,S:5.8,V:5.7,A:5.6,Q:5.5,E:5.3,R:4.7,O:4.7,N:4.6,L:4.5,U:4.3,I:4.0,T:3.6 };
const EXZ_FLOOR: Record<string, number> = { A:10,E:10,I:10,O:10,L:10,N:10,R:10,T:10,U:9,S:12,D:12,G:12 };
function exzellBid(trie: Trie, letter: string, rack: Counts, balance: number, nRem: number, rivalsMax: number, firstPrice: boolean): number {
  const auctionsLeft = nRem + 1;
  if (auctionsLeft <= 2) return 0;
  const li = idx(letter);
  if (auctionsLeft <= 4) {
    const withL = Int32Array.from(rack); withL[li]++;
    const delta = trie.partition(withL).total - trie.partition(rack).total;
    if (delta <= 0) return 0;
    const perAuction = balance / (auctionsLeft - 2);
    return Math.max(0, Math.min(balance, Math.round(Math.max((firstPrice ? 2 : 4) * delta, Math.min(perAuction * 1.5, delta * 8)))));
  }
  const tiles = total(rack);
  const vowels = [0,4,8,14,20].reduce((a, i) => a + rack[i]!, 0);
  const vf = tiles > 0 ? vowels / tiles : 0;
  const isV = "AEIOU".includes(letter);
  const held = rack[li]!;
  let v = EXZ_T[letter]! * [1, 0.8, 0.5, 0.25, 0.1][Math.min(held, 4)]!;
  if (tiles >= 3) { if (isV && vf >= 0.5) v *= 0.7; if (!isV && vf <= 0.25) v *= 0.75; }
  if (letter === "Q" && rack[20] === 0) v = 2;
  if (letter === "U" && rack[16]! > 0 && rack[20] === 0) v += 4;
  const lambda = firstPrice ? 1.6 : 2.8;
  const cpa = balance / Math.max(1, auctionsLeft);
  const pace = cpa > 6 ? 1.3 : cpa < 1.5 ? 0.8 : 1;
  let bid = lambda * v * pace;
  if (auctionsLeft > 45) bid *= 0.9; else if (auctionsLeft <= 15) bid *= 1.2;
  if (held < 2 && EXZ_FLOOR[letter] !== undefined) bid = Math.max(bid, EXZ_FLOOR[letter]!);
  bid = Math.min(bid, rivalsMax + 1);
  return Math.max(0, Math.min(Math.round(bid), balance));
}
function exzellWords(trie: Trie, rack: Counts, balance: number, nRem: number): string[] {
  const auctionsLeft = nRem + 1;
  const part = trie.partition(rack, 12);
  if (auctionsLeft > 0 && auctionsLeft <= 2) return part.words;
  if (balance < 20 || total(rack) > 16) {
    const long = part.words.filter((w) => w.length >= 7).sort((a, b) => reward(b) - reward(a));
    if (long.length) return [long[0]!];
    if (balance < 10 && auctionsLeft > 8) {
      const best = part.words.slice().sort((a, b) => reward(b) - reward(a))[0];
      if (best && reward(best) >= 10) return [best];
    }
  }
  return [];
}
// Tow57: partition-based immediate value or a discounted completion value, paced by balance over expected wins.
type TowState = { estimatedPrice: number };
function tow57Bid(dict: Dictionary, trie: Trie, letter: string, rack: Counts, balance: number, bagTotal: number, participants: number, st: TowState, firstPrice: boolean): { bid: number; immediate: number } {
  const li = idx(letter);
  const withL = Int32Array.from(rack); withL[li]++;
  const immediate = Math.max(0, trie.partition(withL).total - trie.partition(rack).total);
  // completion: max over words using the letter with <= min(2, bagTotal-1) tiles missing of score/len/2^missing
  let completion = 0;
  const maxMiss = Math.min(2, bagTotal - 1);
  if (maxMiss >= 0) {
    const tiles = total(withL);
    for (let i = 0; i < dict.words.length; i++) {
      const n = dict.lens[i]!;
      if (n > tiles + maxMiss) continue;
      const w = dict.words[i]!;
      if (w.indexOf(letter) < 0) continue;
      let miss = 0;
      const need = new Int32Array(26);
      for (const ch of w) need[idx(ch)]++;
      for (let k = 0; k < 26; k++) { const d = need[k]! - withL[k]!; if (d > 0) miss += d; if (miss > maxMiss) break; }
      if (miss > maxMiss) continue;
      const c = dict.rewards[i]! / n / 2 ** miss;
      if (c > completion) completion = c;
    }
  }
  const value = Math.max(immediate, completion);
  const expectedWins = Math.max(1, bagTotal / participants);
  const pacing = Math.min(3, Math.max(0.5, balance / (expectedWins * st.estimatedPrice)));
  const coreBid = Math.ceil(value * pacing);
  const fundedWins = immediate > 0 ? expectedWins : Math.max(3, expectedWins);
  const allowance = balance / fundedWins * (firstPrice ? 0.5 : 1);
  const capitalBid = bagTotal > 1 ? Math.ceil(value + allowance) : 0;
  let bid = value > 0 ? Math.min(balance, Math.max(coreBid, capitalBid)) : 0;
  if (firstPrice && bid > 0) bid = Math.max(1, Math.floor(bid * 0.8));
  if (participants === 2 && !firstPrice && bid > 0) bid = Math.min(balance, Math.ceil(bid * (1 + 0.3 * (LETTER_VALUE[li]! - 1))));
  if (bagTotal === 0) bid = 0;
  if (bagTotal === 1 && immediate > 0) bid = balance;
  return { bid, immediate };
}
function tow57Word(trie: Trie, rack: Counts, balance: number, bagTotal: number): string | null {
  const plan = trie.partition(rack, 12).words.slice().sort((a, b) => reward(b) - reward(a));
  return plan.find((w) => w.length >= 7) ?? ((balance < 12 || total(rack) >= 12 || bagTotal <= 3) ? plan[0] ?? null : null);
}

function cloneWords(dict: Dictionary, kind: Clone, rack: Counts, nRem: number, progress: number): string[] {
  const r = Int32Array.from(rack);
  const out: string[] = [];
  const minLen = nRem <= 1 ? 2 : kind === "flat" ? 5 : kind === "hunter" ? 6 : 7;
  if (kind === "ramp" && progress < 0.25 && nRem > 1) return out;
  for (;;) {
    const i = dict.best(r, total(r), minLen);
    if (i < 0) break;
    for (const ch of dict.words[i]!) r[idx(ch)]--;
    out.push(dict.words[i]!);
  }
  return out;
}

export interface MatchResult {
  score: number[]; balance: number[]; words: number[]; tiles: number[]; spent: number[]; firstWord: number[];
  paidByBucket: number[]; countByBucket: number[];
}

export function playMatch(dict: Dictionary, players: Player[], seed: number, o: SimOpts): MatchResult {
  const n = players.length;
  const rngDeal = mulberry32(seed);
  const rngNoise = mulberry32(seed ^ 0x5bd1e995);
  const rngTie = mulberry32(seed ^ 0x2545f491);
  const rngLag = mulberry32(seed ^ 0x165667b1);
  // Lag: a call sent `at` ms after the open is processed at `at` + round trip.
  const late = (at: number) => o.lagMs > 0 && at + o.lagMs * Math.exp(0.5 * gauss(rngLag)) >= 1000;
  const bag = Int32Array.from(BAG);
  let bagTotal = 98;
  const draw = (): string => {
    let i = Math.floor(rngDeal() * bagTotal);
    for (let k = 0; k < 26; k++) {
      if (i < bag[k]!) { bag[k]--; bagTotal--; return LETTERS[k]!; }
      i -= bag[k]!;
    }
    throw new Error("bag empty");
  };
  const racks = players.map(() => emptyCounts());
  const balance = players.map(() => 100);
  const score = players.map(() => 0);
  const words = players.map(() => 0);
  const tiles = players.map(() => 0);
  const spent = players.map(() => 0);
  const firstWord = players.map(() => -1);
  const paidByBucket = new Array<number>(9).fill(0);
  const countByBucket = new Array<number>(9).fill(0);
  for (let p = 0; p < n; p++) for (let k = 0; k < 5; k++) racks[p]![idx(draw())]++;
  const seen = emptyCounts();
  const auctions = bagTotal;
  let round = 0;
  const play = (p: number, w: string) => {
    for (const ch of w) racks[p]![idx(ch)]--;
    const r = reward(w);
    balance[p]! += r; score[p]! += r; words[p]!++;
    if (firstWord[p]! < 0) firstWord[p] = round;
  };
  const rttP90 = o.lagMs > 0 ? o.lagMs * 1.9 : 100;
  const rngBrain = mulberry32(seed ^ 0x27d4eb2f);
  const tow: TowState[] = players.map(() => ({ estimatedPrice: 3 }));
  const brains = players.map((pl) => (!pl.sim && !pl.clone && (pl.params ?? DEFAULT_PARAMS).lambda === 2 ? new Brain(TRIE!, rngBrain) : undefined));
  while (bagTotal > 0) {
    const letter = draw();
    round++;
    seen[idx(letter)]++;
    const nRem = bagTotal;
    const progress = 1 - nRem / auctions;
    const bids: { p: number; amount: number }[] = [];
    for (let p = 0; p < n; p++) {
      const pl = players[p]!;
      const z = gauss(rngNoise);
      const u = rngNoise();
      let amount: number;
      if (pl.sim) {
        amount = simBid(pl.sim, letter, balance[p]!, Math.floor(u * 5) - 2);
      } else if (pl.clone === "exzell") {
        for (const w of exzellWords(TRIE!, racks[p]!, balance[p]!, nRem)) play(p, w);
        amount = exzellBid(TRIE!, letter, racks[p]!, balance[p]!, nRem, Math.max(...balance.filter((_, q) => q !== p)), o.firstPrice);
      } else if (pl.clone === "tow57") {
        // Word-first worker: when it plays a word it skips bidding that auction.
        const w = tow57Word(TRIE!, racks[p]!, balance[p]!, nRem);
        if (w) { play(p, w); amount = 0; }
        else amount = tow57Bid(dict, TRIE!, letter, racks[p]!, balance[p]!, nRem, n, tow[p]!, o.firstPrice).bid;
      } else if (pl.clone) {
        for (const w of cloneWords(dict, pl.clone, racks[p]!, nRem, progress)) play(p, w);
        amount = nRem === 0 ? 0 : cloneBid(pl.clone, letter, balance[p]!, progress, z, u, o);
      } else {
        const ctx = {
          dict, rack: racks[p]!, balance: balance[p]!, seen, nRem: effectiveNRem(nRem, rttP90, 1000, (pl.params ?? DEFAULT_PARAMS).lagK), seats: n,
          params: pl.params ?? DEFAULT_PARAMS, firstPrice: o.firstPrice, rivalsMax: Math.max(...balance.filter((_, q) => q !== p)),
          progress, brain: brains[p],
        };
        for (const w of chooseWords(ctx)) {
          // A word refused for lag stays on the rack; at the last auction that is fatal.
          if (!late(20)) play(p, w);
        }
        amount = brains[p] ? brains[p]!.bid({ ...ctx, balance: balance[p]! }, letter, String(round)) : decideBid({ ...ctx, balance: balance[p]! }, letter);
        if (late(20)) amount = 0;
      }
      if (amount > 0) bids.push({ p, amount });
    }
    for (let i = bids.length - 1; i >= 1; i--) {
      const j = Math.floor(rngTie() * (i + 1));
      [bids[i], bids[j]] = [bids[j]!, bids[i]!];
    }
    bids.sort((a, b) => b.amount - a.amount);
    const [first, second] = bids;
    const paidNow = first ? (o.firstPrice ? first.amount : second ? second.amount : Math.min(1, first.amount)) : 0;
    for (let p = 0; p < n; p++) if (players[p]!.clone === "tow57" && paidNow > 0) tow[p]!.estimatedPrice = 0.8 * tow[p]!.estimatedPrice + 0.2 * paidNow;
    for (let p = 0; p < n; p++) {
      const b = brains[p];
      if (b) b.observe({ dict, rack: racks[p]!, balance: balance[p]!, seen, nRem, params: players[p]!.params ?? DEFAULT_PARAMS, seats: n }, String(round), letter, paidNow, progress);
    }
    if (first) {
      const paid = paidNow;
      if (balance[first.p]! >= paid) {
        balance[first.p]! -= paid;
        spent[first.p]! += paid;
        tiles[first.p]!++;
        racks[first.p]![idx(letter)]++;
        const bucket = Math.min(8, Math.floor(((round - 1) * 9) / auctions));
        paidByBucket[bucket]! += paid;
        countByBucket[bucket]!++;
        if (players[first.p]!.sim) {
          const i = dict.longest(racks[first.p]!, total(racks[first.p]!), 3);
          if (i >= 0) play(first.p, dict.words[i]!);
        }
      }
    }
  }
  return { score, balance, words, tiles, spent, firstWord, paidByBucket, countByBucket };
}

const SIMS: Player[] = [
  { name: "Cheapo-sim", sim: "Cheapskate" }, { name: "Valor-sim", sim: "ValueBidder" },
  { name: "Brutus-sim", sim: "Aggressive" }, { name: "Hagrid-sim", sim: "ValueBidder" },
  { name: "Maverick-sim", sim: "Aggressive" }, { name: "Snippet-sim", sim: "Cheapskate" },
];

type Agg = { score: number; place: number; wins: number; words: number; left: number; tiles: number; spent: number; first: number; firsts: number };
function aggregate(players: Player[], results: MatchResult[]) {
  const sum: Agg[] = players.map(() => ({ score: 0, place: 0, wins: 0, words: 0, left: 0, tiles: 0, spent: 0, first: 0, firsts: 0 }));
  for (const r of results) {
    const top = Math.max(...r.score);
    r.score.forEach((s, p) => {
      const a = sum[p]!;
      a.score += s; a.words += r.words[p]!; a.left += r.balance[p]!; a.tiles += r.tiles[p]!; a.spent += r.spent[p]!;
      a.place += 1 + r.score.filter((o) => o > s).length;
      if (s === top) a.wins++;
      if (r.firstWord[p]! >= 0) { a.first += r.firstWord[p]!; a.firsts++; }
    });
  }
  return sum;
}

function report(players: Player[], results: MatchResult[]) {
  const m = results.length;
  const sum = aggregate(players, results);
  console.log("player        score  place  win%  words  tiles  spent  left  1st-word");
  players.forEach((pl, p) => {
    const s = sum[p]!;
    console.log(`${pl.name.padEnd(12)} ${(s.score / m).toFixed(1).padStart(6)} ${(s.place / m).toFixed(2).padStart(6)} ${(100 * s.wins / m).toFixed(0).padStart(5)} ${(s.words / m).toFixed(1).padStart(6)} ${(s.tiles / m).toFixed(1).padStart(6)} ${(s.spent / m).toFixed(0).padStart(6)} ${(s.left / m).toFixed(0).padStart(5)} ${s.firsts ? (s.first / s.firsts).toFixed(0).padStart(6) : "     -"}`);
  });
  const paid = new Array<number>(9).fill(0);
  const cnt = new Array<number>(9).fill(0);
  for (const r of results) for (let b = 0; b < 9; b++) { paid[b]! += r.paidByBucket[b]!; cnt[b]! += r.countByBucket[b]!; }
  console.log("price paid by phase (live 6-seat: 12.2 12.0 13.4 12.7 11.8 10.9 6.8 over 7 buckets):", paid.map((v, b) => (cnt[b] ? v / cnt[b]! : 0).toFixed(1)).join(" "));
}

// Paired difference of `us` between two runs on the same deals, 95% CI.
function paired(a: MatchResult[], b: MatchResult[], key: (r: MatchResult) => number) {
  const d = a.map((r, i) => key(b[i]!) - key(r));
  const mean = d.reduce((x, y) => x + y, 0) / d.length;
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, d.length - 1));
  return { mean, ci: 1.96 * sd / Math.sqrt(d.length) };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf("="); return [a.slice(0, i), a.slice(i + 1)] as [string, string]; }));
  const matches = Number(args.matches ?? 200);
  const params: Params = { ...DEFAULT_PARAMS };
  for (const k of Object.keys(params) as (keyof Params)[]) if (args[k] !== undefined) params[k] = Number(args[k]);
  const o: SimOpts = { firstPrice: args.first === "1", fieldScale: Number(args.fieldScale ?? 1), lagMs: Number(args.lag ?? 0), seats: 6 };
  const us: Player = { name: "us", params };
  const ladder: Player[] = Object.entries(VERSIONS).map(([name, p]) => ({ name, params: p }));
  const lineups: Record<string, Player[]> = {
    sims: [us, ...SIMS.slice(0, 5)],
    field: [us, { name: "market", clone: "market" }, { name: "market2", clone: "market" }, { name: "ramp", clone: "ramp" },
            { name: "flat", clone: "flat" }, { name: "hunter", clone: "hunter" }],
    // A live top table: two rack-aware bots as strong as our last version, plus typical rivals.
    elite: [us, { name: "prev", params: ladder[ladder.length - 1]!.params }, { name: "prev2", params: ladder[ladder.length - 1]!.params },
            { name: "market", clone: "market" }, { name: "ramp", clone: "ramp" }, { name: "hunter", clone: "hunter" }],
    ladder: [us, ...Array.from({ length: 5 }, (_, i) => ({ name: `${ladder[(ladder.length - 1 - i % ladder.length + ladder.length) % ladder.length]!.name}${i >= ladder.length ? "'" : ""}`, params: ladder[(ladder.length - 1 - i % ladder.length + ladder.length) % ladder.length]!.params }))],
    final: [us, { name: "twin", params: DEFAULT_PARAMS }],
    finalfield: [us, { name: "elite", clone: "elite" }],
    // Tonight's HackUTD table: two verified rival clones, a copy of our last version, and typical rivals.
    utd: [us, { name: "exzell", clone: "exzell" }, { name: "tow57", clone: "tow57" }, { name: "prev", params: ladder[ladder.length - 1]!.params },
          { name: "market", clone: "market" }, { name: "ramp", clone: "ramp" }],
  };
  let players = lineups[args.lineup ?? "field"];
  if (!players) throw new Error(`unknown lineup; try ${Object.keys(lineups).join(", ")}`);
  if (args.seats) {
    const want = Number(args.seats);
    if (want < players.length) players = players.slice(0, Math.max(2, want)); // bracket/final tables
    const extra = want - players.length;
    for (let i = 0; i < extra; i++) players = [...players, { name: `market${i + 3}`, clone: "market" }];
  }
  o.seats = players.length;
  const words = loadWords(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "wordlist.txt"));
  const dict = new Dictionary(words);
  TRIE = new Trie(words);
  const seed0 = Number(args.seed ?? 1);
  const run = (ps: Player[]) => Array.from({ length: matches }, (_, i) => playMatch(dict, ps, seed0 * 100_003 + i, o));
  const t0 = performance.now();
  const base = run(players);
  console.log(`${matches} matches, ${players.length} seats, ${o.firstPrice ? "first-price" : "vickrey"}, lag ${o.lagMs} ms, fieldScale ${o.fieldScale}, ${((performance.now() - t0) / matches).toFixed(0)} ms/match`);
  console.log(`params ${JSON.stringify(params)}`);
  report(players, base);
  if (args.compare) {
    const variant: Params = { ...params, ...(JSON.parse(args.compare) as Partial<Params>) };
    const alt = run([{ name: "us", params: variant }, ...players.slice(1)]);
    console.log(`\nvariant ${args.compare}`);
    report(players, alt);
    const ds = paired(base, alt, (r) => r.score[0]!);
    const dp = paired(base, alt, (r) => 1 + r.score.filter((s) => s > r.score[0]!).length);
    console.log(`\npaired Δ for us (variant − base): score ${ds.mean >= 0 ? "+" : ""}${ds.mean.toFixed(1)} ±${ds.ci.toFixed(1)}, place ${dp.mean >= 0 ? "+" : ""}${dp.mean.toFixed(3)} ±${dp.ci.toFixed(3)}`);
  }
}
if (process.argv[1]?.endsWith("sim.ts")) main();
