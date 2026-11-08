// Frozen parameter sets of earlier versions, so a new version is also judged
// against the bots it replaced (the ladder lineup). Append, never edit.
import type { Params } from "./strategy.js";

export const VERSIONS: Record<string, Params> = {
  v1: { floor: 16, face: 0.9, reserve: 30, aggr: 0.8, flex: 0, q: 0.45, endN: 12, endBoost: 1.5,
        liqBalance: 12, liqMinReward: 18, hoardMax: 12, premium: 1.4, shade: 0.78,
        lambda: 0, gUse: 5.5, gFace: 2.4, horizon: 15, incomeShare: 0.45, lambdaMin: 0.1, drain: 0.8, holdBelow: 0,
        leftover: 0, samples: 24, kMax: 13, kPrice: 13, futureValueScale: 1.14, lambdaMax: 4, lambdaScale: 1.08,
        coinBonus: 0.32, playMargin: 2.7, playCandidates: 8, maxPlays: 3, rebuild: 0, rebuildTiles: 9, rebuildBalance: 30, premiumCap: 0, premiumUntil: 15, rivalCap: 0, calRate: 0, starve: 0, cash7: 0, bump: 0, seedPlan: 0, cash7pick: 0, starveMin: 0, rebidDown: 0, brainPremium: 0 },
  // Simulated-futures brain, shipped Nov 7 after clearing every field vs v1.
  v2: { floor: 16, face: 0.9, reserve: 30, aggr: 0.8, flex: 0, q: 0.45, endN: 12, endBoost: 1.5,
        liqBalance: 12, liqMinReward: 18, hoardMax: 12, premium: 1.4, shade: 0.78,
        lambda: 2, gUse: 5.5, gFace: 2.4, horizon: 15, incomeShare: 0.47, lambdaMin: 0.02, drain: 0.8, holdBelow: 0,
        leftover: 0, samples: 24, kMax: 13, kPrice: 13, futureValueScale: 1.14, lambdaMax: 4, lambdaScale: 1.08,
        coinBonus: 0.32, playMargin: 2.7, playCandidates: 8, maxPlays: 3, rebuild: 0, rebuildTiles: 9, rebuildBalance: 30, premiumCap: 0, premiumUntil: 15, rivalCap: 0, calRate: 0, starve: 0, cash7: 0, bump: 0, seedPlan: 0, cash7pick: 0, starveMin: 0, rebidDown: 0, brainPremium: 0 },
};
