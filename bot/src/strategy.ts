// Bidding and word-play policy. Pure functions over a small context so the
// simulator (sim.ts) and the live client (index.ts) share them exactly.
import { BAG, Dictionary, LETTER_VALUE, USEFUL, emptyCounts, idx, total, type Counts } from "./engine.js";

export interface Params {
  floor: number;     // generic worth: floor × how connectable the letter is ...
  face: number;      // ... + face × its 3× payoff once it lands in a 7+ word
  reserve: number;   // generic worth shrinks as the balance drops below this
  aggr: number;      // plus aggr × what the letter adds to this rack
  flex: number;      // value per expected one-away 7+ word
  q: number;         // chance we win a letter we want when it comes up
  endN: number;      // last N auctions: money is about to expire
  endBoost: number;  // how much harder to bid as it does
  liqBalance: number;   // cash out a shorter word when balance is below this ...
  liqMinReward: number; // ... and the word is worth at least this
  hoardMax: number;     // or when the rack is this big with no 7+ word
  premium: number;   // × the market price, at least, for a letter that completes a 7+ word now
  shade: number;     // × bid under first-price auctions (winner pays its own bid)
  // Shadow-price pacing (lambda = 1): coins are priced so that bidding
  // value/lambda on every useful auction left spends the whole budget.
  lambda: number;      // 1 = pace with a shadow price, 0 = the static formula above
  gUse: number;        // generic worth of a letter, in points, per unit of connectability ...
  gFace: number;       // ... plus this per face point
  horizon: number;     // generic worth fades over the last `horizon` auctions
  incomeShare: number; // share of expected word income that arrives in time to be spent
  lambdaMin: number;   // floor on points per coin: below it, bids go all-in
  drain: number;       // heads-up: bid at least drain × market on any useful letter
  holdBelow: number;   // hold a 7+ word worth less than this while the match is young
  leftover: number;    // 1 = among 7+ words, prefer the one leaving the best rack
  // Simulated-futures brain (lambda = 2), see brain.ts.
  samples: number; kMax: number; kPrice: number; futureValueScale: number; lambdaMax: number; lambdaScale: number;
  coinBonus: number; playMargin: number; playCandidates: number; maxPlays: number;
  // Rebuild floor: with a small rack and healthy cash, bid at least rebuild × market
  // for any letter that helps, so the planner can't pass for forty auctions.
  rebuild: number; rebuildTiles: number; rebuildBalance: number;
  // Premium cap: letters worth 5+ are overpriced at market; bid at most premiumCap × market
  // for them until the last premiumUntil auctions, when the field has gone cheap.
  premiumCap: number; premiumUntil: number;
  rivalCap: number; // 1 = no rival can bid above its public balance: truncate the market there
  calRate: number;  // learn the table's price level from auctions we didn't set the price in (0 = off)
  starve: number;   // below this balance, with auctions to come, cash the best 5+ word (0 = off)
  cash7: number;    // below this balance, cash a playable 7+ word now instead of holding it (0 = off)
  bump: number;     // coins added to any positive Vickrey bid (we lose ~6 tiles/match by 0-2 coins)
  seedPlan: number; // 1 = a letter's value can't go negative from search artifacts (seed with the base plan)
  cash7pick: number; // 1 = cash7 picks the 7+ word maximizing points now + plan of what's left
  starveMin: number; // starve only cashes a 5+ word worth at least this
  rebidDown: number; // live client: 1 = after playing words, revise the bid down as well as up
  brainPremium: number; // 1 = brain mode bids >= premium x market for a letter completing a 7+ word now
  lagK?: number;   // endgame lag margin: give up the last auctions when lagK*rttP90+300 > auction window (default 2)
  phiFix?: number; // 1 = correct normal CDF in pWinAt/paidAt (see PhiOld)
  kKey?: number;   // 1 = futures cache also keyed on the sampled-horizon k, so plans refresh as auctions run out
}

export const DEFAULT_PARAMS: Params = {
  floor: 16, face: 0.9, reserve: 30, aggr: 0.8, flex: 0, q: 0.45, endN: 12, endBoost: 1.5,
  liqBalance: 12, liqMinReward: 18, hoardMax: 12, premium: 1.4, shade: 0.78,
  lambda: 2, gUse: 5.5, gFace: 2.4, horizon: 15, incomeShare: 0.45, lambdaMin: 0.02, drain: 0.8, holdBelow: 0,
  leftover: 0,
  samples: 24, kMax: 13, kPrice: 13, futureValueScale: 1.14, lambdaMax: 4, lambdaScale: 0.7,
  coinBonus: 0.32, playMargin: 2.7, playCandidates: 8, maxPlays: 3,
  rebuild: 0, rebuildTiles: 9, rebuildBalance: 30, premiumCap: 0.7, premiumUntil: 15, rivalCap: 1, calRate: 0, starve: 0, cash7: 30, bump: 0, seedPlan: 0, cash7pick: 0, starveMin: 0, rebidDown: 0, brainPremium: 0, lagK: 1, kKey: 1,
};

// Phase curve of live prices (first to last auction), same refit.
export const PHASE = [1.20,1.11,1.06,1.03,1.03,1.00,0.99,1.02,0.99,1.02,1.03,1.03,1.03,1.11,1.20,1.28,1.11];
const SIGMA = 0.33; // log-normal spread of the highest rival bid

// Standard normal CDF (Abramowitz-Stegun 7.1.26, |err| < 1.5e-7).
// BUG (found Nov 7 by review): this is the A&S erf approximation used as a normal CDF
// without the sqrt(2) scaling or the 0.5(1+erf) map: Phi(0) = 0, Phi(0-) = 1. Kept as
// the default until the fix (phiFix) is validated, since every parameter was tuned on it.
function PhiOld(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? y : 1 - y;
}
// Standard normal CDF via A&S 7.1.26 erf (|err| < 1e-7).
function PhiNew(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + (x >= 0 ? erf : -erf));
}
const Phi = (x: number, fix = false) => (fix ? PhiNew(x) : PhiOld(x));
// P(highest rival bid < b) and E[highest rival bid | it is < b] for median m.
export function pWinAt(b: number, m: number, fix = false): number {
  return b <= 0 ? 0 : Phi((Math.log(b) - Math.log(m)) / SIGMA, fix);
}
export function paidAt(b: number, m: number, fix = false): number {
  const p = pWinAt(b, m, fix);
  if (p < 1e-6) return b;
  return Math.min(b, m * Math.exp(SIGMA * SIGMA / 2) * Phi((Math.log(b) - Math.log(m) - SIGMA * SIGMA) / SIGMA, fix) / p);
}
// Median highest rival bid for a letter now: fitted market × phase × what
// this table has actually been paying (cal) × a bigger-table premium.
export function marketMedian(li: number, progress: number, cal: number, seats: number): number {
  const seatMult = seats > 6 ? 1 + 0.25 * (seats - 6) : 1;
  return MARKET[li]! * PHASE[Math.min(16, Math.max(0, Math.floor(progress * 17)))]! * cal * seatMult;
}
// Tried: learning `cal` from prices paid. Rejected: the bot often sets the
// price as runner-up, so it ends up chasing its own bids.

// Median winning bid per letter (A..Z) in the live league. Refit on Nov 7
// 2026 from 85 recent 6-seat matches' archived winning bids (the October
// fit by the Vickrey-Scrabblebot project, MIT, was within 2% overall).
export const MARKET = [13,19,21,16,13,21,14,23,12,29,27,13,19,12,12,18,30,13,14,12,12,19,21,33,24,41];

export interface Ctx {
  dict: Dictionary;
  rack: Counts;      // letters I hold in this match
  balance: number;
  seen: Counts;      // every letter auctioned so far in this match (incl. current)
  nRem: number;      // auctions still to come after the current one that we can still act on
  params: Params;
  firstPrice?: boolean;
  seats?: number;      // players in the match
  rivalsMax?: number;  // the richest rival's balance (public)
  progress?: number;   // 0 at the first auction, 1 at the last
  cal?: number;        // market calibration for this table (1 = as fitted)
  brain?: { bid(ctx: Ctx, letter: string, auctionId?: string): number; words(ctx: Ctx): string[] }; // lambda = 2: decide by simulated futures
}

// Auctions we can still act on: a bid or word must be processed before the
// auction closes, so under server lag the last few are already out of reach.
export function effectiveNRem(nRem: number, rttP90Ms: number, auctionMs: number, k = 2): number {
  const lagAuctions = Math.ceil((k * rttP90Ms + 300) / auctionMs) - 1;
  return Math.max(0, nRem - Math.max(0, lagAuctions));
}

// Chance of getting one more copy of each letter before the bag empties.
function winChances(seen: Counts, nRem: number, q: number): Float64Array {
  const p = new Float64Array(26);
  let unseen = 0;
  for (let i = 0; i < 26; i++) unseen += Math.max(0, BAG[i]! - seen[i]!);
  if (unseen === 0 || nRem === 0) return p;
  for (let i = 0; i < 26; i++) {
    const u = Math.max(0, BAG[i]! - seen[i]!);
    p[i] = q * (1 - Math.exp((-u * nRem) / unseen));
  }
  return p;
}

// What a rack is worth: the best word it can play now, or the best 7+ word
// it is close to, plus a little for having many ways to get there.
export function rackValue(ctx: Ctx, rack: Counts, pWin: Float64Array): number {
  const tiles = total(rack);
  const b = ctx.dict.best(rack, tiles);
  const now = b >= 0 ? ctx.dict.rewards[b]! : 0;
  const pot = ctx.dict.potential(rack, tiles, pWin);
  return Math.max(now, pot.max) + ctx.params.flex * Math.log1p(pot.ways);
}

// Points one coin is worth right now: the lambda at which bidding
// value/lambda on the current letter and every useful future one spends the
// balance plus the income that arrives in time. Falls to lambdaMin as the
// bag empties, so bids rise to the balance: leftover coins score nothing.
export function solveLambda(ctx: Ctx, vNow: number, li: number): number {
  const P = ctx.params;
  const seats = ctx.seats ?? 6;
  const progress = ctx.progress ?? 1 - ctx.nRem / (98 - 5 * seats);
  const cal = ctx.cal ?? 1;
  const futureUseful = Math.max(0, ctx.nRem - 1);
  let unseen = 0;
  for (let i = 0; i < 26; i++) unseen += Math.max(0, BAG[i]! - ctx.seen[i]!);
  const decay = Math.min(1, ctx.nRem / P.horizon);
  const letters: { e: number; g: number; m: number }[] = [];
  for (let k = 0; k < 26; k++) {
    const u = Math.max(0, BAG[k]! - ctx.seen[k]!);
    if (u === 0 || unseen === 0) continue;
    letters.push({ e: (u * futureUseful) / unseen, g: (P.gUse * USEFUL[k]! + P.gFace * LETTER_VALUE[k]!) * decay, m: marketMedian(k, progress, cal, seats) });
  }
  const mNow = marketMedian(li, progress, cal, seats);
  const gap = (lambda: number) => {
    let spend = 0;
    let income = 0;
    const bNow = Math.min(ctx.balance, vNow / lambda);
    spend += pWinAt(bNow, mNow, P.phiFix === 1) * paidAt(bNow, mNow, P.phiFix === 1);
    for (const L of letters) {
      const b = Math.min(ctx.balance, L.g / lambda);
      const p = pWinAt(b, mNow === 0 ? L.m : L.m, P.phiFix === 1);
      spend += L.e * p * paidAt(b, L.m, P.phiFix === 1);
      income += L.e * p * L.g;
    }
    return spend - (ctx.balance + P.incomeShare * income);
  };
  let lo = P.lambdaMin;
  let hi = 5;
  if (gap(lo) <= 0) return lo;
  if (gap(hi) >= 0) return hi;
  for (let i = 0; i < 30; i++) {
    const mid = Math.sqrt(lo * hi);
    if (gap(mid) > 0) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

export function decideBid(ctx: Ctx, letter: string): number {
  const { params: P, nRem } = ctx;
  if (nRem <= 0 || ctx.balance <= 0) return 0; // last letter can never be played
  if (P.lambda === 2 && ctx.brain) return ctx.brain.bid(ctx, letter);
  const pWin = winChances(ctx.seen, nRem, P.q);
  const li = idx(letter);
  const withL = Int32Array.from(ctx.rack);
  withL[li]++;
  const marginal = rackValue(ctx, withL, pWin) - rackValue(ctx, ctx.rack, pWin);
  let bid: number;
  if (P.lambda) {
    const seats = ctx.seats ?? 6;
    const progress = ctx.progress ?? 1 - nRem / (98 - 5 * seats);
    const v = Math.max(0, (P.gUse * USEFUL[li]! + P.gFace * LETTER_VALUE[li]!) * Math.min(1, nRem / P.horizon) + marginal);
    const lambda = solveLambda(ctx, v, li);
    const m = marketMedian(li, progress, ctx.cal ?? 1, seats);
    if (ctx.firstPrice) {
      // Pay our own bid: pick the b that maximises (v/lambda − b) × P(win).
      let best = 0;
      let bestU = 0;
      const top = Math.min(ctx.balance, v / lambda);
      for (let b = 1; b <= top; b++) {
        const u = (v / lambda - b) * pWinAt(b, m, P.phiFix === 1);
        if (u > bestU) { bestU = u; best = b; }
      }
      bid = best;
      if (ctx.rivalsMax !== undefined) bid = Math.min(bid, ctx.rivalsMax + 1);
    } else {
      bid = v / lambda;
      if (seats === 2 && v > 0) bid = Math.max(bid, P.drain * m);
    }
  } else {
    let generic = P.floor * USEFUL[li]! + P.face * 3 * LETTER_VALUE[li]!;
    if (ctx.balance < P.reserve) generic *= ctx.balance / P.reserve;
    bid = generic + marginal * P.aggr;
    if (nRem < P.endN) bid *= 1 + P.endBoost * (1 - nRem / P.endN);
    const seats = ctx.seats ?? 6;
    const m = marketMedian(li, ctx.progress ?? 1 - nRem / (98 - 5 * seats), ctx.cal ?? 1, seats);
    if (seats === 2 && marginal > 0 && !ctx.firstPrice) bid = Math.max(bid, P.drain * m);
    if (ctx.firstPrice) {
      // The bid is what we'd pay at most; paying our own bid, pick the b
      // that maximises (bid − b) × P(win), never above what any rival can pay.
      let best = 0;
      let bestU = 0;
      const top = Math.min(ctx.balance, bid, (ctx.rivalsMax ?? Infinity) + 1);
      for (let b = 1; b <= top; b++) {
        const u = (bid - b) * pWinAt(b, m, P.phiFix === 1);
        if (u > bestU) { bestU = u; best = b; }
      }
      bid = best;
    }
  }
  // A letter that completes a 7+ word now is worth outbidding the market for.
  const tiles = total(withL);
  if (ctx.dict.best(ctx.rack, tiles - 1, 7) < 0) {
    const i7 = ctx.dict.best(withL, tiles, 7);
    const now = ctx.dict.best(ctx.rack, tiles - 1);
    if (i7 >= 0 && ctx.dict.rewards[i7]! - (now >= 0 ? ctx.dict.rewards[now]! : 0) >= 12) {
      bid = Math.max(bid, P.premium * MARKET[li]! * (ctx.cal ?? 1) * (ctx.firstPrice ? P.shade : 1));
    }
  }
  return Math.max(0, Math.min(ctx.balance, Math.round(bid)));
}

// Words to play right now, in order. Letters are disjoint across them.
export function chooseWords(ctx: Ctx): string[] {
  const { dict, params: P } = ctx;
  if (P.lambda === 2 && ctx.brain) return ctx.brain.words(ctx);
  const rack = Int32Array.from(ctx.rack);
  const out: string[] = [];
  const take = (i: number) => {
    const w = dict.words[i]!;
    for (const ch of w) rack[idx(ch)]--;
    out.push(w);
  };
  // Last two auctions: unplayed tiles are worth nothing, dump everything.
  if (ctx.nRem <= 1) {
    for (;;) {
      const i = dict.best(rack, total(rack));
      if (i < 0) break;
      take(i);
    }
    return out;
  }
  const tiles = total(rack);
  const i7 = dict.best(rack, tiles, 7);
  if (i7 >= 0) {
    // Among the top 7+ words, keep the leftover rack that is worth most.
    const pWin = winChances(ctx.seen, ctx.nRem, P.q);
    let pick = i7;
    let bestV = -Infinity;
    let seenN = 0;
    for (let i = i7; P.leftover && i < dict.words.length && seenN < 6; i++) {
      if (dict.lens[i]! < 7 || dict.lens[i]! > tiles || !dict.fits(i, rack)) continue;
      seenN++;
      const left = Int32Array.from(rack);
      for (const ch of dict.words[i]!) left[idx(ch)]--;
      const v = dict.rewards[i]! + rackValue(ctx, left, pWin);
      if (v > bestV) { bestV = v; pick = i; }
    }
    if (P.holdBelow > 0 && dict.rewards[pick]! < P.holdBelow && ctx.nRem > P.horizon && ctx.balance >= P.liqBalance) return out;
    take(pick);
    return out;
  }
  const i = dict.best(rack, tiles);
  if (i < 0) return out;
  const r = dict.rewards[i]!;
  const broke = ctx.balance < P.liqBalance && r >= P.liqMinReward;
  if (broke || tiles >= P.hoardMax) take(i);
  return out;
}

export function rackAfter(rack: Counts, words: string[]): Counts {
  const r = Int32Array.from(rack);
  for (const w of words) for (const ch of w) r[idx(ch)]--;
  return r;
}

export const freshSeen = emptyCounts;
