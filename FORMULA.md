# Crypto Market Scouter: scoring rules

All numbers live in `src/config.js` (the Python mirror is `CFG` in `tools/scan.py`). Code: `src/score.js`.
Borrowed from Coin Risk vs Reward (`coin-risk-reward/src/config.js`, `FORMULA.md`): missing data never adds upside (a Heat part with no data scores 0), a risk check with no data adds **half** its points, mint/freeze authority is a hard fail, and the grade bands A ≤ 25, B ≤ 40, C ≤ 55, D > 55.

**Research only, not financial advice.** "unknown" means an API did not return the field. Nothing is guessed.

## Heat (0-100, higher = hotter)

| Part | Max | Rule (DexScreener best-liquidity pair) |
|---|---|---|
| Volume | 25 | 15 × log-scale of 1h volume ($1k → 0, $100k → 15) + 10 × acceleration, where acceleration = (5m volume × 12) / 1h volume, linear from 0.5 → 0 to 2.0 → 10 |
| Buys | 25 | 15 × 1h buy ratio buys/(buys+sells), linear from 0.50 → 0 to 0.75 → 15, + 10 × min(1, 5m buys / 50) |
| Liquidity | 20 | log scale, $5k → 0, $100k → 20 |
| Age | 15 | ramps 0 → 15 over the first 10 min, full 15 from 10 min to 6 h, fades to 5 at 24 h, 0 after |
| Holder growth | 15 | new holders per minute between RugCheck re-reads (every 5 min while the app is open), 20/min → 15. Unknown until two reads exist, so it scores 0 |

## Risk (0-100, higher = worse)

| Check | Points | Unknown |
|---|---|---|
| Mint authority enabled (RugCheck) | +30, **hard fail** | +10 |
| Freeze authority enabled (RugCheck) | +30, **hard fail** | +10 |
| LP locked or burned, liquidity-weighted over all RugCheck markets | 20 × (1 − locked%); 0 at ≥ 95% | +10 |
| Top-10 holder share, AMM/locker/pool accounts excluded | linear 20% → 0 to 50% → 20 | +10 |
| Paid DexScreener boosts (latest + top boosts) | +5 if any, +10 if ≥ 500 | 0 |
| Bot trading: ≥ 200 txns in 1h with buys and sells within 4% of each other | +8 | 0 |
| Bot trading: 1h volume > 10 × liquidity (wash churn) | +7 | 0 |
| Liquidity under $10k | +5 | +2.5 |

The total is capped at 100. A hard fail sets risk to at least 70 (grade D). Grade: A ≤ 25, B ≤ 40, C ≤ 55, D otherwise.

## "Of worth" alert

A coin is **of worth** when all of these hold (defaults, editable in the Alerts tab):
- Heat ≥ **65**
- Risk ≤ **40** (grade A or B)
- Liquidity ≥ **$10,000**
- A RugCheck report exists (mint and freeze authority are known) and neither authority is enabled.

Each coin alerts once per 24 h with an in-app toast, plus a browser notification if you allowed them. Alerts run only while the app is open.

## Trade analytics (before vs after)

- **Log trade** stores side, entry price, amount (USD), time, note and source (me / Ares / Argus / Hades pick). It freezes a BEFORE snapshot: price, market cap, liquidity, 1h and 24h volume, holders, Heat, Risk, grade and the risk flags.
- AFTER snapshots at **+5m, +1h, +24h, +7d** and at **exit** (logging a sell closes that coin's open buys at the sell price). Each one holds P/L % and $ (P/L $ needs an amount), the peak price, the max drawdown from the peak, Heat and Risk changes and any new risk flags.
- Snapshots are taken only while the app is open. If the app was closed past the grace window (+5m: 10 min, +1h: 30 min, +24h: 3 h, +7d: 12 h), the slot reads **missed (app closed)**. Peak and drawdown are what the app saw while it was open.
- Result per trade = exit P/L if closed, else the latest after snapshot. Win rate = share of results > 0. "Did Heat or Risk predict it": a median split on the BEFORE Heat (and Risk), the average result in each half, and the Pearson correlation once there are 3+ trades.
- Stored in `localStorage["cryptoscouter.v1"]`. CSV export in the Analytics tab.
