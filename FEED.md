# feed.json for Ares

URL: https://timesnapx.github.io/crypto-scouter/public/feed.json (schema `crypto-scouter-feed/1`)

Written by `python3 tools/scan.py [--top 10] [--rugcheck 25] [--out public/feed.json]` (Python 3 standard library only, keyless APIs). It runs the same Heat and Risk rules as the app (FORMULA.md), fetches RugCheck for the hottest 25 coins, and keeps the top coins that are **of worth** (Heat ≥ 65, Risk ≤ 40, liquidity ≥ $10k, RugCheck present, no mint/freeze authority). Publish it by committing and pushing `public/feed.json`.

```json
{
 "schema": "crypto-scouter-feed/1",
 "updated_aest": "2026-10-23T22:41:50+10:00",
 "research_only": true,
 "disclaimer": "Research only, not financial advice.",
 "rules": {"worth": {"minHeat": 65, "maxRisk": 40, "minLiqUsd": 10000}, "formula": "…/FORMULA.md"},
 "apis_ok": {"dexscreener_profiles": true, "dexscreener_boosts": true, "geckoterminal_new_pools": true, "dexscreener_token_pairs": true, "rugcheck": true},
 "scanned": 87,
 "of_worth": [{"mint": "…", "symbol": "…", "name": "…", "pair": "…", "priceUsd": 0.000144, "mcap": 138722, "liq": 31050, "volH1": 84241, "volH24": 124247,
   "buysH1": 2164, "sellsH1": 968, "ageMin": 157, "holders": 2042, "mintAuthority": null, "freezeAuthority": null, "lpLockedPct": 78.7, "top10Pct": 21.7,
   "boosts": 500, "heat": 67, "risk": 15, "grade": "A", "flags": ["…"], "dexscreener": "https://dexscreener.com/…", "solscan": "https://solscan.io/token/…"}]
}
```

Rules for Ares: a `null` field means unknown. Do not fill it in. An empty `of_worth` means nothing passed. Check `updated_aest`, because the feed is a snapshot that goes stale. Every post must say "Research only, not financial advice."
Logged trades live only in the user's browser (localStorage), so they are not in this feed.
