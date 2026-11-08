// Run with `npm test`.
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { Dictionary, countsOf, emptyCounts, loadWords, reward, total } from "./engine.js";
import { DEFAULT_PARAMS, chooseWords, decideBid, type Ctx } from "./strategy.js";

const dict = new Dictionary(loadWords(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "wordlist.txt")));
const ctx = (rack: string, over: Partial<Ctx> = {}): Ctx => ({
  dict, rack: countsOf(rack), balance: 100, seen: emptyCounts(), nRem: 40, params: DEFAULT_PARAMS, ...over,
});

test("reward matches rewards the live module paid out", () => {
  assert.equal(reward("EQUINOX"), 69);
  assert.equal(reward("QAID"), 21);
  assert.equal(reward("BOOZES"), 42);
  assert.equal(reward("OX"), 9);
});

test("best() finds the top-reward playable word", () => {
  const r = countsOf("EQUINOXA");
  assert.equal(dict.words[dict.best(r, total(r), 7)], "EQUINOX");
  assert.equal(dict.best(countsOf("QZX"), 3), -1);
});

test("chooseWords plays a 7+ word at once and dumps everything at the end", () => {
  assert.deepEqual(chooseWords(ctx("EQUINOXA")), ["EQUINOX"]);
  assert.deepEqual(chooseWords(ctx("CATX")), []);
  const dump = chooseWords(ctx("CATXOE", { nRem: 1 }));
  assert.ok(dump.length >= 1 && dump.every((w) => w.length < 7), `dumped ${dump}`);
});

test("decideBid: never on the last letter, more for a letter that completes a 7", () => {
  assert.equal(decideBid(ctx("EQUINO", { nRem: 0 }), "X"), 0);
  const completes = decideBid(ctx("EQUINO"), "X");
  const useless = decideBid(ctx("EQUINO"), "Q");
  assert.ok(completes > useless + 10, `${completes} vs ${useless}`);
  assert.ok(decideBid(ctx("EQUINO", { balance: 5 }), "X") <= 5);
});

test("completion premium beats the market price; first-price bids are shaded", () => {
  const vick = decideBid(ctx("EQUINO"), "X");
  assert.ok(vick >= Math.round(1.4 * 34.2), `premium bid ${vick}`);
  const fp = decideBid(ctx("EQUINO", { firstPrice: true }), "X");
  assert.ok(fp < vick && fp > 0, `${fp} vs ${vick}`);
});

test("a bid is decided well inside the 1-second auction window", () => {
  const c = ctx("BCDFGHJKLMNPQRSTVWXZ");
  const t0 = performance.now();
  decideBid(c, "E");
  chooseWords(c);
  assert.ok(performance.now() - t0 < 150, "took too long");
});

test("brain futures reuse identical contexts and refresh on horizon or rack changes", async () => {
  const { Brain } = await import("./brain.js");
  const { Trie } = await import("./trie.js");
  const trie = new Trie(["AT", "CAT", "CATS"]);
  let partitions = 0;
  const partition = trie.partition.bind(trie);
  trie.partition = (...args) => { partitions++; return partition(...args); };
  const brain = new Brain(trie, () => 0.5);
  // Check cache reuse without bid(), which intentionally updates the horizon.
  const cache = brain as unknown as { futures(c: Ctx): { samples: unknown[] } };
  const c = ctx("CAT", { nRem: 3, params: { ...DEFAULT_PARAMS, kKey: 1 } });
  const first = cache.futures(c);
  assert.equal(partitions, 1);
  assert.equal(first.samples.length, c.params.samples, "duplicate draws retain their weight");
  assert.equal(cache.futures({ ...c, rack: countsOf("CAT") }), first);
  assert.equal(partitions, 1, "identical contexts must reuse samples");
  const shorter = cache.futures({ ...c, nRem: 2 });
  assert.notEqual(shorter, first);
  assert.equal(partitions, 2);
  assert.equal(cache.futures({ ...c, nRem: 2 }), shorter);
  assert.notEqual(cache.futures({ ...c, nRem: 2, rack: countsOf("CATS") }), shorter);
});
