#!/usr/bin/env python3
"""Write the current top "of worth" Solana trench coins to public/feed.json for the scout bot Ares.
Same sources and the same Heat / Risk rules as the web app (src/config.js, src/score.js, FORMULA.md).
Keyless public APIs only. Missing data stays null ("unknown"); nothing is invented.
Usage: python3 tools/scan.py [--out public/feed.json] [--top 10]
"""
import json, math, sys, time, urllib.request, argparse, datetime, os

UA = {"User-Agent": "crypto-scouter-scan/1", "Accept": "application/json"}
CFG = json.loads("""{"heat":{"volH1Lo":1000,"volH1Hi":100000,"accelLo":0.5,"accelHi":2.0,"buyRatioLo":0.5,"buyRatioHi":0.75,"m5BuysHi":50,"liqLo":5000,"liqHi":100000,"ageRampMin":10,"ageSweetMaxH":6,"ageFadeMaxH":24,"holderGrowthPerMinHi":20},
"riskPoints":{"mint":30,"freeze":30,"lp":20,"top10":20,"boosts":10,"bots":15,"lowLiq":5},"unknownFactor":0.5,"authorityUnknownPoints":10,
"risk":{"lpSafePct":95,"top10Lo":20,"top10Hi":50,"boostBig":500,"washTxMin":200,"washImbalanceMax":0.04,"volLiqMax":10,"lowLiqUsd":10000},
"worth":{"minHeat":65,"maxRisk":40,"minLiqUsd":10000}}""")
SOL = "So11111111111111111111111111111111111111112"

def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=12) as r: return json.load(r)
    except Exception as e:
        print("WARN", url, e, file=sys.stderr); return None

def n(v):
    try: return None if v is None or v == "" else float(v)
    except Exception: return None
cl = lambda x: max(0.0, min(1.0, x))
lin = lambda x, lo, hi: cl((x - lo) / (hi - lo))
logl = lambda x, lo, hi: cl((math.log10(max(x, 1)) - math.log10(lo)) / (math.log10(hi) - math.log10(lo)))

def heat(c):
    H = CFG["heat"]; v1, v5 = c["volH1"], c["volM5"]; vol = 0
    if v1 is not None:
        vol += logl(v1, H["volH1Lo"], H["volH1Hi"]) * 15
        if v5 is not None and v1 > 0: vol += lin(v5 * 12 / v1, H["accelLo"], H["accelHi"]) * 10
    b, s = c["buysH1"], c["sellsH1"]; buys = 0
    if b is not None and s is not None and b + s > 0: buys += lin(b / (b + s), H["buyRatioLo"], H["buyRatioHi"]) * 15
    if c["buysM5"] is not None: buys += cl(c["buysM5"] / H["m5BuysHi"]) * 10
    liq = logl(c["liq"], H["liqLo"], H["liqHi"]) * 20 if c["liq"] is not None else 0
    age = 0
    if c["ageMin"] is not None:
        m = c["ageMin"]; h = m / 60
        age = m / H["ageRampMin"] if m < H["ageRampMin"] else 1 if h <= H["ageSweetMaxH"] else (1 - (2/3) * (h - H["ageSweetMaxH"]) / (H["ageFadeMaxH"] - H["ageSweetMaxH"])) if h <= H["ageFadeMaxH"] else 0
    # holder growth needs two RugCheck reads over time; a one-shot scan has none => 0 (unknown)
    return min(100, round(vol + buys + liq + age * 15))

def risk(c):
    P, R, U = CFG["riskPoints"], CFG["risk"], CFG["unknownFactor"]; pts = 0; flags = []; hard = False
    def add(p, f): nonlocal pts; pts += p; flags.append(f)
    if c["rug"]:
        if c["mintAuthority"]: add(P["mint"], "Mint authority enabled"); hard = True
        if c["freezeAuthority"]: add(P["freeze"], "Freeze authority enabled"); hard = True
    else: add(CFG["authorityUnknownPoints"], "Mint authority unknown"); add(CFG["authorityUnknownPoints"], "Freeze authority unknown")
    lp = c.get("lpLockedPct")
    if lp is not None:
        if lp < R["lpSafePct"]: add(P["lp"] * (1 - lp / 100), f"LP only {lp:.0f}% locked/burned")
    else: add(P["lp"] * U, "LP lock unknown")
    t10 = c.get("top10Pct")
    if t10 is not None:
        p = lin(t10, R["top10Lo"], R["top10Hi"]) * P["top10"]
        if p > 0: add(p, f"Top-10 holders own {t10:.1f}%")
    else: add(P["top10"] * U, "Top-10 holder share unknown")
    if (c["boosts"] or 0) > 0: add(P["boosts"] if c["boosts"] >= R["boostBig"] else P["boosts"] / 2, f"Paid DexScreener boosts ({c['boosts']:.0f})")
    b, s = c["buysH1"], c["sellsH1"]
    if b is not None and s is not None and b + s >= R["washTxMin"] and abs(b - s) / (b + s) < R["washImbalanceMax"]: add(8, "Bot-like trading: buys ~ sells on high tx count")
    if c["volH1"] is not None and (c["liq"] or 0) > 0 and c["volH1"] / c["liq"] > R["volLiqMax"]: add(7, "Bot-like trading: 1h volume > 10x liquidity")
    if c["liq"] is not None and c["liq"] < R["lowLiqUsd"]: add(P["lowLiq"], "Liquidity under $10k")
    if c["liq"] is None: add(P["lowLiq"] * U, "Liquidity unknown")
    sc = min(100, round(pts)); sc = max(sc, 70) if hard else sc
    return sc, next(g for g, mx in [("A", 25), ("B", 40), ("C", 55), ("D", 100)] if sc <= mx), flags, hard

def rug(mint):
    d = get(f"https://api.rugcheck.xyz/v1/tokens/{mint}/report")
    if not d: return None
    skip = {a for a, v in (d.get("knownAccounts") or {}).items() if any(k in (v or {}).get("type", "").upper() for k in ("AMM", "LOCKER"))}
    locked = tot = 0
    for m in d.get("markets") or []:
        skip.update(x for x in (m.get("pubkey"), m.get("liquidityAAccount"), m.get("liquidityBAccount")) if isinstance(x, str))
        lp = m.get("lp") or {}; t = (n(lp.get("baseUSD")) or 0) + (n(lp.get("quoteUSD")) or 0); tot += t; locked += t * (n(lp.get("lpLockedPct")) or 0) / 100
    th = d.get("topHolders") or []; hs = [h for h in th if h.get("address") not in skip and h.get("owner") not in skip]
    return {"mintAuthority": d.get("mintAuthority"), "freezeAuthority": d.get("freezeAuthority"), "lpLockedPct": locked / tot * 100 if tot else None,
            "top10Pct": sum(n(h.get("pct")) or 0 for h in hs[:10]) if th else None, "holders": n(d.get("totalHolders"))}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "feed.json")); ap.add_argument("--top", type=int, default=10); ap.add_argument("--rugcheck", type=int, default=25)
    a = ap.parse_args(); apis = {}
    seeds, boosts = [], {}
    j = get("https://api.dexscreener.com/token-profiles/latest/v1"); apis["dexscreener_profiles"] = j is not None
    seeds += [x["tokenAddress"] for x in (j or []) if x.get("chainId") == "solana"]
    for u in ("https://api.dexscreener.com/token-boosts/latest/v1", "https://api.dexscreener.com/token-boosts/top/v1"):
        j = get(u); apis["dexscreener_boosts"] = apis.get("dexscreener_boosts", False) or j is not None
        for x in j or []:
            if x.get("chainId") == "solana": boosts[x["tokenAddress"]] = max(boosts.get(x["tokenAddress"], 0), n(x.get("totalAmount")) or n(x.get("amount")) or 0)
    seeds += list(boosts)
    for p in (1, 2):
        j = get(f"https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page={p}"); apis["geckoterminal_new_pools"] = apis.get("geckoterminal_new_pools", False) or j is not None
        for d in (j or {}).get("data", []):
            m = ((d.get("relationships") or {}).get("base_token") or {}).get("data", {}).get("id", "").replace("solana_", "")
            if m and m != SOL: seeds.append(m)
    mints = list(dict.fromkeys(seeds))[:150]; best = {}
    for i in range(0, len(mints), 30):
        for p in get("https://api.dexscreener.com/tokens/v1/solana/" + ",".join(mints[i:i+30])) or []:
            m = p.get("baseToken", {}).get("address")
            if m and (m not in best or (n((p.get("liquidity") or {}).get("usd")) or 0) > (n((best[m].get("liquidity") or {}).get("usd")) or 0)): best[m] = p
    apis["dexscreener_token_pairs"] = bool(best)
    coins = []
    for m, p in best.items():
        g = lambda *k: n(_dig(p, k))
        ca = g("pairCreatedAt")
        coins.append({"mint": m, "symbol": p["baseToken"].get("symbol"), "name": p["baseToken"].get("name"), "pair": p.get("pairAddress"), "priceUsd": g("priceUsd"), "mcap": g("marketCap") if g("marketCap") is not None else g("fdv"),
            "liq": g("liquidity", "usd"), "volM5": g("volume", "m5"), "volH1": g("volume", "h1"), "volH24": g("volume", "h24"), "buysM5": g("txns", "m5", "buys"), "buysH1": g("txns", "h1", "buys"), "sellsH1": g("txns", "h1", "sells"),
            "ageMin": (time.time() * 1000 - ca) / 60000 if ca else None, "boosts": boosts.get(m, 0), "rug": False, "dexscreener": p.get("url"), "solscan": f"https://solscan.io/token/{m}"})
    for c in coins: c["heat"] = heat(c)
    coins.sort(key=lambda c: -c["heat"])
    rc_ok = False
    for c in coins[: a.rugcheck]:
        r = rug(c["mint"]); time.sleep(0.3)
        if r: c.update(r); c["rug"] = True; rc_ok = True
    apis["rugcheck"] = rc_ok
    W = CFG["worth"]; out = []
    for c in coins:
        c["risk"], c["grade"], c["flags"], hard = risk(c)
        if c["rug"] and not hard and c["heat"] >= W["minHeat"] and c["risk"] <= W["maxRisk"] and (c["liq"] or 0) >= W["minLiqUsd"]: out.append(c)
    out.sort(key=lambda c: (-c["heat"], c["risk"]))
    keep = ["mint", "symbol", "name", "pair", "priceUsd", "mcap", "liq", "volH1", "volH24", "buysH1", "sellsH1", "ageMin", "holders", "mintAuthority", "freezeAuthority", "lpLockedPct", "top10Pct", "boosts", "heat", "risk", "grade", "flags", "dexscreener", "solscan"]
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=10)))
    feed = {"schema": "crypto-scouter-feed/1", "updated_aest": now.isoformat(timespec="seconds"), "research_only": True, "disclaimer": "Research only, not financial advice.",
            "rules": {"worth": W, "formula": "https://github.com/TimeSnapX/crypto-scouter/blob/main/FORMULA.md"}, "apis_ok": apis, "scanned": len(coins),
            "of_worth": [{k: (round(c.get(k), 6) if isinstance(c.get(k), float) else c.get(k)) for k in keep} for c in out[: a.top]]}
    with open(a.out, "w") as f: json.dump(feed, f, indent=1)
    print(f"scanned {len(coins)} coins, {len(out)} of worth, wrote {len(feed['of_worth'])} to {a.out}; apis {apis}")

def _dig(o, ks):
    for k in ks:
        if not isinstance(o, dict): return None
        o = o.get(k)
    return o

if __name__ == "__main__": main()
