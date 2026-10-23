// Launch Feed: every new pump.fun token, live from PumpPortal's free public websocket (no key).
// Quick score rules: FORMULA.md "Launch Feed". Numbers: CONFIG.launch. Nothing here is estimated or made up:
// fields the stream does not carry read "unknown".
import { CONFIG } from "./config.js";
import * as A from "./api.js";
const L = CONFIG.launch;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cl = (x) => Math.max(0, Math.min(1, x));
const num = (v) => (v === null || v === undefined || isNaN(+v) ? null : +v);

export const launches = new Map();          // mint -> launch (insertion order = arrival order)
const creators = new Map();                 // creator wallet -> Set(mints) seen this session
const names = new Map();                    // normalized name/symbol -> first mint seen
const subs = new Set();                     // mints with subscribeTokenTrade active
export const migrations = [];               // recent graduations (also for coins launched before this session)
const st = { ws: null, paused: false, status: "connecting", connectedAt: 0, firstAt: 0, msgs: 0, retry: 0, lastAlert: 0, alerted: new Set(), meta: 0 };
let H = {};                                 // hooks from app.js: toast, addToRadar, isOpen, rerender, prefs, save
export const launchState = st;

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function nameFlags(c) {
  const f = []; const sym = String(c.symbol || ""), nm = String(c.name || "");
  if (!sym.trim() || !nm.trim()) f.push("empty name or ticker");
  if (sym.length > 10) f.push("ticker longer than 10 chars");
  if (/(.)\1{3,}/i.test(sym + " " + nm)) f.push("repeated characters");
  if (/^\d+$/.test(sym) || /https?:|www\.|\.com|t\.me/i.test(sym + nm)) f.push("spammy name (digits only or a link)");
  if (L.famous.includes(sym.toUpperCase().replace(/^\$/, "")) || L.famous.includes(nm.toUpperCase().replace(/\s/g, ""))) f.push(`copycat of a famous ticker (${sym || nm})`);
  const k1 = "s:" + norm(sym), k2 = "n:" + norm(nm);
  for (const k of [k1, k2]) { const first = names.get(k); if (first && first !== c.mint && k.length > 2) { f.push(`copycat: same ${k[0] === "s" ? "ticker" : "name"} as an earlier launch this session`); break; } }
  return [...new Set(f)];
}
export function quickScore(c) {
  const W = L.weights, flags = [], parts = {};
  // 1. dev initial buy
  const sol = num(c.devSol), supplyPct = num(c.devTokens) !== null ? (c.devTokens / 1e9) * 100 : null;
  if (sol === null) parts.dev = 0;
  else if (sol === 0) { parts.dev = 0; flags.push("zero dev buy"); }
  else if (sol > L.devBuy.bigSol || (supplyPct ?? 0) > L.devBuy.bigSupplyPct) { parts.dev = 0; flags.push(`very large dev buy (${sol.toFixed(2)} SOL, ${supplyPct?.toFixed(1)}% of supply)`); }
  else parts.dev = (sol >= L.devBuy.goodLoSol && sol <= L.devBuy.goodHiSol ? 1 : 0.5) * W.dev;
  // 2. serial launcher
  const n = creators.get(c.creator)?.size || 1;
  if (n > 1) { parts.serial = 0; flags.push(`serial launcher (${n} coins this session)`); } else parts.serial = W.serial;
  // 3. name/ticker spam + copycat
  const nf = c.nameFlags || []; flags.push(...nf); parts.name = nf.length ? 0 : W.name;
  // 4. early buy velocity (first 60 s, dev excluded), only for coins whose trades we watched
  parts.velocity = c.velAtSec ? cl(c.buys60 / L.velocity.buysHi) * W.velocity * 0.6 + cl((c.vol60 || 0) / L.velocity.volUsdHi) * W.velocity * 0.4 : 0;
  // 5. bonding-curve progress
  parts.curve = c.curvePct !== null ? cl(c.curvePct / L.curveHiPct) * W.curve : 0;
  const score = Math.round(Object.values(parts).reduce((a, x) => a + x, 0));
  return { score: Math.min(100, score), parts, flags, flagged: flags.length > 0 };
}
const curvePct = (vTok) => { const v = num(vTok); if (v === null) return null; const { start, end } = L.curveTokens; return Math.max(0, Math.min(100, ((start - v) / (start - end)) * 100)); };

function onCreate(m) {
  if (launches.has(m.mint)) return;
  const now = Date.now(); if (!st.firstAt) st.firstAt = now;
  const c = { mint: m.mint, seenAt: now, name: m.name ?? null, symbol: m.symbol ?? null, uri: m.uri || null, image: null, creator: m.traderPublicKey || null,
    devSol: num(m.solAmount), devTokens: num(m.initialBuy), vSol: num(m.vSolInBondingCurve), curvePct: curvePct(m.vTokensInBondingCurve), mcapSol: num(m.marketCapSol),
    curveKey: m.bondingCurveKey || null, pool: m.pool || null, mayhem: !!m.is_mayhem_mode, buys: null, sells: null, buyers: null, buys60: 0, vol60: null, velAtSec: null, watchedFrom: null, migrated: false, promoted: null, sig: m.signature };
  if (c.creator) { if (!creators.has(c.creator)) creators.set(c.creator, new Set()); creators.get(c.creator).add(c.mint); }
  c.nameFlags = nameFlags(c);
  for (const k of ["s:" + norm(c.symbol), "n:" + norm(c.name)]) if (k.length > 2 && !names.has(k)) names.set(k, c.mint);
  launches.set(c.mint, c);
  // serial launcher: re-flag the creator's earlier coins too
  for (const mm of creators.get(c.creator) || []) { const o = launches.get(mm); if (o) o.q = quickScore(o); }
  c.q = quickScore(c);
  while (launches.size > L.maxCoins) { const old = launches.keys().next().value; unsub(old); launches.delete(old); }
  maybeSub(c); checkAlert(c);
}
// Early trades: PumpPortal's subscribeTokenTrade needs a paid API key, so trades come from GeckoTerminal
// (keyless) by polling the pump.fun bonding-curve pools of the watched coins, all in ONE request every 20 s.
async function pollTrades() {
  if (Date.now() < (st.gtBackoff || 0) || H.gtBusy?.()) return; // share GeckoTerminal's free limit with the other tabs
  const ms = [...subs].map((m) => launches.get(m)).filter((c) => c && c.curveKey); if (!ms.length) return;
  let j = null; try { const r = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/" + ms.map((c) => c.curveKey).join(","), { cache: "no-store", headers: { accept: "application/json" } });
    st.gt = r.ok ? "ok" : "HTTP " + r.status; if (r.ok) j = await r.json(); else st.gtBackoff = Date.now() + 60e3; } catch (e) { st.gt = "rate-limited, backing off 60 s"; st.gtBackoff = Date.now() + 60e3; }
  const now = Date.now();
  for (const d of j?.data || []) { const a = d.attributes || {}; const c = ms.find((x) => x.curveKey === a.address); if (!c) continue;
    const t = a.transactions?.m5 || {}; if (num(t.buys) === null) continue; // GeckoTerminal not indexed yet: stays unknown
    c.buys = num(t.buys); c.sells = num(t.sells); c.buyers = num(t.buyers); c.volM5 = num(a.volume_usd?.m5); c.tradesAt = now;
    if (now - c.seenAt <= L.velocity.windowSec * 1000 * 2) { c.buys60 = c.buys; c.vol60 = c.volM5; c.velAtSec = Math.round((now - c.seenAt) / 1000); }
    c.q = quickScore(c); checkAlert(c); }
}
function onMigrate(m) {
  const c = launches.get(m.mint); if (c) { c.migrated = m.pool || true; c.curvePct = 100; c.q = quickScore(c); }
  migrations.unshift({ mint: m.mint, pool: m.pool || null, at: Date.now(), symbol: c?.symbol || null }); migrations.length = Math.min(migrations.length, 20);
}
// ---- trade watch list (cap ~30 coins, polled on GeckoTerminal) ----
function send(o) { if (st.ws?.readyState === 1) st.ws.send(JSON.stringify(o)); }
function unsub(mint) { subs.delete(mint); }
function maybeSub(c) {
  if (c.q.flags.some((f) => /zero dev|serial|spammy|empty/.test(f))) return; // don't spend a slot on obvious junk
  if (subs.size >= L.tradeSubCap) { // swap out the weakest coin that has had its minimum watch time
    const now = Date.now(); let worst = null;
    for (const m of subs) { const o = launches.get(m); if (!o) { subs.delete(m); continue; } if (now - o.watchedFrom < L.tradeSubMinHoldSec * 1000) continue; if (!worst || o.q.score < worst.q.score) worst = o; }
    if (!worst) return; unsub(worst.mint);
  }
  subs.add(c.mint); c.watchedFrom = Date.now();
}
function pruneSubs() { const now = Date.now(); for (const m of subs) { const c = launches.get(m); if (!c || now - c.seenAt > L.tradeSubMaxAgeSec * 1000) unsub(m); } }

// ---- connection ----
function connect() {
  if (st.paused) return;
  st.status = "connecting"; let ws;
  try { ws = new WebSocket(L.wsUrl); } catch (e) { st.status = "error: " + e.message; return retry(); }
  st.ws = ws;
  ws.onopen = () => { st.status = "live"; st.connectedAt = Date.now(); st.retry = 0; send({ method: "subscribeNewToken" }); send({ method: "subscribeMigration" }); H.rerender?.(); };
  ws.onmessage = (e) => { st.msgs++; let m; try { m = JSON.parse(e.data); } catch { return; }
    if (!m.mint) return; if (m.txType === "create") onCreate(m); else if (m.txType === "migrate") onMigrate(m); };
  ws.onerror = () => { st.status = "error (websocket)"; };
  ws.onclose = () => { if (st.ws !== ws) return; st.ws = null; if (!st.paused) { st.status = "disconnected, retrying"; retry(); } H.rerender?.(); };
}
function retry() { st.retry++; setTimeout(connect, Math.min(30e3, 1000 * 2 ** Math.min(st.retry, 5))); }
export function setPaused(p) {
  st.paused = p;
  if (p) { st.status = "paused"; const ws = st.ws; st.ws = null; ws?.close(); } else connect();
}

// ---- promotion to the main radar (DexScreener pair or RugCheck report exists) ----
async function promote() {
  const now = Date.now();
  const cand = [...launches.values()].filter((c) => !c.promoted && now - c.seenAt > L.promoteMinAgeSec * 1000 && !c.q.flags.some((f) => /zero dev|serial|spammy|empty/.test(f)))
    .sort((a, b) => b.q.score - a.q.score).slice(0, L.promotePerCycle);
  if (!cand.length) return;
  const pairs = await A.dsTokens(cand.map((c) => c.mint));
  for (const c of cand) if (pairs.get(c.mint)) { c.promoted = "DexScreener"; H.addToRadar?.(c, pairs.get(c.mint), null); }
  for (const c of cand.filter((c) => !c.promoted).slice(0, L.rugcheckPerCycle)) {
    const rep = await A.rugReport(c.mint); if (rep) { c.promoted = "RugCheck"; H.addToRadar?.(c, null, rep); }
  }
}

// ---- filters + alert ----
export function passes(c, F = H.prefs()) {
  const q = (F.q || "").trim().toLowerCase();
  return (!F.hideFlagged || !c.q.flagged) && c.buys60 >= (F.minBuys || 0) && c.q.score >= (F.minScore || 0)
    && (!q || (c.name || "").toLowerCase().includes(q) || (c.symbol || "").toLowerCase().includes(q) || c.mint.toLowerCase() === q || (c.creator || "").toLowerCase() === q);
}
let actx = null;
function beep() { try { actx = actx || new AudioContext(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; g.gain.setValueAtTime(0.08, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.25); o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.26); } catch {} }
function checkAlert(c) {
  const F = H.prefs?.(); if (!F || (!F.sound && !F.notify) || st.alerted.has(c.mint) || !passes(c, F)) return;
  if (!(F.q || F.minBuys || F.minScore || F.hideFlagged)) return; // never ping every launch: needs at least one filter
  const now = Date.now(); if (now - st.lastAlert < L.alertMinGapSec * 1000) return;
  st.alerted.add(c.mint); st.lastAlert = now;
  const msg = `${c.symbol || "?"} (${c.name || "?"}) · quick ${c.q.score} · ${c.buys60} early buys`;
  if (F.sound) beep();
  H.toast?.("🚀 Launch: " + msg);
  if (F.notify && "Notification" in window && Notification.permission === "granted")
    navigator.serviceWorker?.getRegistration().then((r) => r ? r.showNotification("Launch: " + (c.symbol || "?"), { body: msg + "\nResearch only, not financial advice.", icon: "icons/icon-192.png", tag: "l-" + c.mint }) : new Notification("Launch: " + (c.symbol || "?"), { body: msg }));
}

// ---- rendering ----
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "unknown");
const secs = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 120 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : (s / 3600).toFixed(1) + "h"; };
const f2 = (v, d = 2) => (v === null || v === undefined ? "unknown" : (+v).toFixed(d));
function lcard(c) {
  const img = `https://images.pump.fun/coin-image/${encodeURIComponent(c.mint)}?variant=86x86`;
  const q = c.q, sol = c.vSol !== null ? Math.max(0, c.vSol - 30) : null; // real SOL in the curve = virtual SOL - 30 virtual
  return `<div class="coin glass lcard ${q.flagged ? "flagged" : ""}">
   <div class="c-top"><div class="ph limg">${esc((c.symbol || "?")[0])}<img src="${img}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></div>
    <div class="c-name"><b>${esc(c.symbol || "unknown")}</b><small>${esc(c.name || "unknown")}</small></div><span class="age" data-t="${c.seenAt}">${secs(c.seenAt)}</span></div>
   <div class="scores"><span class="pill ${q.score >= 60 ? "hot" : q.score >= 35 ? "warm" : "cold"}" title="dev ${q.parts.dev.toFixed(0)} · serial ${q.parts.serial} · name ${q.parts.name} · velocity ${q.parts.velocity.toFixed(0)} · curve ${q.parts.curve.toFixed(0)}">Quick ${q.score}</span>
    ${c.migrated ? `<span class="tag worth-tag">GRADUATED ${esc(typeof c.migrated === "string" ? c.migrated : "")}</span>` : ""}${c.promoted ? `<span class="tag">ON RADAR (${c.promoted})</span>` : ""}${subs.has(c.mint) ? '<span class="tag">● trades watched</span>' : ""}${c.mayhem ? '<span class="tag">mayhem</span>' : ""}</div>
   <div class="kv"><span>Dev buy</span><b>${f2(c.devSol)} SOL${c.devTokens !== null ? ` · ${((c.devTokens / 1e9) * 100).toFixed(1)}%` : ""}</b><span>SOL in curve</span><b>${f2(sol)}</b>
    <span>Curve</span><b>${c.curvePct !== null ? c.curvePct.toFixed(1) + "%" : "unknown"}</b><span>Early buys</span><b>${c.velAtSec ? `${c.buys60} by ${c.velAtSec}s ($${(c.vol60 || 0).toFixed(0)})` : c.watchedFrom ? "pending (GeckoTerminal)" : "not watched"}</b>
    <span>Creator</span><b><a href="https://solscan.io/account/${esc(c.creator)}" target="_blank" rel="noopener" title="${esc(c.creator)}">${short(c.creator)}</a>${(creators.get(c.creator)?.size || 1) > 1 ? ` ×${creators.get(c.creator).size}` : ""}</b>
    <span>Buys/Sells 5m</span><b>${c.buys !== null ? `${c.buys}/${c.sells} · ${c.buyers ?? "?"} buyers` : "unknown"}</b></div>
   ${q.flags.length ? `<ul class="flags">${q.flags.map((f) => `<li class="warn">${esc(f)}</li>`).join("")}</ul>` : ""}
   <div class="row"><button class="btn small" data-copy="${esc(c.mint)}">Copy CA</button><a class="btn small" target="_blank" rel="noopener" href="https://pump.fun/coin/${esc(c.mint)}">pump.fun</a>
    <a class="btn small" target="_blank" rel="noopener" href="https://dexscreener.com/solana/${esc(c.mint)}">DexScreener</a><a class="btn small" target="_blank" rel="noopener" href="https://solscan.io/token/${esc(c.mint)}">Solscan</a>
    ${c.promoted ? `<button class="btn small primary" data-open="${esc(c.mint)}">Open on radar</button>` : ""}</div></div>`;
}
export function renderLaunch(main) {
  const F = H.prefs();
  if (!main.querySelector("#lgrid")) {
    main.innerHTML = `<div class="panel glass lhead"><div class="row"><h2>Launch Feed</h2><span class="tag worth-tag">RESEARCH ONLY</span><span id="lstat"></span>
      <button class="btn small" id="lPause"></button></div>
     <div class="row lfilters"><input id="lq" type="search" placeholder="Keyword: name, ticker, CA or creator" value="${esc(F.q)}">
      <label><input id="lHide" type="checkbox" ${F.hideFlagged ? "checked" : ""}> Hide flagged</label>
      <label>Early buys ≥ <input id="lMinBuys" type="number" min="0" value="${F.minBuys}"></label><label>Quick ≥ <input id="lMinScore" type="number" min="0" max="100" value="${F.minScore}"></label>
      <label><input id="lSound" type="checkbox" ${F.sound ? "checked" : ""}> Sound</label><label><input id="lNotify" type="checkbox" ${F.notify ? "checked" : ""}> Notify</label></div>
     <small>Launches and graduations live from PumpPortal's websocket; early buys from GeckoTerminal (polled every 20 s for up to 30 watched coins, it indexes a new coin after ~30-60 s). Age = time since the stream delivered the launch. Quick score is a first-minute screen only; a coin moves to the Radar for full Heat/Risk once DexScreener or RugCheck has data. Sound/notify fire for launches that pass your filters (at least one filter must be set). <b>Research only, not financial advice.</b></small>
     <p class="mig" id="lmig"></p></div><div id="lgrid"></div>`;
    const bind = (id, k, f) => { const el = main.querySelector(id); el.oninput = el.onchange = () => { F[k] = f(el); H.save(); renderLaunch(main); }; };
    bind("#lq", "q", (e) => e.value); bind("#lHide", "hideFlagged", (e) => e.checked); bind("#lMinBuys", "minBuys", (e) => +e.value || 0); bind("#lMinScore", "minScore", (e) => +e.value || 0);
    bind("#lSound", "sound", (e) => { if (e.checked) beep(); return e.checked; });
    bind("#lNotify", "notify", (e) => { if (e.checked && "Notification" in window && Notification.permission !== "granted") Notification.requestPermission(); return e.checked; });
    main.querySelector("#lPause").onclick = () => { setPaused(!st.paused); renderLaunch(main); };
  }
  const list = [...launches.values()].reverse().filter((c) => passes(c, F));
  const rate = st.firstAt && launches.size > 1 ? (launches.size / Math.max(1, (Date.now() - st.firstAt) / 60e3)).toFixed(0) : "…";
  main.querySelector("#lPause").textContent = st.paused ? "▶ Resume" : "⏸ Pause";
  main.querySelector("#lstat").innerHTML = `<span class="pill ${st.status === "live" ? "ok" : st.paused ? "mid" : "bad"}">${esc(st.status)}</span> <small>${launches.size}/${L.maxCoins} kept · ~${rate}/min · ${subs.size}/${L.tradeSubCap} trades watched (GeckoTerminal ${esc(st.gt || "…")}) · ${list.length} match</small>`;
  main.querySelector("#lmig").innerHTML = migrations.length ? `<b>Graduations:</b> ${migrations.slice(0, 8).map((m) => `<a target="_blank" rel="noopener" href="https://dexscreener.com/solana/${esc(m.mint)}">${esc(m.symbol || short(m.mint))}</a> → ${esc(m.pool || "?")} ${secs(m.at)} ago`).join(" · ")}` : "";
  main.querySelector("#lgrid").innerHTML = list.length ? `<div class="grid">${list.slice(0, L.maxShown).map(lcard).join("")}</div>` : `<p class="empty">${st.paused ? "Stream paused." : launches.size ? "No launches match the filters yet." : "Waiting for the first launch…"}</p>`;
}
export function initLaunch(hooks) {
  H = hooks; connect();
  setInterval(() => pollTrades().catch((e) => console.warn("trades", e)), L.tradePollSec * 1000);
  setInterval(pruneSubs, 10e3);
  setInterval(() => promote().catch((e) => console.warn("promote", e)), L.promoteEverySec * 1000);
}
