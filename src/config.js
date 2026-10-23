// Crypto Market Scouter: every number used by the scores and alerts. See FORMULA.md.
// Ideas reused from /workspace/coin-risk-reward/src/config.js: unknown data never adds upside,
// a failed risk source adds HALF the rule's points, grades A<=25 B<=40 C<=55 D, hard fails on authorities.
export const CONFIG = {
  refreshSec: 45,                 // radar refresh (30-60 s)
  maxCoins: 80,                   // coins kept on the radar
  rugcheckPerCycle: 10,           // RugCheck reports fetched per refresh (top-heat coins first)
  rugcheckTtlSec: 300,            // re-check a coin's RugCheck report after 5 min
  timeoutMs: 9000,
  heatWeights: { volume: 25, buys: 25, liquidity: 20, age: 15, holders: 15 },
  heat: {
    volH1Lo: 1000, volH1Hi: 100000,      // log scale, $1k -> 0, $100k -> full (15 of the 25)
    accelLo: 0.5, accelHi: 2.0,          // m5 volume x12 / h1 volume (10 of the 25)
    buyRatioLo: 0.5, buyRatioHi: 0.75,   // h1 buys/(buys+sells) (15 of the 25)
    m5BuysHi: 50,                        // m5 buy count for full marks (10 of the 25)
    liqLo: 5000, liqHi: 100000,          // log scale
    ageRampMin: 10, ageSweetMaxH: 6, ageFadeMaxH: 24, // full 10 min-6 h, fades to 1/3 at 24 h, 0 after
    holderGrowthPerMinHi: 20,            // new holders per minute (seen across RugCheck re-checks)
  },
  riskPoints: { mint: 30, freeze: 30, lp: 20, top10: 20, boosts: 10, bots: 15, lowLiq: 5 },
  unknownFactor: 0.5,             // missing data => half the rule's points (authorities: 10 each, see below)
  authorityUnknownPoints: 10,
  risk: { lpSafePct: 95, top10Lo: 20, top10Hi: 50, boostBig: 500, washTxMin: 200, washImbalanceMax: 0.04, volLiqMax: 10, lowLiqUsd: 10000 },
  grades: [{ g: "A", max: 25 }, { g: "B", max: 40 }, { g: "C", max: 55 }, { g: "D", max: 100 }],
  worth: { minHeat: 65, maxRisk: 40, minLiqUsd: 10000 }, // "of worth" alert defaults (editable in Filters)
  snapshots: [{ k: "+5m", ms: 5 * 60e3 }, { k: "+1h", ms: 3600e3 }, { k: "+24h", ms: 86400e3 }, { k: "+7d", ms: 7 * 86400e3 }],
  snapshotGraceMs: { "+5m": 10 * 60e3, "+1h": 30 * 60e3, "+24h": 3 * 3600e3, "+7d": 12 * 3600e3 }, // later than this => "missed (app closed)"
  storageKey: "cryptoscouter.v1",
  feedUrl: "https://timesnapx.github.io/argus-hades-live/feed.json",
};
