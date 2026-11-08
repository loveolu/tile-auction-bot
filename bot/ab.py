#!/usr/bin/env python3
# Live A/B scorecard: python3 ab.py  (reads decisions-Primey.jsonl, places from the public DB)
import json, subprocess, statistics as st
S = "https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql"
def q(sql):
    out = subprocess.run(["curl","-s","-X","POST",S,"-H","Content-Type: text/plain","--data",sql],capture_output=True,text=True).stdout
    d = json.loads(out)[0]; cols = [e['name']['some'] for e in d['schema']['elements']]; return [dict(zip(cols,r)) for r in d['rows']]
ends = [json.loads(l) for l in open("decisions-Primey.jsonl") if '"k": "end"' in l or '"k":"end"' in l]
import sys
since = int(sys.argv[1]) if len(sys.argv) > 1 else 0   # python3 ab.py <first match id of this experiment>
SKIP = {"45592", "45609"}  # arms changed mid-match on a reconnect (fixed: arm now hashed from match id)
ends = [e for e in ends if "arm" in e and int(e["match"]) >= since and e["match"] not in SKIP]
arms = {}
for e in ends:
    rows = q(f"SELECT bot_id, score FROM match_participant WHERE match_id = {e['match']}")
    place = 1 + sum(1 for r in rows if r['score'] > e['score'])
    arms.setdefault(e["arm"], []).append((e["score"], place, len(rows)))
for arm, xs in sorted(arms.items()):
    sc = [x[0] for x in xs]; pl = [x[1] for x in xs]; sw = [max(x[2]-x[1], 0) for x in xs]
    se = st.stdev(sc)/len(sc)**0.5 if len(sc) > 1 else float("nan")
    print(f"arm {arm}: n={len(xs)} score {st.mean(sc):.1f} ±{1.96*se:.1f}  place {st.mean(pl):.2f}  swiss-pts {st.mean(sw):.2f}  wins {sum(1 for p in pl if p==1)}")
