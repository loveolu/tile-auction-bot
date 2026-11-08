// Anagram trie: words grouped by their sorted letters, rare letters first,
// so "best word from this rack" is a depth-first walk over the rack's
// sub-multisets that prunes any subtree whose best reward can't beat the
// current answer. Microseconds per query instead of a scan of the list.
import { idx, reward, type Counts } from "./engine.js";

// Rare letters first keeps branching narrow near the root.
const ORDER = "QJXZKVWFYBHGMPCUDOLTNRAISE";
const RANK = new Int32Array(26);
for (let i = 0; i < 26; i++) RANK[idx(ORDER[i]!)] = i;

export class Trie {
  // Flat arrays. Children of node n are childNode[childStart[n] .. childStart[n+1]),
  // ordered by RANK of childLetter; letters are stored as 0..25.
  private childStart: Int32Array;
  private childLetter: Uint8Array;
  private childNode: Int32Array;
  private subBest: Int32Array;   // best reward of any word in the subtree
  private termReward: Int32Array; // reward of the word ending here (0 = none)
  private termWord: string[];     // one spelling per signature
  readonly size: number;

  constructor(words: string[]) {
    type N = { kids: Map<number, N>; reward: number; word: string };
    const root: N = { kids: new Map(), reward: 0, word: "" };
    for (const w of words) {
      const letters = [...w].map(idx).sort((a, b) => RANK[a]! - RANK[b]!);
      let n = root;
      for (const l of letters) {
        let k = n.kids.get(l);
        if (!k) { k = { kids: new Map(), reward: 0, word: "" }; n.kids.set(l, k); }
        n = k;
      }
      if (!n.word) { n.reward = reward(w); n.word = w; }
    }
    // Number nodes breadth-first so children are contiguous.
    const nodes: N[] = [root];
    for (let i = 0; i < nodes.length; i++) {
      const kids = [...nodes[i]!.kids.entries()].sort((a, b) => RANK[a[0]]! - RANK[b[0]]!);
      nodes[i]!.kids = new Map(kids);
      for (const [, k] of kids) nodes.push(k);
    }
    const N = nodes.length;
    this.size = N;
    this.childStart = new Int32Array(N + 1);
    this.termReward = new Int32Array(N);
    this.termWord = new Array(N).fill("");
    this.subBest = new Int32Array(N);
    const id = new Map<N, number>();
    nodes.forEach((n, i) => id.set(n, i));
    let total = 0;
    nodes.forEach((n, i) => { this.childStart[i] = total; total += n.kids.size; });
    this.childStart[N] = total;
    this.childLetter = new Uint8Array(total);
    this.childNode = new Int32Array(total);
    nodes.forEach((n, i) => {
      let p = this.childStart[i]!;
      for (const [l, k] of n.kids) { this.childLetter[p] = l; this.childNode[p] = id.get(k)!; p++; }
      this.termReward[i] = n.reward;
      this.termWord[i] = n.word;
    });
    for (let i = N - 1; i >= 0; i--) {
      let b = this.termReward[i]!;
      for (let p = this.childStart[i]!; p < this.childStart[i + 1]!; p++) b = Math.max(b, this.subBest[this.childNode[p]!]!);
      this.subBest[i] = b;
    }
  }

  // Highest-reward word spellable from `rack` with minLen <= length <= maxLen.
  best(rack: Counts, minLen = 2, maxLen = 99): { word: string; reward: number } | null {
    const left = Int32Array.from(rack);
    let bestR = 0;
    let bestW = "";
    const walk = (n: number, depth: number) => {
      if (this.subBest[n]! <= bestR) return;
      if (depth >= minLen && this.termReward[n]! > bestR) { bestR = this.termReward[n]!; bestW = this.termWord[n]!; }
      if (depth >= maxLen) return;
      for (let p = this.childStart[n]!; p < this.childStart[n + 1]!; p++) {
        const l = this.childLetter[p]!;
        if (left[l]! <= 0) continue;
        left[l]!--;
        walk(this.childNode[p]!, depth + 1);
        left[l]!++;
        if (this.subBest[n]! <= bestR) return;
      }
    };
    walk(0, 0);
    return bestR > 0 ? { word: bestW, reward: bestR } : null;
  }

  // The k best spellable words, reward-descending.
  topK(rack: Counts, k: number, minLen = 2): { word: string; reward: number }[] {
    const left = Int32Array.from(rack);
    const out: { word: string; reward: number }[] = [];
    const walk = (n: number, depth: number) => {
      const floor = out.length === k ? out[k - 1]!.reward : 0;
      if (this.subBest[n]! <= floor) return;
      const r = this.termReward[n]!;
      if (depth >= minLen && r > floor) {
        let i = out.length;
        if (i === k) i--;
        else out.push({ word: "", reward: 0 });
        while (i > 0 && out[i - 1]!.reward < r) { out[i] = out[i - 1]!; i--; }
        out[i] = { word: this.termWord[n]!, reward: r };
      }
      for (let p = this.childStart[n]!; p < this.childStart[n + 1]!; p++) {
        const l = this.childLetter[p]!;
        if (left[l]! <= 0) continue;
        left[l]!--;
        walk(this.childNode[p]!, depth + 1);
        left[l]!++;
      }
    };
    walk(0, 0);
    return out;
  }

  // Greedy partition points: best word, then best of the rest, and so on.
  greedy(rack: Counts): number {
    const r = Int32Array.from(rack);
    let sum = 0;
    for (;;) {
      const h = this.best(r);
      if (!h) return sum;
      sum += h.reward;
      for (const ch of h.word) r[idx(ch)]--;
    }
  }

  // Value of `rack` that never falls below a known plan: the seed words (which
  // must all fit, e.g. the best plan of a sub-rack) plus greedy on the rest.
  // Adding a letter can then never lower the estimate, unlike plain partition().
  seeded(rack: Counts, seed: string[], k = 8): number {
    const plain = this.partition(rack, k).total;
    const r = Int32Array.from(rack);
    let v = 0;
    for (const w of seed) {
      for (const ch of w) r[idx(ch)]--;
      v += reward(w);
    }
    for (let i = 0; i < 26; i++) if (r[i]! < 0) return plain; // seed did not fit
    let best = Math.max(plain, v + this.greedy(r));
    // Also try each plan word as the first word, with a full search on the rest.
    for (const w of seed) {
      const rest = Int32Array.from(rack);
      for (const ch of w) rest[idx(ch)]--;
      best = Math.max(best, reward(w) + this.partition(rest, k).total);
    }
    return best;
  }

  // Best of the top-k first words each followed by greedy: within a point
  // or two of the exact partition, and fast enough to sample thousands.
  partition(rack: Counts, k = 8): { total: number; words: string[] } {
    let best: string[] = [];
    let bestV = 0;
    for (const h of this.topK(rack, k)) {
      const r = Int32Array.from(rack);
      for (const ch of h.word) r[idx(ch)]--;
      const words = [h.word];
      let v = h.reward;
      for (;;) {
        const g = this.best(r);
        if (!g) break;
        v += g.reward;
        words.push(g.word);
        for (const ch of g.word) r[idx(ch)]--;
      }
      if (v > bestV) { bestV = v; best = words; }
    }
    return { total: bestV, words: best };
  }
}
