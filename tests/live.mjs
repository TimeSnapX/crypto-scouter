// node tests/live.mjs <url> [screenshot]  (playwright-core from /workspace/tools)
import { createRequire } from "node:module";
const { chromium } = createRequire("/workspace/tools/package.json")("playwright-core");
const url = process.argv[2], shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } }); const errs = [];
p.on("pageerror", (e) => errs.push("pageerror " + e.message)); p.on("console", (m) => m.type() === "error" && errs.push("console " + m.text()));
await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForFunction(() => window.__scouter && window.__scouter.coins.size > 0 && !/Scanning/.test(document.querySelector("#status").textContent), null, { timeout: 90000 });
await p.waitForTimeout(3000);
const info = await p.evaluate(() => ({ status: document.querySelector("#status").textContent, coins: window.__scouter.coins.size, cards: document.querySelectorAll(".coin").length,
  worth: [...window.__scouter.coins.values()].filter((c) => c.worth).map((c) => `${c.symbol} H${c.heat.score} R${c.risk.score}`), rugchecked: [...window.__scouter.coins.values()].filter((c) => c.rug).length,
  apis: window.__scouter.apiStatus, sample: [...window.__scouter.coins.values()].slice(0, 3).map((c) => `${c.symbol} ${c.priceUsd} liq ${c.liq} H${c.heat.score} R${c.risk.score}`) }));
if (shot) await p.screenshot({ path: shot });
// drawer + log trade + analytics
await p.click(".coin"); await p.waitForTimeout(4000);
const chart = await p.textContent("#chartNote");
await p.click("#logT"); await p.fill("#tf [name=amountUsd]", "50"); await p.click("#tf button[value=ok]"); await p.click("#closeDrawer");
await p.click("nav [data-tab=analytics]"); await p.waitForTimeout(500);
const an = await p.evaluate(() => ({ txt: document.querySelector("#main").innerText.slice(0, 400), store: JSON.parse(localStorage.getItem("cryptoscouter.v1")).trades[0].before }));
for (const t of ["argus", "hades"]) { await p.click(`nav [data-tab=${t}]`); await p.waitForTimeout(3000); info[t] = (await p.textContent("#main")).slice(0, 160); }
console.log(JSON.stringify({ ...info, chart, analytics: an, errors: errs }, null, 1));
await b.close();
