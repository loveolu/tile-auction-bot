// Word engine: dictionary lookups and rack math shared by the live bot and
// the local simulator. Mirrors spacetimedb/src/letters.ts + dictionary.ts.
import * as fs from "node:fs";

// A..Z face values and the 98-tile bag, indexed by letter (A = 0).
export const LETTER_VALUE = [1,3,3,2,1,4,2,4,1,8,5,1,3,1,1,3,10,1,1,1,1,4,4,8,4,10];
export const BAG = [9,2,2,4,12,2,3,2,9,1,1,4,2,6,8,2,1,6,4,6,4,2,2,1,2,1];
// Share of 7-letter words containing each letter (how "connectable" it is).
export const USEFUL = [.47,.14,.23,.26,.66,.09,.20,.16,.48,.02,.09,.34,.18,.37,.34,.19,.01,.45,.53,.35,.25,.06,.08,.02,.11,.03];

export type Counts = Int32Array; // 26 slots

export const idx = (letter: string) => letter.charCodeAt(0) - 65;
export const emptyCounts = (): Counts => new Int32Array(26);
export function countsOf(letters: string): Counts {
  const c = emptyCounts();
  for (const ch of letters) c[idx(ch)]++;
  return c;
}
export function total(c: Counts): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += c[i]!;
  return t;
}

// Same integer math as the module: base * num / denom.
export function reward(word: string): number {
  let base = 0;
  for (let i = 0; i < word.length; i++) base += LETTER_VALUE[word.charCodeAt(i) - 65]!;
  const n = word.length;
  if (n <= 3) return base;
  if (n === 4) return Math.floor((base * 3) / 2);
  if (n === 5) return base * 2;
  if (n === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export function loadWords(path: string): string[] {
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2 && /^[A-Z]+$/.test(l));
}

export class Dictionary {
  readonly words: string[]; // reward-descending
  readonly rewards: Int32Array;
  readonly lens: Uint8Array;
  private readonly start: Int32Array; // packed (letter, count) needs per word
  private readonly needL: Uint8Array;
  private readonly needC: Uint8Array;
  private readonly byLength: Int32Array; // indices, longest first then lexical (sim bots' order)
  private readonly mask: Int32Array;     // 26-bit set of each word's letters: a one-op reject

  constructor(words: string[]) {
    const scored = words
      .map((w) => [w, reward(w)] as const)
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1));
    this.words = scored.map((s) => s[0]);
    this.rewards = Int32Array.from(scored, (s) => s[1]);
    this.lens = Uint8Array.from(this.words, (w) => w.length);
    this.start = new Int32Array(this.words.length + 1);
    const L: number[] = [];
    const C: number[] = [];
    this.words.forEach((w, i) => {
      const c = countsOf(w);
      for (let k = 0; k < 26; k++) if (c[k]) { L.push(k); C.push(c[k]!); }
      this.start[i + 1] = L.length;
    });
    this.needL = Uint8Array.from(L);
    this.needC = Uint8Array.from(C);
    this.mask = new Int32Array(this.words.length);
    this.words.forEach((w, i) => { let m = 0; for (const ch of w) m |= 1 << idx(ch); this.mask[i] = m; });
    this.byLength = Int32Array.from(
      this.words.map((_, i) => i).sort((a, b) => this.lens[b]! - this.lens[a]! || (this.words[a]! < this.words[b]! ? -1 : 1)),
    );
  }

  fits(i: number, rack: Counts): boolean {
    for (let k = this.start[i]!; k < this.start[i + 1]!; k++) {
      if (rack[this.needL[k]!]! < this.needC[k]!) return false;
    }
    return true;
  }

  static maskOf(rack: Counts): number {
    let m = 0;
    for (let i = 0; i < 26; i++) if (rack[i]! > 0) m |= 1 << i;
    return m;
  }

  // Highest-reward playable word (index) with length >= minLen, or -1.
  best(rack: Counts, tiles: number, minLen = 2): number {
    const rm = Dictionary.maskOf(rack);
    for (let i = 0; i < this.words.length; i++) {
      const n = this.lens[i]!;
      if (n > tiles || n < minLen || (this.mask[i]! & ~rm) !== 0) continue;
      if (this.fits(i, rack)) return i;
    }
    return -1;
  }

  // The k highest-reward playable words (indices), reward-descending.
  topK(rack: Counts, tiles: number, k: number, minLen = 2): number[] {
    const rm = Dictionary.maskOf(rack);
    const out: number[] = [];
    for (let i = 0; i < this.words.length && out.length < k; i++) {
      const n = this.lens[i]!;
      if (n > tiles || n < minLen || (this.mask[i]! & ~rm) !== 0) continue;
      if (this.fits(i, rack)) out.push(i);
    }
    return out;
  }

  // Points of a greedy partition of the rack into words: best word first,
  // then the best of what is left, and so on. `rack` is left untouched.
  greedy(rack: Counts): number {
    const r = Int32Array.from(rack);
    let tiles = total(r);
    let sum = 0;
    for (;;) {
      const i = this.best(r, tiles);
      if (i < 0) return sum;
      sum += this.rewards[i]!;
      for (const ch of this.words[i]!) r[idx(ch)]--;
      tiles -= this.lens[i]!;
    }
  }

  // Best partition value: the best of the top `k` first words each followed
  // by greedy. Within a point or two of exact at 12-16 tiles, far faster.
  partition(rack: Counts, k = 8): number {
    const tiles = total(rack);
    if (tiles < 2) return 0;
    let best = 0;
    for (const i of this.topK(rack, tiles, k)) {
      const r = Int32Array.from(rack);
      for (const ch of this.words[i]!) r[idx(ch)]--;
      const v = this.rewards[i]! + this.greedy(r);
      if (v > best) best = v;
    }
    return best;
  }

  // The words of the best partition (for the final dump), same search.
  partitionWords(rack: Counts, k = 12): string[] {
    const tiles = total(rack);
    let best: string[] = [];
    let bestV = -1;
    for (const i of this.topK(rack, tiles, k)) {
      const r = Int32Array.from(rack);
      const words = [this.words[i]!];
      for (const ch of this.words[i]!) r[idx(ch)]--;
      let v = this.rewards[i]!;
      let t = tiles - this.lens[i]!;
      for (;;) {
        const j = this.best(r, t);
        if (j < 0) break;
        words.push(this.words[j]!);
        v += this.rewards[j]!;
        for (const ch of this.words[j]!) r[idx(ch)]--;
        t -= this.lens[j]!;
      }
      if (v > bestV) { bestV = v; best = words; }
    }
    return best;
  }

  // What the module's sim bots play: the longest word, lexically first.
  longest(rack: Counts, tiles: number, minLen: number): number {
    const rm = Dictionary.maskOf(rack);
    for (const i of this.byLength) {
      const n = this.lens[i]!;
      if (n < minLen) break;
      if (n > tiles || (this.mask[i]! & ~rm) !== 0) continue;
      if (this.fits(i, rack)) return i;
    }
    return -1;
  }

  // Near-miss value of a rack for 7+ letter words. For every word at most
  // `maxDeficit` letters away, weight its reward by the chance of getting
  // the missing letters (pWin, per letter). Returns the best such value and
  // the expected number of one-away words (how flexible the rack is).
  potential(rack: Counts, tiles: number, pWin: Float64Array, maxDeficit = 2): { max: number; ways: number } {
    let max = 0;
    let ways = 0;
    const rm = Dictionary.maskOf(rack);
    for (let i = 0; i < this.words.length; i++) {
      const n = this.lens[i]!;
      if (n < 7 || n > tiles + maxDeficit) continue;
      // More letters missing from the rack entirely than the deficit allows.
      let miss = this.mask[i]! & ~rm;
      miss = miss - ((miss >>> 1) & 0x55555555);
      miss = (miss & 0x33333333) + ((miss >>> 2) & 0x33333333);
      if ((((miss + (miss >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24 > maxDeficit) continue;
      let d = 0;
      let p = 1;
      for (let k = this.start[i]!; k < this.start[i + 1]!; k++) {
        const miss = this.needC[k]! - rack[this.needL[k]!]!;
        if (miss > 0) {
          d += miss;
          if (d > maxDeficit) break;
          for (let m = 0; m < miss; m++) p *= pWin[this.needL[k]!]!;
        }
      }
      if (d > maxDeficit) continue;
      const v = this.rewards[i]! * p;
      if (v > max) max = v;
      if (d === 1) ways += p;
    }
    return { max, ways };
  }
}
