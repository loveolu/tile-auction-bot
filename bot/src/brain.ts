// Decisions by simulated futures, after K-13's method (aryamehr2k/k13-scrabblebot,
// studied, not copied): a letter is worth what it adds to the best final
// partition of "my rack plus the tiles I will still buy", averaged over
// sampled futures that both sides share (common random numbers). Coins are
// priced by a shadow rate solved so bidding value/rate on every useful
// auction left spends the budget. Words are played when playing now beats
// holding on the same futures. Our additions: the market model is fitted
// from the live archive (log-normal per letter and phase), and the endgame
// moves earlier under measured server lag (effectiveNRem).
import { BAG, LETTER_VALUE, idx, total, type Counts } from "./engine.js";
import { MARKET, PHASE, pWinAt, paidAt, type Ctx } from "./strategy.js";
import type { Trie } from "./trie.js";

const SIGMA = 0.33;

// The brain's knobs live in Params (strategy.ts): samples (futures per rack
// state), kMax / kPrice (how many future tiles to imagine), futureValueScale,
// incomeShare, lambdaMin / lambdaMax / lambdaScale (>1 thrifty), coinBonus
// (a point earned now is also coinBonus × lambda points of tiles),
// playMargin, playCandidates, maxPlays.

interface Sample { future: Counts; base: number; words: string[]; delta: Float64Array; after: Map<string, number> }

// Draw k tiles without replacement from the pool.
function drawInto(pool: Counts, k: number, rand: () => number, out: Counts) {
  const left = Int32Array.from(pool);
  let W = total(left);
  for (let j = 0; j < k && W > 0; j++) {
    let r = Math.floor(rand() * W);
    for (let i = 0; i < 26; i++) {
      if (r < left[i]!) { left[i]!--; out[i]!++; W--; break; }
      r -= left[i]!;
    }
  }
}

class Futures {
  readonly key: string;
  samples: Sample[] = [];
  constructor(readonly trie: Trie, readonly rack: Counts, readonly seed = 0) { this.key = rack.join(","); }
  add(pool: Counts, k: number, n: number, rand: () => number) {
    for (let s = 0; s < n; s++) {
      const ks = Math.floor(k) + (rand() < k - Math.floor(k) ? 1 : 0);
      const future = new Int32Array(26);
      drawInto(pool, ks, rand, future);
      const r = Int32Array.from(this.rack);
      for (let i = 0; i < 26; i++) r[i]! += future[i]!;
      const p = this.trie.partition(r);
      this.samples.push({ future, base: p.total, words: p.words, delta: new Float64Array(26).fill(NaN), after: new Map() });
    }
  }
  base(): number {
    if (this.samples.length === 0) return this.trie.partition(this.rack).total;
    let m = 0;
    for (const s of this.samples) m += s.base;
    return m / this.samples.length;
  }
  delta(i: number): number {
    if (this.samples.length === 0) return 0;
    let m = 0;
    for (const s of this.samples) {
      if (Number.isNaN(s.delta[i]!)) {
        const r = Int32Array.from(this.rack);
        for (let j = 0; j < 26; j++) r[j]! += s.future[j]!;
        r[i]!++;
        const v = this.seed ? this.trie.seeded(r, s.words) : this.trie.partition(r).total;
        s.delta[i] = v - s.base;
      }
      m += s.delta[i]!;
    }
    return m / this.samples.length;
  }
  afterPlay(word: string): number {
    if (this.samples.length === 0) return 0;
    let m = 0;
    for (const s of this.samples) {
      let v = s.after.get(word);
      if (v === undefined) {
        const r = Int32Array.from(this.rack);
        for (let j = 0; j < 26; j++) r[j]! += s.future[j]!;
        for (const ch of word) r[idx(ch)]--;
        v = this.trie.partition(r).total;
        s.after.set(word, v);
      }
      m += v;
    }
    return m / this.samples.length;
  }
}

export class Brain {
  private table: Futures | undefined;
  private k = -1;
  lambda = 0.5;
  // Table price level relative to the fitted market, learned in-match.
  cal = 1;
  private myBids = new Map<string, number>();

  // A closed auction. When we lost and our bid was below the price, the
  // price is the runner-up rival's bid, an unbiased reading of the table;
  // when we won or set the price, it is not, so those are skipped.
  observe(ctx: Ctx, auctionId: string, letter: string, paid: number, progress: number) {
    const rate = ctx.params.calRate;
    const myBid = this.myBids.get(auctionId) ?? 0;
    this.myBids.delete(auctionId);
    if (rate <= 0 || paid <= 1 || myBid >= paid) return;
    // Second highest of ~5 log-normal rivals sits near 0.81 × the highest's median.
    const m = 0.81 * this.medians(ctx, progress)[idx(letter)]!;
    this.cal = Math.min(2, Math.max(0.6, this.cal + rate * (paid / m - this.cal)));
  }
  constructor(readonly trie: Trie, readonly rand: () => number = Math.random) {}

  private pool(ctx: Ctx): Counts {
    const pool = new Int32Array(26);
    for (let i = 0; i < 26; i++) pool[i] = Math.max(0, BAG[i]! - ctx.seen[i]!);
    return pool;
  }

  private futures(ctx: Ctx): Futures {
    const p = ctx.params;
    const key = ctx.rack.join(",");
    if (!this.table || this.table.key !== key) this.table = new Futures(this.trie, ctx.rack, p.seedPlan);
    const t = this.table;
    const future = Math.max(0, ctx.nRem - 1);
    if (this.k < 0) this.k = Math.min(p.kMax, future, ctx.balance / p.kPrice);
    const k = Math.min(this.k, future);
    if (t.samples.length < p.samples) t.add(this.pool(ctx), k, p.samples - t.samples.length, this.rand);
    return t;
  }

  private medians(ctx: Ctx, progress: number): Float64Array {
    const seats = ctx.seats ?? 6;
    const seatMult = seats > 6 ? 1 + 0.25 * (seats - 6) : 1;
    const ph = PHASE[Math.min(16, Math.max(0, Math.floor(progress * 17)))]!;
    const m = new Float64Array(26);
    for (let i = 0; i < 26; i++) m[i] = MARKET[i]! * ph * seatMult * this.cal;
    return m;
  }

  // Solve the shadow price: spend over the useful auctions left = budget.
  private solve(ctx: Ctx, t: Futures): number {
    const p = ctx.params;
    const future = Math.max(0, ctx.nRem - 1);
    if (future <= 0) return p.lambdaMin;
    const seats = ctx.seats ?? 6;
    const totalAuctions = 98 - 5 * seats;
    const progress = ctx.progress ?? 1 - ctx.nRem / totalAuctions;
    const pool = this.pool(ctx);
    const U = total(pool);
    const m = this.medians(ctx, progress + (1 - progress) / 2);
    const values = new Float64Array(26);
    const counts = new Float64Array(26);
    for (let i = 0; i < 26; i++) {
      if (pool[i]! <= 0 || U === 0) continue;
      counts[i] = (future * pool[i]!) / U;
      values[i] = Math.max(0, t.delta(i) * p.futureValueScale);
    }
    const budget = ctx.balance + p.incomeShare * t.base() * (future / totalAuctions);
    // No rival can bid above its balance, so the market is truncated there.
    const cap = p.rivalCap && ctx.rivalsMax !== undefined ? ctx.rivalsMax : Infinity;
    const spendAt = (lambda: number) => {
      let spend = 0;
      let wins = 0;
      for (let i = 0; i < 26; i++) {
        if (counts[i]! <= 0 || values[i]! <= 0) continue;
        const b = values[i]! / lambda;
        const pw = b > cap ? 1 : pWinAt(b, m[i]!);
        spend += counts[i]! * pw * Math.min(cap, paidAt(b, m[i]!));
        wins += counts[i]! * pw;
      }
      return { spend, wins };
    };
    let lo = Math.log(p.lambdaMin);
    let hi = Math.log(p.lambdaMax);
    let lambda: number;
    const atMin = spendAt(p.lambdaMin);
    if (atMin.spend <= budget) lambda = p.lambdaMin;
    else if (spendAt(p.lambdaMax).spend >= budget) lambda = p.lambdaMax;
    else {
      for (let it = 0; it < 30; it++) {
        const mid = (lo + hi) / 2;
        if (spendAt(Math.exp(mid)).spend > budget) lo = mid; else hi = mid;
      }
      lambda = Math.exp(hi);
    }
    const r = spendAt(lambda);
    const price = r.wins > 0.5 ? Math.max(1, r.spend / r.wins) : p.kPrice;
    const wins = Math.min(future * 0.5, budget / price);
    this.k = Math.max(0, Math.min(p.kMax, future, 1.07 * wins));
    return Math.min(p.lambdaMax, Math.max(p.lambdaMin, lambda * p.lambdaScale));
  }

  bid(ctx: Ctx, letter: string, auctionId?: string): number {
    const b = this.bidInner(ctx, letter);
    if (auctionId !== undefined) this.myBids.set(auctionId, b);
    return b;
  }

  private bidInner(ctx: Ctx, letter: string): number {
    if (ctx.nRem <= 0 || ctx.balance <= 0) return 0;
    const t = this.futures(ctx);
    this.lambda = this.solve(ctx, t);
    const li = idx(letter);
    const v = Math.max(0, t.delta(li));
    const seats = ctx.seats ?? 6;
    const progress = ctx.progress ?? 1 - ctx.nRem / (98 - 5 * seats);
    const m = this.medians(ctx, progress)[li]!;
    let bid: number;
    if (ctx.firstPrice) {
      let best = 0;
      let bestU = 0;
      const top = Math.min(ctx.balance, v / this.lambda, (ctx.rivalsMax ?? Infinity) + 1);
      for (let b = 1; b <= top; b++) {
        const u = (v / this.lambda - b) * pWinAt(b, m);
        if (u > bestU) { bestU = u; best = b; }
      }
      bid = best;
    } else {
      bid = v / this.lambda;
      if (seats === 2 && v > 0) bid = Math.max(bid, ctx.params.drain * m);
      const P = ctx.params;
      if (P.rebuild > 0 && v > 0 && total(ctx.rack) < P.rebuildTiles && ctx.balance >= P.rebuildBalance && ctx.nRem >= 14) {
        bid = Math.max(bid, P.rebuild * m);
      }
      if (P.premiumCap > 0 && LETTER_VALUE[li]! >= 5 && ctx.nRem > P.premiumUntil) bid = Math.min(bid, P.premiumCap * m);
      // Completion premium: a letter that turns the rack into a 7+ word right now
      // is worth outbidding the market for (top bots pay 1.2-1.4x); exempt from the cap.
      if (P.brainPremium && !this.trie.best(ctx.rack, 7)) {
        const withL = Int32Array.from(ctx.rack); withL[li]++;
        const h7 = this.trie.best(withL, 7);
        const now = this.trie.best(ctx.rack)?.reward ?? 0;
        if (h7 && h7.reward - now >= 12) bid = Math.max(bid, P.premium * m);
      }
      if (P.bump > 0 && bid >= 1) bid += P.bump;
    }
    return Math.max(0, Math.min(ctx.balance, Math.floor(bid)));
  }

  words(ctx: Ctx): string[] {
    const p = ctx.params;
    const rack = Int32Array.from(ctx.rack);
    if (total(rack) < 2) return [];
    if (ctx.nRem <= 1) return this.trie.partition(rack, 12).words;
    const out: string[] = [];
    // Low on coins while holding a playable 7+ word: it pays 3x whenever it is
    // played, so cash it now and spend the coins, rather than sit out the auctions.
    if (p.cash7 > 0 && ctx.balance < p.cash7 && ctx.nRem > 1) {
      if (p.cash7pick) {
        // Pick the 7+ word that leaves the best rack: points now + the rest's plan.
        let bestW = ""; let bestV = -1;
        for (const h of this.trie.topK(rack, 6, 7)) {
          const left = Int32Array.from(rack);
          for (const ch of h.word) left[idx(ch)]--;
          const v = h.reward + this.trie.partition(left).total;
          if (v > bestV) { bestV = v; bestW = h.word; }
        }
        if (bestW) return [bestW];
      } else {
        const h = this.trie.best(rack, 7);
        if (h) return [h.word];
      }
    }
    // Broke with auctions still to come: cash the best 5+ word rather than sit out.
    if (p.starve > 0 && ctx.balance < p.starve && ctx.nRem > 10) {
      const h = this.trie.best(rack, 5);
      if (h && h.reward >= p.starveMin) return [h.word];
    }
    let t = this.futures(ctx);
    const lambda = this.lambda;
    for (let n = 0; n < p.maxPlays; n++) {
      const hold = t.base();
      let best: string | undefined;
      let bestQ = hold + p.playMargin;
      for (const h of this.trie.topK(t.rack, p.playCandidates)) {
        const q = t.afterPlay(h.word) + h.reward * (1 + p.coinBonus * lambda);
        if (q > bestQ) { bestQ = q; best = h.word; }
      }
      if (!best) break;
      out.push(best);
      for (const ch of best) rack[idx(ch)]--;
      if (total(rack) < 2) break;
      t = new Futures(this.trie, rack, p.seedPlan);
      t.add(this.pool(ctx), Math.min(this.k, Math.max(0, ctx.nRem - 1)), Math.max(4, p.samples >> 1), this.rand);
    }
    return out;
  }
}
