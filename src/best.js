// Best Performers: the biggest trench coins so far, from real keyless data only. Cached in localStorage.
// Sources: CoinGecko categories "pump-fun" + "solana-meme-coins" (ATH, ATH date, 7d/30d change),
// CoinGecko coins/list (id -> Solana mint), DexScreener tokens (launch date = earliest pair, liquidity, dex),
// GeckoTerminal top pools by 24h volume on PumpSwap and Raydium. Fields a source does not give read "unknown".
import * as A from "./api.js";
const KEY = "cryptoscouter.best.v1", MAP = "cryptoscouter.cgmap.v1", TTL = 30 * 60e3;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n = (v) => (v === null || v === undefined || v === "" || isNaN(+v) ? null : +v);
const U = "unknown";
const usd = (v) => v === null || v === undefined ? U : v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + v.toFixed(0);
const pct = (v) => (v === null || v === undefined ? U : (v > 0 ? "+" : "") + v.toFixed(1) + "%");
const days = (ms) => (ms === null || ms === undefined ? U : ms < 86400e3 ? (ms / 3600e3).toFixed(1) + "h" : ms < 365 * 86400e3 ? Math.round(ms / 86400e3) + "d" : (ms / (365 * 86400e3)).toFixed(1) + "y");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = {};
async function get(name, url) {
  try { const r = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } }); if (!r.ok) throw new Error("HTTP " + r.status); const j = await r.json(); status[name] = "ok"; return j; }
  catch (e) { status[name] = "failed (" + (e.message === "Failed to fetch" ? "network/CORS or rate limit" : e.message) + ")"; return null; }
}
let data = (() => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } })();
let busy = false, P = { range: "all", minMcap: 1e6 }, H = {};

async function load() {
  if (busy) return; busy = true; H.rerender?.();
  const coins = new Map(); // mint or cg id -> row
  // 1. CoinGecko categories (2 calls, ~1.5 s apart to respect the free limit)
  const cg = [];
  for (const cat of ["pump-fun", "solana-meme-coins"]) {
    const j = await get("CoinGecko " + cat, `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${cat}&order=market_cap_desc&per_page=100&page=1&price_change_percentage=7d,30d`);
    for (const x of Array.isArray(j) ? j : []) if (!cg.find((y) => y.id === x.id)) cg.push({ ...x, cat }); await sleep(1500);
  }
  // 2. CoinGecko id -> Solana mint (big list, fetched only for ids we don't know yet; mapping cached)
  let map = (() => { try { return JSON.parse(localStorage.getItem(MAP)) || {}; } catch { return {}; } })();
  if (cg.some((x) => !(x.id in map))) { const l = await get("CoinGecko coins/list", "https://api.coingecko.com/api/v3/coins/list?include_platform=true");
    if (Array.isArray(l)) { const want = new Set(cg.map((x) => x.id)); for (const c of l) if (want.has(c.id)) map[c.id] = c.platforms?.solana || null; localStorage.setItem(MAP, JSON.stringify(map)); } }
  for (const x of cg) { const mint = map[x.id] || null; if (!mint) continue; // not a Solana token
    const circ = n(x.circulating_supply);
    coins.set(mint, { mint, cgId: x.id, symbol: (x.symbol || "").toUpperCase(), name: x.name, image: x.image, src: ["CoinGecko " + x.cat], mcap: n(x.market_cap), price: n(x.current_price),
      ath: n(x.ath), athDate: Date.parse(x.ath_date) || null, athMcap: n(x.ath) !== null && circ ? x.ath * circ : null, athMcapNote: "ATH price × current circulating supply",
      dd: n(x.ath_change_percentage), ch7: n(x.price_change_percentage_7d_in_currency), ch30: n(x.price_change_percentage_30d_in_currency), ch24: n(x.price_change_percentage_24h), atl: n(x.atl), atlDate: Date.parse(x.atl_date) || null }); }
  // 3. GeckoTerminal top pools by 24h volume on PumpSwap + Raydium (keeps coins CoinGecko doesn't list)
  for (const dex of ["pumpswap", "raydium"]) {
    const j = await get("GeckoTerminal " + dex, `https://api.geckoterminal.com/api/v2/networks/solana/dexes/${dex}/pools?sort=h24_volume_usd_desc&page=1`); await sleep(2500);
    for (const d of j?.data || []) { const mint = (d.relationships?.base_token?.data?.id || "").replace(/^solana_/, ""); if (!mint || mint === "So11111111111111111111111111111111111111112" || /^(EPjF|Es9v)/.test(mint)) continue;
      const a = d.attributes || {}; const r = coins.get(mint) || { mint, symbol: (a.name || "").split(" / ")[0], name: null, src: [], mcap: n(a.market_cap_usd) ?? n(a.fdv_usd), ath: null, athMcap: null, dd: null, ch7: null, ch30: null, ch24: n(a.price_change_percentage?.h24) };
      r.src = [...new Set([...r.src, "GeckoTerminal " + dex])]; r.vol24 = Math.max(r.vol24 || 0, n(a.volume_usd?.h24) || 0); coins.set(mint, r); }
  }
  // 4. DexScreener token pairs: launch date (earliest pair), liquidity, dex, migration
  const mints = [...coins.keys()];
  for (let i = 0; i < mints.length; i += 30) {
    const j = await get("DexScreener tokens", "https://api.dexscreener.com/tokens/v1/solana/" + mints.slice(i, i + 30).join(","));
    for (const p of Array.isArray(j) ? j : []) { const r = coins.get(p.baseToken?.address); if (!r) continue;
      const t = n(p.pairCreatedAt); if (t && (!r.launch || t < r.launch)) r.launch = t;
      r.liq = (r.liq || 0) + (n(p.liquidity?.usd) || 0); r.dexes = [...new Set([...(r.dexes || []), p.dexId])];
      if (!r.bestPair || (n(p.liquidity?.usd) || 0) > (n(r.bestPair.liquidity?.usd) || 0)) r.bestPair = { url: p.url, dex: p.dexId, liquidity: p.liquidity };
      r.mcap = r.mcap ?? n(p.marketCap); r.name = r.name || p.baseToken.name; r.symbol = r.symbol || p.baseToken.symbol; r.image = r.image || p.info?.imageUrl; r.ch24 = r.ch24 ?? n(p.priceChange?.h24); }
    await sleep(300);
  }
  for (const r of coins.values()) { delete r.bestPair?.liquidity;
    r.pumpLaunched = /pump$/.test(r.mint) || (r.dexes || []).some((d) => /pump/.test(d));
    r.migrated = (r.dexes || []).some((d) => /pumpswap|raydium|meteora|orca/.test(d)) ? true : r.dexes ? false : null;
    r.ageAtAth = r.launch && r.athDate && r.athDate >= r.launch ? r.athDate - r.launch : null;
    // Multiple from launch is only knowable if we have a launch price; none of the free sources give one, so it stays unknown.
    r.multiple = null; r.multipleNote = "no keyless source gives the launch price";
    r.athX = r.athMcap && r.mcap ? r.athMcap / r.mcap : null; }
  // 5. Holders from RugCheck for the top 10 by ATH market cap (1 request each, spaced)
  const top = [...coins.values()].filter((r) => r.athMcap || r.mcap).sort((a, b) => (b.athMcap || b.mcap) - (a.athMcap || a.mcap)).slice(0, 10);
  for (const r of top) { const rep = await A.rugReport(r.mint); if (rep) r.holders = rep.holders; status.RugCheck = A.apiStatus.RugCheck?.ok ? "ok" : "failed (" + (A.apiStatus.RugCheck?.err || "?") + ")"; await sleep(700); }
  data = { at: Date.now(), rows: [...coins.values()], status: { ...status } };
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
  busy = false; H.rerender?.();
}
const med = (a) => { const s = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const q = (a, f) => { const s = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : null; };
function common(rows) {
  const k = rows.length; if (!k) return "";
  const age = rows.map((r) => r.ageAtAth), liq = rows.map((r) => r.liq || null), mig = rows.filter((r) => r.migrated !== null), pumpL = rows.filter((r) => r.pumpLaunched).length;
  const dd = rows.map((r) => r.dd), life = rows.map((r) => r.launch ? Date.now() - r.launch : null), liqMc = rows.map((r) => r.liq && r.mcap ? (r.liq / r.mcap) * 100 : null);
  const cnt = (a) => a.filter((x) => x !== null && x !== undefined).length;
  return `<div class="panel glass"><h3>What they had in common</h3><small>From the ${k} coins shown only: a small, survivor-biased sample (these are coins that already made it), not a rule.</small><ul>
   <li>Age at ATH (launch → ATH): median <b>${days(med(age))}</b>, middle half ${days(q(age, 0.25))}–${days(q(age, 0.75))} (${cnt(age)} coins with both dates)</li>
   <li>Age today: median <b>${days(med(life))}</b> (${cnt(life)} known)</li>
   <li>Liquidity now: median <b>${usd(med(liq))}</b>, middle half ${usd(q(liq, 0.25))}–${usd(q(liq, 0.75))}; liquidity / market cap median ${med(liqMc) !== null ? med(liqMc).toFixed(1) + "%" : U} (${cnt(liq)} known)</li>
   <li>Launched on pump.fun (mint ends in "pump" or a pump.fun pair): <b>${pumpL}/${k}</b> (${Math.round((pumpL / k) * 100)}%)</li>
   <li>Migrated to a DEX pool (PumpSwap/Raydium/Meteora/Orca pair on DexScreener): <b>${mig.filter((r) => r.migrated).length}/${mig.length}</b> with DexScreener data</li>
   <li>Drawdown from ATH now: median <b>${pct(med(dd))}</b> (${cnt(dd)} known): most of the best ever trade far below their peak</li></ul></div>`;
}
export function renderBest(main) {
  if (!data && !busy) load();
  const rows0 = data?.rows || [];
  const key = { all: (r) => r.athMcap ?? r.mcap ?? -1, "30d": (r) => r.ch30 ?? -1e9, "7d": (r) => r.ch7 ?? -1e9 }[P.range];
  const rows = rows0.filter((r) => (r.mcap ?? 0) >= P.minMcap && (P.range === "all" || (P.range === "30d" ? r.ch30 !== null : r.ch7 !== null))).sort((a, b) => key(b) - key(a)).slice(0, 60);
  main.innerHTML = `<div class="panel glass"><div class="row" style="align-items:center"><h2>Best Performers</h2><span class="tag worth-tag">RESEARCH ONLY</span>
    <label>Range <select id="bRange"><option value="all">All-time (ATH market cap)</option><option value="30d">30d price change</option><option value="7d">7d price change</option></select></label>
    <label>Min market cap $<input id="bMin" type="number" min="0" step="100000" value="${P.minMcap}"></label>
    <button class="btn small" id="bRef">${busy ? "Loading… (rate-limited, ~20 s)" : "⟳ Refresh"}</button>
    <small>${data ? `Cached ${new Date(data.at).toLocaleString("en-AU")} · ${rows0.length} coins · ${rows.length} shown` : ""}</small></div>
    <small>Sources: ${Object.entries(data?.status || status).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ") || "loading"}. ATH market cap = CoinGecko ATH price × current circulating supply. 7d/30d come from CoinGecko only, so GeckoTerminal-only coins drop out of those views. Launched = earliest DexScreener pair still listed (can be later than the real launch; then age at ATH reads unknown). Multiple from launch is unknown: no keyless source gives the launch price. <b>Research only, not financial advice.</b></small></div>
   ${common(rows)}
   ${rows.length ? `<div class="panel glass scroll"><table class="best"><tr><th>#</th><th>Coin</th><th>Launched</th><th>Age</th><th>ATH mcap</th><th>ATH date</th><th>Age at ATH</th><th>Mcap now</th><th>× from launch</th><th>From ATH</th><th>7d</th><th>30d</th><th>Liquidity</th><th>Holders</th><th>Migrated</th><th>Links</th></tr>
    ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.image ? `<img src="${esc(r.image)}" alt="" width="20" height="20" loading="lazy" referrerpolicy="no-referrer"> ` : ""}<b>${esc(r.symbol || U)}</b> <small>${esc(r.name || "")}</small></td>
     <td>${r.launch ? new Date(r.launch).toLocaleDateString("en-AU") : U}</td><td>${r.launch ? days(Date.now() - r.launch) : U}</td><td title="${esc(r.athMcapNote || "")}">${usd(r.athMcap)}</td><td>${r.athDate ? new Date(r.athDate).toLocaleDateString("en-AU") : U}</td><td>${days(r.ageAtAth)}</td>
     <td>${usd(r.mcap)}</td><td title="${esc(r.multipleNote)}">${U}</td><td class="${(r.dd ?? 0) < -50 ? "dn" : ""}">${pct(r.dd)}</td><td>${pct(r.ch7)}</td><td>${pct(r.ch30)}</td><td>${r.liq ? usd(r.liq) : U}</td><td>${r.holders ?? U}</td><td>${r.migrated === null ? U : r.migrated ? "yes" : "no"}</td>
     <td><button class="btn small" data-copy="${esc(r.mint)}">CA</button> <a target="_blank" rel="noopener" href="${esc(r.bestPair?.url || "https://dexscreener.com/solana/" + r.mint)}">DS</a> · <a target="_blank" rel="noopener" href="https://solscan.io/token/${esc(r.mint)}">Solscan</a>${r.cgId ? ` · <a target="_blank" rel="noopener" href="https://www.coingecko.com/en/coins/${esc(r.cgId)}">CG</a>` : ""}${r.pumpLaunched ? ` · <a target="_blank" rel="noopener" href="https://pump.fun/coin/${esc(r.mint)}">pump</a>` : ""}</td></tr>`).join("")}</table></div>`
    : `<p class="empty">${busy ? "Loading real data from CoinGecko, GeckoTerminal and DexScreener…" : data ? "No coins match." : "Loading…"}</p>`}`;
  main.querySelector("#bRange").value = P.range;
  main.querySelector("#bRange").onchange = (e) => { P.range = e.target.value; renderBest(main); };
  main.querySelector("#bMin").onchange = (e) => { P.minMcap = +e.target.value || 0; renderBest(main); };
  main.querySelector("#bRef").onclick = () => { if (!busy && (!data || Date.now() - data.at > 60e3 || confirm("Refreshed under a minute ago. Refresh again anyway?"))) load(); };
}
export function initBest(h) { H = h; if (data && Date.now() - data.at > TTL) { /* stale: refresh when the tab opens */ data.stale = true; } }
export const bestBusy = () => busy;
export const bestNeedsLoad = () => !data || data.stale;
export { load as loadBest };
