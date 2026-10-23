import { CONFIG as C } from "./config.js";
import { heatScore, riskScore, isWorth } from "./score.js";
import * as A from "./api.js";
import { initBest, renderBest, bestNeedsLoad, loadBest, bestBusy } from "./best.js";
import { initLaunch, renderLaunch, launches } from "./launch.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const U = "unknown";
const usd = (v) => v === null || v === undefined || isNaN(v) ? U : v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + (+v).toFixed(v < 1 ? 2 : 0);
const price = (v) => v === null || v === undefined || isNaN(v) ? U : v >= 1 ? "$" + v.toFixed(4) : "$" + v.toPrecision(4);
const pct = (v, d = 1) => v === null || v === undefined || isNaN(v) ? U : (v > 0 ? "+" : "") + v.toFixed(d) + "%";
const nv = (v) => (v === null || v === undefined ? U : v);
const ago = (ms) => { if (!ms) return U; const m = (Date.now() - ms) / 60e3; return m < 60 ? Math.max(0, Math.round(m)) + "m" : m < 1440 ? (m / 60).toFixed(1) + "h" : (m / 1440).toFixed(1) + "d"; };
const fmtTime = (t) => new Date(t).toLocaleString("en-AU", { dateStyle: "short", timeStyle: "short" });

// ---------- storage: localStorage "cryptoscouter.v1" ----------
const S = Object.assign({ v: 1, watch: [], trades: [], alerted: {}, worth: { ...C.worth }, filters: { q: "", minHeat: 0, maxRisk: 100, minLiq: 0, maxAgeH: 0, worthOnly: false, sort: "heat" }, notify: false, launch: { q: "", hideFlagged: false, minBuys: 0, minScore: 0, sound: false, notify: false } }, (() => { try { return JSON.parse(localStorage.getItem(C.storageKey)) || {}; } catch { return {}; } })());
S.launch = Object.assign({ q: "", hideFlagged: false, minBuys: 0, minScore: 0, sound: false, notify: false }, S.launch);
const save = () => localStorage.setItem(C.storageKey, JSON.stringify(S));

// ---------- radar state ----------
const coins = new Map(); // mint -> coin
const rugCache = new Map(); // mint -> {report, hist:[{t,holders}]}
const promoted = new Map(); // mint -> time promoted from the Launch Feed (kept on the radar 30 min)
let lastRefresh = 0, tab = "radar", openMint = null, feed = null, refreshing = false;

function score(c) {
  const r = rugCache.get(c.mint);
  if (r?.report) Object.assign(c, r.report, { rug: true });
  if (r?.hist?.length >= 2) { const a = r.hist[0], b = r.hist[r.hist.length - 1]; if (b.t > a.t && a.holders !== null && b.holders !== null) c.holderGrowthPerMin = (b.holders - a.holders) / ((b.t - a.t) / 60e3); }
  c.ageMin = c.createdAt ? (Date.now() - c.createdAt) / 60e3 : null;
  c.heat = heatScore(c); c.risk = riskScore(c); c.worth = isWorth(c, S.worth);
}

async function refresh() {
  if (refreshing) return; refreshing = true; setStatus("Scanning…");
  try {
    const [profiles, boosts, gt] = await Promise.all([A.dsProfiles(), A.dsBoosts(), A.gtNewPools(2)]);
    const seeds = new Map();
    for (const x of [...gt, ...profiles]) if (!seeds.has(x.mint)) seeds.set(x.mint, x);
    for (const m of boosts.keys()) if (!seeds.has(m)) seeds.set(m, { mint: m, src: "boost" });
    const tracked = new Set([...promoted.keys()].filter((m) => Date.now() - promoted.get(m) < 30 * 60e3)); for (const m of [...S.watch, ...S.trades.filter(openTracking).map((t) => t.mint)]) tracked.add(m);
    const mints = [...new Set([...tracked, ...seeds.keys(), ...coins.keys()])].slice(0, 150);
    const pairs = await A.dsTokens(mints);
    for (const [m, p] of pairs) { const c = Object.assign(coins.get(m) || {}, A.pairToCoin(p)); c.boosts = boosts.get(m) ?? c.boosts ?? 0; c.src = c.src || seeds.get(m)?.src || "tracked"; c.seenAt = c.seenAt || Date.now(); coins.set(m, c); }
    for (const c of coins.values()) score(c);
    // prune: keep tracked + top newest/hottest
    const keep = [...coins.values()].sort((a, b) => b.heat.score - a.heat.score).slice(0, C.maxCoins).map((c) => c.mint);
    for (const m of [...coins.keys()]) if (!keep.includes(m) && !tracked.has(m)) coins.delete(m);
    // RugCheck: tracked first, then hottest without a fresh report
    const need = [...coins.values()].filter((c) => { const r = rugCache.get(c.mint); return !r || Date.now() - r.report.at > C.rugcheckTtlSec * 1000; })
      .sort((a, b) => (tracked.has(b.mint) - tracked.has(a.mint)) || b.heat.score - a.heat.score).slice(0, C.rugcheckPerCycle);
    for (let i = 0; i < need.length; i += 3) await Promise.all(need.slice(i, i + 3).map(async (c) => {
      const rep = await A.rugReport(c.mint); if (!rep) return;
      const r = rugCache.get(c.mint) || { hist: [] }; r.report = rep; r.hist.push({ t: rep.at, holders: rep.holders }); r.hist = r.hist.slice(-12); rugCache.set(c.mint, r);
    }));
    for (const c of coins.values()) score(c);
    lastRefresh = Date.now();
    trackTrades(); checkAlerts();
    setStatus(`Live · ${coins.size} coins · updated ${new Date().toLocaleTimeString("en-AU")}`);
  } catch (e) { console.warn(e); setStatus("Scan failed: " + e.message); }
  refreshing = false; render();
}

// ---------- alerts ----------
function checkAlerts() {
  for (const c of coins.values()) if (c.worth && !S.alerted[c.mint]) {
    S.alerted[c.mint] = Date.now();
    const msg = `${c.symbol || U}: Heat ${c.heat.score}, Risk ${c.risk.score} (${c.risk.grade}), liq ${usd(c.liq)}`;
    toast("⚡ Of worth: " + msg, () => openDrawer(c.mint));
    if (S.notify && "Notification" in window && Notification.permission === "granted") {
      navigator.serviceWorker?.getRegistration().then((r) => r ? r.showNotification("Of worth: " + (c.symbol || U), { body: msg + "\nResearch only, not financial advice.", icon: "icons/icon-192.png", tag: c.mint }) : new Notification("Of worth: " + (c.symbol || U), { body: msg }));
    }
  }
  const old = Date.now() - 86400e3; for (const k in S.alerted) if (S.alerted[k] < old) delete S.alerted[k];
  save();
}
function toast(text, onclick) {
  const t = document.createElement("div"); t.className = "toast glass"; t.textContent = text; t.onclick = () => { onclick && onclick(); t.remove(); };
  $("#toasts").prepend(t); setTimeout(() => t.remove(), 12000);
}

// ---------- trades: BEFORE / AFTER analytics ----------
function snap(c) {
  if (!c) return null;
  return { t: Date.now(), price: c.priceUsd ?? null, mcap: c.mcap ?? c.fdv ?? null, liq: c.liq ?? null, volH1: c.volH1 ?? null, volH24: c.volH24 ?? null, holders: c.holders ?? null,
    heat: c.heat?.score ?? null, risk: c.risk?.score ?? null, grade: c.risk?.grade ?? null, flags: (c.risk?.flags || []).map((f) => f.f) };
}
const openTracking = (t) => Date.now() - t.time < 7 * 86400e3 + C.snapshotGraceMs["+7d"] || !t.exit;
function dir(t) { return t.side === "sell" ? -1 : 1; }
function plOf(t, p) { if (p === null || p === undefined || !t.price) return { plPct: null, plUsd: null };
  const plPct = dir(t) * (p / t.price - 1) * 100; return { plPct, plUsd: t.amountUsd ? (t.amountUsd * plPct) / 100 : null }; }
function afterSnap(t, c) {
  const s = snap(c); if (!s) return null;
  Object.assign(s, plOf(t, s.price), { peak: t.peak ?? null, maxDD: t.maxDD ?? null,
    dHeat: s.heat !== null && t.before?.heat !== null ? s.heat - t.before.heat : null, dRisk: s.risk !== null && t.before?.risk !== null ? s.risk - t.before.risk : null,
    newFlags: s.flags.filter((f) => !(t.before?.flags || []).includes(f)) });
  return s;
}
function trackTrades() {
  let dirty = false;
  for (const t of S.trades) {
    const c = coins.get(t.mint); const age = Date.now() - t.time;
    if (c?.priceUsd && !t.exit && age < 7 * 86400e3 + C.snapshotGraceMs["+7d"]) { // observed peak / drawdown while the app is open
      t.peak = Math.max(t.peak ?? t.price, c.priceUsd); t.trough = Math.min(t.trough ?? t.price, c.priceUsd);
      const dd = (c.priceUsd / t.peak - 1) * 100; t.maxDD = Math.min(t.maxDD ?? 0, dd); dirty = true;
    }
    t.after = t.after || {};
    for (const s of C.snapshots) { if (t.after[s.k] || age < s.ms) continue;
      if (age > s.ms + C.snapshotGraceMs[s.k]) { t.after[s.k] = { missed: true, note: "missed (app closed)" }; dirty = true; }
      else if (c && lastRefresh > t.time + s.ms) { t.after[s.k] = afterSnap(t, c); dirty = true; } }
  }
  if (dirty) save();
}
function logTrade(f) {
  const c = coins.get(f.mint);
  const t = { id: "t" + Date.now().toString(36), mint: f.mint, symbol: c?.symbol || f.symbol || null, side: f.side, price: +f.price, amountUsd: f.amountUsd ? +f.amountUsd : null,
    time: f.time ? Date.parse(f.time) : Date.now(), note: f.note || "", source: f.source || "me", before: snap(c), after: {}, exit: null };
  if (!t.before) t.before = { missing: true, note: "coin not on the radar when logged: unknown" };
  // A sell closes this coin's open buys: freeze their EXIT snapshot at the sell price.
  if (t.side === "sell") for (const b of S.trades) if (b.mint === t.mint && b.side === "buy" && !b.exit) {
    const s = afterSnap(b, c) || { t: t.time, flags: [], newFlags: [] }; s.price = t.price; Object.assign(s, plOf(b, t.price)); s.exitTradeId = t.id; b.exit = s;
    if (t.time - Date.now() > -60e3) { /* live */ } }
  S.trades.push(t); if (!S.watch.includes(t.mint)) S.watch.push(t.mint); save(); render();
  toast(`Logged ${t.side} ${t.symbol || t.mint.slice(0, 6)} @ ${price(t.price)}: BEFORE snapshot frozen`);
}
function resultOf(t) { // exit if closed, else the latest after snapshot taken
  if (t.exit) return { ...t.exit, at: "exit" };
  for (const k of ["+7d", "+24h", "+1h", "+5m"]) if (t.after?.[k] && !t.after[k].missed) return { ...t.after[k], at: k };
  return null;
}

// ---------- rendering ----------
function setStatus(s) { $("#status").textContent = s; }
function heatCls(h) { return h >= 65 ? "hot" : h >= 40 ? "warm" : "cold"; }
function riskCls(r) { return r.grade === "A" ? "ok" : r.grade === "D" ? "bad" : "mid"; }
function filtered() {
  const F = S.filters; const q = F.q.trim().toLowerCase();
  let list = [...coins.values()].filter((c) => (!q || (c.symbol || "").toLowerCase().includes(q) || (c.name || "").toLowerCase().includes(q) || c.mint.toLowerCase() === q)
    && c.heat.score >= F.minHeat && c.risk.score <= F.maxRisk && (!F.minLiq || (c.liq ?? 0) >= F.minLiq) && (!F.maxAgeH || (c.ageMin !== null && c.ageMin <= F.maxAgeH * 60)) && (!F.worthOnly || c.worth));
  const k = { heat: (c) => -c.heat.score, risk: (c) => c.risk.score, age: (c) => c.ageMin ?? 1e9, liq: (c) => -(c.liq ?? 0), vol: (c) => -(c.volH1 ?? 0) }[F.sort];
  return list.sort((a, b) => k(a) - k(b));
}
function card(c) {
  return `<button class="coin glass ${c.worth ? "worth" : ""}" data-mint="${esc(c.mint)}">
   <div class="c-top">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph">${esc((c.symbol || "?")[0])}</div>`}
    <div class="c-name"><b>${esc(c.symbol || U)}</b><small>${esc(c.name || U)}</small></div>
    ${S.watch.includes(c.mint) ? '<span class="star">★</span>' : ""}${c.worth ? '<span class="tag worth-tag">OF WORTH</span>' : ""}</div>
   <div class="scores"><span class="pill ${heatCls(c.heat.score)}">Heat ${c.heat.score}</span><span class="pill ${riskCls(c.risk)}">Risk ${c.risk.score} · ${c.risk.grade}</span></div>
   <div class="kv"><span>Price</span><b>${price(c.priceUsd)}</b><span>MCap</span><b>${usd(c.mcap ?? c.fdv)}</b><span>Liq</span><b>${usd(c.liq)}</b><span>Vol 1h</span><b>${usd(c.volH1)}</b>
    <span>Age</span><b>${c.createdAt ? ago(c.createdAt) : U}</b><span>5m</span><b class="${(c.chgM5 ?? 0) >= 0 ? "up" : "dn"}">${pct(c.chgM5)}</b></div></button>`;
}
function render() {
  if (tab !== "launch" && $("#lgrid")) $("#main").innerHTML = "";
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#filters").hidden = !["radar", "watch"].includes(tab);
  const main = $("#main"); const worthN = [...coins.values()].filter((c) => c.worth).length; $("#worthN").textContent = worthN || "";
  if (tab === "radar" || tab === "watch") {
    let list = filtered(); if (tab === "watch") list = list.filter((c) => S.watch.includes(c.mint));
    main.innerHTML = list.length ? `<div class="grid">${list.map(card).join("")}</div>` : `<p class="empty">${coins.size ? "No coins match the filters." : "Scanning the trenches…"}${tab === "watch" && !S.watch.length ? " Star a coin in its drawer to watch it." : ""}</p>`;
  } else if (tab === "alerts") {
    const list = [...coins.values()].filter((c) => c.worth).sort((a, b) => b.heat.score - a.heat.score);
    main.innerHTML = `<div class="panel glass"><h2>“Of worth” alerts</h2><p>Heat ≥ <input id="wH" type="number" value="${S.worth.minHeat}" min="0" max="100"> and Risk ≤ <input id="wR" type="number" value="${S.worth.maxRisk}" min="0" max="100"> and liquidity ≥ $<input id="wL" type="number" value="${S.worth.minLiqUsd}" step="1000">, RugCheck data present, no mint/freeze authority.</p>
     <button class="btn" id="notif">${S.notify && Notification?.permission === "granted" ? "🔔 Browser notifications on" : "Enable browser notifications"}</button> <small>Alerts fire only while the app is open.</small></div>
     ${list.length ? `<div class="grid">${list.map(card).join("")}</div>` : '<p class="empty">No coin passes the alert bar right now.</p>'}`;
    for (const [id, k] of [["#wH", "minHeat"], ["#wR", "maxRisk"], ["#wL", "minLiqUsd"]]) $(id).onchange = (e) => { S.worth[k] = +e.target.value; for (const c of coins.values()) score(c); save(); render(); };
    $("#notif").onclick = async () => { if (!("Notification" in window)) return toast("This browser has no notifications."); const p = await Notification.requestPermission(); S.notify = p === "granted"; save(); render(); };
  } else if (tab === "best") { if (bestNeedsLoad()) loadBest(); renderBest(main); }
  else if (tab === "launch") { if (!main.querySelector("#lgrid")) main.innerHTML = ""; renderLaunch(main); }
  else if (tab === "argus" || tab === "hades") renderFeed(main);
  else if (tab === "analytics") renderAnalytics(main);
  if (openMint) renderDrawer();
}
function renderFeed(main) {
  if (feed === null) { main.innerHTML = '<p class="empty">Loading Argus × Hades feed…</p>'; return; }
  if (!feed) { main.innerHTML = `<div class="panel glass"><h2>${tab === "argus" ? "Argus" : "Hades"}</h2><p>The feed <a href="${C.feedUrl}" target="_blank" rel="noopener">${C.feedUrl}</a> is not reachable right now (${esc(A.apiStatus["Argus × Hades feed"]?.err || U)}). Nothing is shown rather than made up.</p></div>`; return; }
  if (tab === "argus") {
    const picks = feed.argus?.picks || [];
    main.innerHTML = `<div class="panel glass"><h2>Argus picks</h2><small>Feed updated ${esc(feed.updated_aest || U)}</small></div>` + (picks.length ? picks.map((p) => `<div class="panel glass pick"><b>${esc(p.symbol || U)}</b> <span class="tag">${esc(p.rank || U)}</span> <span class="pill">${p.score10 ?? U}/10</span> <span class="pill mid">risk ${esc(p.risk || U)}</span><small> ${esc(p.time_aest || "")}</small>
      <p>${esc(p.reason || "")}</p>${p.levels ? `<p><i>Levels:</i> ${esc(p.levels)}</p>` : ""}${p.safety ? `<p><i>Safety:</i> ${esc(p.safety)}</p>` : ""}
      ${p.ca ? `<button class="btn small" data-open="${esc(p.ca)}">Open in scouter</button> <button class="btn small" data-log="${esc(p.ca)}" data-src="Argus">Log trade (Argus pick)</button>` : ""}</div>`).join("") : '<p class="empty">No Argus picks in the feed.</p>');
  } else {
    const tr = (feed.trades || []).filter((t) => t.action !== "DEPOSIT");
    main.innerHTML = `<div class="panel glass"><h2>Hades trades</h2><small>${esc(feed.trades_source || "")} · ${tr.length} rows</small></div><div class="panel glass"><table><tr><th>Time</th><th>Action</th><th>Token</th><th>SOL</th><th>USD</th><th>Reason</th><th></th></tr>
     ${tr.slice().reverse().map((t) => `<tr><td>${esc(t.time_aest || U)}</td><td>${esc(t.action)}</td><td>${esc(t.token || U)}</td><td>${t.sol ?? U}</td><td>${t.usd_at_time ?? U}</td><td>${esc(t.reason || "")}</td><td>${t.mint ? `<button class="btn small" data-open="${esc(t.mint)}">Open</button>` : ""}</td></tr>`).join("")}</table></div>`;
  }
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function corr(xs, ys) { const n = xs.length; if (n < 3) return null; const mx = mean(xs), my = mean(ys); let a = 0, b = 0, c = 0; for (let i = 0; i < n; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; c += (ys[i] - my) ** 2; } return b && c ? a / Math.sqrt(b * c) : null; }
function predictor(rows, key, lowerBetter) {
  const r = rows.filter((x) => x.t.before?.[key] !== null && x.t.before?.[key] !== undefined);
  if (r.length < 2) return `<p><b>${key === "heat" ? "Heat" : "Risk"}:</b> not enough trades with a result yet (${r.length}).</p>`;
  const med = [...r.map((x) => x.t.before[key])].sort((a, b) => a - b)[Math.floor(r.length / 2)];
  const hi = r.filter((x) => x.t.before[key] >= med).map((x) => x.res.plPct), lo = r.filter((x) => x.t.before[key] < med).map((x) => x.res.plPct);
  const k = corr(r.map((x) => x.t.before[key]), r.map((x) => x.res.plPct));
  const good = lowerBetter ? (mean(lo) ?? -1e9) > (mean(hi) ?? -1e9) : (mean(hi) ?? -1e9) > (mean(lo) ?? -1e9);
  return `<p><b>${key === "heat" ? "Heat" : "Risk"}</b> (median split at ${med}): ≥${med} avg ${pct(mean(hi))} (${hi.length}) vs &lt;${med} avg ${pct(mean(lo))} (${lo.length}); correlation ${k === null ? "n/a (<3 trades)" : k.toFixed(2)}.
   ${lo.length && hi.length ? (good ? `→ ${lowerBetter ? "Lower Risk" : "Higher Heat"} <b class="up">did</b> predict better results so far.` : `→ ${lowerBetter ? "Lower Risk" : "Higher Heat"} <b class="dn">did not</b> predict better results so far.`) : ""}</p>`;
}
function snapCell(s, label) {
  if (!s) return `<td><small>${label}</small><br>pending</td>`;
  if (s.missed) return `<td class="missed"><small>${label}</small><br>missed (app closed)</td>`;
  return `<td><small>${label}</small><br>${price(s.price)}<br><b class="${(s.plPct ?? 0) >= 0 ? "up" : "dn"}">${pct(s.plPct)}</b> ${s.plUsd !== null && s.plUsd !== undefined ? (s.plUsd >= 0 ? "+" : "-") + "$" + Math.abs(s.plUsd).toFixed(2) : ""}<br>
   Heat ${nv(s.heat)}${s.dHeat !== null && s.dHeat !== undefined ? ` (${s.dHeat >= 0 ? "+" : ""}${s.dHeat})` : ""} · Risk ${nv(s.risk)}${s.dRisk !== null && s.dRisk !== undefined ? ` (${s.dRisk >= 0 ? "+" : ""}${s.dRisk})` : ""}<br>
   peak ${price(s.peak)} · maxDD ${pct(s.maxDD)}${s.newFlags?.length ? `<br><span class="dn">New flags: ${esc(s.newFlags.join("; "))}</span>` : ""}</td>`;
}
function renderAnalytics(main) {
  const rows = S.trades.map((t) => ({ t, res: resultOf(t) })).filter((x) => x.res && x.res.plPct !== null);
  const stat = (rs) => rs.length ? `${rs.length} with a result · win rate ${((rs.filter((x) => x.res.plPct > 0).length / rs.length) * 100).toFixed(0)}% · avg P/L ${pct(mean(rs.map((x) => x.res.plPct)))}` : "no results yet";
  const mine = rows.filter((x) => x.t.source === "me"), bots = rows.filter((x) => x.t.source !== "me");
  main.innerHTML = `<div class="panel glass"><h2>Trade analytics: before vs after</h2>
   <p><b>All:</b> ${S.trades.length} logged · ${stat(rows)}</p><p><b>My own trades:</b> ${stat(mine)}</p><p><b>From Ares / Argus / Hades picks:</b> ${stat(bots)}
   ${["Ares", "Argus", "Hades"].map((s) => { const r = bots.filter((x) => x.t.source === s); return r.length ? `<br>· ${s}: ${stat(r)}` : ""; }).join("")}</p>
   ${predictor(rows, "heat", false)}${predictor(rows, "risk", true)}
   <p><small>Result = exit P/L if closed, else the latest after snapshot. Snapshots are only taken while the app is open; peak and drawdown are what the app saw while open.</small></p>
   <button class="btn" id="csv">Export CSV</button> <button class="btn" id="newTrade">+ Log trade</button></div>
   ${S.trades.slice().reverse().map((t) => { const b = t.before || {}; return `<div class="panel glass tcard"><div><b>${t.side.toUpperCase()} ${esc(t.symbol || t.mint.slice(0, 6) + "…")}</b> @ ${price(t.price)} ${t.amountUsd ? "· $" + t.amountUsd : ""} · ${fmtTime(t.time)} · <span class="tag">${esc(t.source)}</span> ${t.exit ? '<span class="tag">closed</span>' : ""}
    <button class="btn small" data-open="${esc(t.mint)}">Open</button> <button class="btn small" data-del="${t.id}">Delete</button>${t.note ? `<p><i>${esc(t.note)}</i></p>` : ""}</div>
    <div class="scroll"><table><tr><td><small>BEFORE</small><br>${b.missing ? "unknown (not on radar)" : `${price(b.price)}<br>MCap ${usd(b.mcap)} · Liq ${usd(b.liq)}<br>Vol1h ${usd(b.volH1)} · Holders ${nv(b.holders)}<br>Heat ${nv(b.heat)} · Risk ${nv(b.risk)} ${b.grade || ""}<br><small>${esc((b.flags || []).join("; ") || "no flags")}</small>`}</td>
    ${C.snapshots.map((s) => snapCell(t.after?.[s.k], s.k)).join("")}${snapCell(t.exit, "EXIT")}</tr></table></div></div>`; }).join("")}`;
  $("#csv").onclick = exportCsv; $("#newTrade").onclick = () => tradeForm();
}
function exportCsv() {
  const cols = ["id", "source", "side", "symbol", "mint", "time", "price", "amountUsd", "note", "before_price", "before_mcap", "before_liq", "before_volH1", "before_holders", "before_heat", "before_risk", "before_flags"];
  const sk = [...C.snapshots.map((s) => s.k), "exit"]; for (const k of sk) cols.push(...["price", "plPct", "plUsd", "peak", "maxDD", "heat", "risk", "newFlags"].map((f) => `${k}_${f}`));
  const q = (v) => { const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(",")];
  for (const t of S.trades) { const b = t.before || {}; const r = [t.id, t.source, t.side, t.symbol, t.mint, new Date(t.time).toISOString(), t.price, t.amountUsd, t.note, b.price, b.mcap, b.liq, b.volH1, b.holders, b.heat, b.risk, b.flags];
    for (const k of sk) { const s = k === "exit" ? t.exit : t.after?.[k]; if (s?.missed) r.push("missed (app closed)", "", "", "", "", "", "", ""); else r.push(...["price", "plPct", "plUsd", "peak", "maxDD", "heat", "risk", "newFlags"].map((f) => s?.[f])); }
    lines.push(r.map(q).join(",")); }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })); a.download = `crypto-scouter-trades-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
}
function tradeForm(mint = openMint, source = "me") {
  const c = coins.get(mint); const d = $("#modal");
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  d.innerHTML = `<form method="dialog" class="glass form" id="tf"><h3>Log trade</h3>
   <label>Coin CA<input name="mint" required value="${esc(mint || "")}" placeholder="Solana mint"></label>
   <label>Side<select name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
   <label>Entry price (USD)<input name="price" required type="number" step="any" value="${c?.priceUsd ?? ""}"></label>
   <label>Amount (USD)<input name="amountUsd" type="number" step="any" placeholder="optional, for $ P/L"></label>
   <label>Time<input name="time" type="datetime-local" value="${local}"></label>
   <label>Source<select name="source">${["me", "Ares", "Argus", "Hades"].map((s) => `<option ${s === source ? "selected" : ""} value="${s}">${s === "me" ? "My own trade" : s + " pick"}</option>`).join("")}</select></label>
   <label>Note<input name="note" placeholder="optional"></label>
   <p><small>The BEFORE snapshot is frozen from what the scanner shows right now${c ? "" : " (this coin is not on the radar yet, so it will read unknown)"}.</small></p>
   <div class="row"><button class="btn primary" value="ok">Log trade</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div></form>`;
  d.showModal();
  $("#tf").onsubmit = (e) => { if (e.submitter?.value !== "ok") return; const f = Object.fromEntries(new FormData(e.target)); f.mint = f.mint.trim(); logTrade(f); };
}

// ---------- drawer ----------
async function openDrawer(mint) {
  openMint = mint; $("#drawer").classList.add("open"); renderDrawer();
  if (!coins.has(mint)) { const p = await A.dsTokens([mint]); if (p.get(mint)) { const c = A.pairToCoin(p.get(mint)); c.boosts = 0; coins.set(mint, c); score(c); renderDrawer(); } }
  const c = coins.get(mint); if (!c) return;
  if (!rugCache.has(mint)) A.rugReport(mint).then((rep) => { if (rep) { rugCache.set(mint, { report: rep, hist: [{ t: rep.at, holders: rep.holders }] }); score(c); renderDrawer(); } });
  const bars = c.pair ? await A.ohlcv(c.pair) : []; if (openMint === mint) drawChart(bars);
}
function renderDrawer() {
  const c = coins.get(openMint); const d = $("#drawerBody");
  if (!c) { d.innerHTML = `<p class="empty">Loading ${esc(openMint)}… (no DexScreener pair yet = unknown)</p>`; return; }
  const h = c.heat.parts;
  d.innerHTML = `<div class="c-top big">${c.image ? `<img src="${esc(c.image)}" alt="" referrerpolicy="no-referrer">` : ""}<div class="c-name"><b>${esc(c.symbol || U)}</b><small>${esc(c.name || U)} · ${esc(c.dex || U)}</small></div></div>
   <div class="scores"><span class="pill ${heatCls(c.heat.score)}">Heat ${c.heat.score}</span><span class="pill ${riskCls(c.risk)}">Risk ${c.risk.score} · grade ${c.risk.grade}</span>${c.worth ? '<span class="tag worth-tag">OF WORTH</span>' : ""}</div>
   <div class="ca"><code>${esc(c.mint)}</code><button class="btn small" id="copy">Copy CA</button></div>
   <div class="row"><a class="btn small" target="_blank" rel="noopener" href="${esc(c.dsUrl)}">DexScreener</a><a class="btn small" target="_blank" rel="noopener" href="https://solscan.io/token/${esc(c.mint)}">Solscan</a>
    <button class="btn small" id="star">${S.watch.includes(c.mint) ? "★ Watching" : "☆ Watch"}</button><button class="btn small primary" id="logT">Log trade</button></div>
   <canvas id="chart" width="640" height="220"></canvas><small id="chartNote">Loading 5-minute chart (GeckoTerminal)…</small>
   <div class="kv wide"><span>Price</span><b>${price(c.priceUsd)}</b><span>Market cap</span><b>${usd(c.mcap ?? c.fdv)}</b><span>Liquidity</span><b>${usd(c.liq)}</b>
    <span>Vol 5m / 1h / 24h</span><b>${usd(c.volM5)} / ${usd(c.volH1)} / ${usd(c.volH24)}</b><span>Buys/Sells 5m</span><b>${nv(c.buysM5)} / ${nv(c.sellsM5)}</b><span>Buys/Sells 1h</span><b>${nv(c.buysH1)} / ${nv(c.sellsH1)}</b>
    <span>Change 5m / 1h / 24h</span><b>${pct(c.chgM5)} / ${pct(c.chgH1)} / ${pct(c.chgH24)}</b><span>Age</span><b>${c.createdAt ? ago(c.createdAt) : U}</b><span>Holders</span><b>${nv(c.holders)}</b>
    <span>Holder growth</span><b>${c.holderGrowthPerMin !== undefined && c.holderGrowthPerMin !== null ? c.holderGrowthPerMin.toFixed(1) + "/min" : U}</b>
    <span>Mint authority</span><b>${c.rug ? (c.mintAuthority ? "ENABLED" : "none") : U}</b><span>Freeze authority</span><b>${c.rug ? (c.freezeAuthority ? "ENABLED" : "none") : U}</b>
    <span>LP locked/burned</span><b>${c.lpLockedPct !== null && c.lpLockedPct !== undefined ? c.lpLockedPct.toFixed(0) + "%" : U}</b><span>Top-10 holders</span><b>${c.top10Pct !== null && c.top10Pct !== undefined ? c.top10Pct.toFixed(1) + "% (pools excluded)" : U}</b>
    <span>Paid boosts</span><b>${nv(c.boosts)}</b><span>RugCheck</span><b>${c.rug ? `${c.rugScore ?? U}/100${c.rugged ? " · RUGGED" : ""}` : U}</b></div>
   <h4>Heat breakdown</h4><p class="mono">volume ${h.volume.toFixed(1)}/25 · buys ${h.buys.toFixed(1)}/25 · liquidity ${h.liquidity.toFixed(1)}/20 · age ${h.age.toFixed(1)}/15 · holders ${h.holders.toFixed(1)}/15</p>
   <h4>Risk flags</h4><ul class="flags">${c.risk.flags.map((f) => `<li class="${f.sev}">+${f.p} ${esc(f.f)}</li>`).join("") || "<li>none</li>"}</ul>
   ${c.rugRisks?.length ? `<p><small>RugCheck says: ${esc(c.rugRisks.join(", "))}</small></p>` : ""}
   ${c.socials?.length ? `<p>${c.socials.map((s) => `<a target="_blank" rel="noopener" href="${esc(s.url)}">${esc(s.type || "link")}</a>`).join(" · ")}</p>` : ""}
   <p class="disclaimer">Research only, not financial advice.</p>`;
  $("#copy").onclick = async () => { try { await navigator.clipboard.writeText(c.mint); toast("CA copied"); } catch { toast("Copy blocked: select the CA and copy it"); } };
  $("#star").onclick = () => { S.watch = S.watch.includes(c.mint) ? S.watch.filter((m) => m !== c.mint) : [...S.watch, c.mint]; save(); render(); };
  $("#logT").onclick = () => tradeForm(c.mint);
}
function drawChart(bars) {
  const cv = $("#chart"); if (!cv) return; const x = cv.getContext("2d"); const W = cv.width, H = cv.height; x.clearRect(0, 0, W, H);
  if (!bars.length) { $("#chartNote").textContent = "Chart unknown (GeckoTerminal returned no candles)."; return; }
  const lo = Math.min(...bars.map((b) => b.l)), hi = Math.max(...bars.map((b) => b.h)); const y = (v) => H - 10 - ((v - lo) / (hi - lo || 1)) * (H - 20); const w = W / bars.length;
  x.strokeStyle = "rgba(140,200,255,.12)"; for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(0, (H * i) / 4); x.lineTo(W, (H * i) / 4); x.stroke(); }
  bars.forEach((b, i) => { const up = b.c >= b.o; x.strokeStyle = x.fillStyle = up ? "#3dffa8" : "#ff5470"; const cx = i * w + w / 2;
    x.beginPath(); x.moveTo(cx, y(b.h)); x.lineTo(cx, y(b.l)); x.stroke(); x.fillRect(i * w + 1, Math.min(y(b.o), y(b.c)), Math.max(1, w - 2), Math.max(1, Math.abs(y(b.o) - y(b.c)))); });
  for (const t of S.trades.filter((t) => t.mint === openMint)) { const i = bars.findIndex((b) => b.t >= t.time); if (i < 0) continue; x.fillStyle = t.side === "buy" ? "#6fe8ff" : "#ffb030"; x.beginPath(); x.arc(i * w + w / 2, y(t.price), 5, 0, 7); x.fill(); }
  $("#chartNote").textContent = `5-minute candles, ${bars.length} bars, GeckoTerminal · high ${price(hi)} low ${price(lo)}`;
}

// ---------- wiring ----------
document.querySelector("nav").onclick = async (e) => { const b = e.target.closest("button[data-tab]"); if (!b) return; tab = b.dataset.tab;
  if ((tab === "argus" || tab === "hades") && !feed) { render(); feed = (await A.argusFeed()) || false; } render(); };
$("#main").onclick = (e) => { const cp = e.target.closest("[data-copy]"); if (cp) { navigator.clipboard.writeText(cp.dataset.copy).then(() => toast("CA copied"), () => toast("Copy blocked: " + cp.dataset.copy)); return; } const c = e.target.closest("[data-mint]"); if (c) return openDrawer(c.dataset.mint);
  const o = e.target.closest("[data-open]"); if (o) return openDrawer(o.dataset.open);
  const l = e.target.closest("[data-log]"); if (l) return tradeForm(l.dataset.log, l.dataset.src);
  const d = e.target.closest("[data-del]"); if (d && confirm("Delete this logged trade?")) { S.trades = S.trades.filter((t) => t.id !== d.dataset.del); save(); render(); } };
$("#closeDrawer").onclick = () => { openMint = null; $("#drawer").classList.remove("open"); };
const F = S.filters; for (const k of Object.keys(F)) { const el = $("#f-" + k); if (!el) continue; if (el.type === "checkbox") el.checked = F[k]; else el.value = F[k];
  el.oninput = () => { F[k] = el.type === "checkbox" ? el.checked : el.type === "number" || el.type === "range" ? +el.value : el.value; save(); render(); }; }
$("#refresh").onclick = () => refresh();
function tick() { const left = Math.max(0, C.refreshSec - Math.round((Date.now() - lastRefresh) / 1000)); $("#count").textContent = refreshing ? "…" : left + "s"; if (left === 0 && !refreshing && !document.hidden) refresh(); }
setInterval(tick, 1000);
setInterval(() => { if (tab === "analytics") render(); }, 60e3);
trackTrades(); render(); refresh();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
initBest({ rerender: () => { if (tab === "best") renderBest($("#main")); } });
initLaunch({ toast, gtBusy: () => bestBusy() || refreshing, prefs: () => S.launch, save, rerender: () => { if (tab === "launch") renderLaunch($("#main")); },
  addToRadar: (l, pair, rep) => { const c = Object.assign(coins.get(l.mint) || {}, pair ? A.pairToCoin(pair) : { mint: l.mint, symbol: l.symbol, name: l.name, image: l.image || null, createdAt: l.seenAt, dsUrl: `https://dexscreener.com/solana/${l.mint}`, socials: l.socials || [] });
    c.boosts = c.boosts ?? 0; c.src = "launch"; c.seenAt = c.seenAt || Date.now(); coins.set(l.mint, c); promoted.set(l.mint, Date.now());
    if (rep) rugCache.set(l.mint, { report: rep, hist: [{ t: rep.at, holders: rep.holders }] }); score(c); if (tab !== "launch") render(); } });
setInterval(() => { if (tab === "launch" && !document.hidden) renderLaunch($("#main")); }, 1000);
window.__scouter = { launches, coins, S, apiStatus: A.apiStatus };
