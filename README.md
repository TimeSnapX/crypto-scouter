# Crypto Market Scouter

A live Solana trench-coin radar: https://timesnapx.github.io/crypto-scouter/ (installable PWA). **Research only, not financial advice.**

- Live feed from DexScreener (latest profiles, boosts, token pairs) and GeckoTerminal (new Solana pools), refreshed every 45 s. RugCheck supplies mint/freeze authority, LP lock, top-10 share and holders.
- Heat and Risk scores, plus "of worth" alerts (see [FORMULA.md](FORMULA.md)). Also a watchlist, filters, a coin drawer with a GeckoTerminal 5m chart, DexScreener/Solscan links and a copy-CA button.
- Log trades and get before-vs-after analytics (+5m/+1h/+24h/+7d/exit). Includes win rate, whether Heat or Risk predicted the result, a my-trades vs Ares/Argus/Hades split, and CSV export. Data stays in localStorage `cryptoscouter.v1`.
- Argus and Hades tabs read https://timesnapx.github.io/argus-hades-live/feed.json when it is reachable.
- `public/feed.json` plus `tools/scan.py` for the scout bot Ares ([FEED.md](FEED.md)).

Static files, no build step. To run locally: `python3 -m http.server` and open `/`.
