import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeProfileFixture } from "./profiles.mjs";
import { formulaAddAction, addRowsAction, addColumnsAction, importFixture } from "./scenarios.mjs";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function exists(p){ try{ await access(p); return true;}catch{return false;}}
async function startServer(port=4185){
  const distIndex = path.join(ROOT, "dist", "client", "index.html");
  const mode = (await exists(distIndex)) ? "preview" : "dev";
  const cmd = mode==="preview"?"npx.cmd":"npm.cmd";
  const args = mode==="preview"? ["vite","preview","--host","127.0.0.1","--port",String(port),"--strictPort"]: ["run","dev","--","--host","127.0.0.1","--port",String(port),"--strictPort"];
  console.log(`starting ${mode} on ${port}...`);
  const child = spawn(cmd, args, { cwd: ROOT, stdio:["ignore","pipe","pipe"], shell:true });
  child.stderr.on("data", d=>process.stdout.write(`[server] ${String(d).trim()}\n`));
  const baseUrl=`http://127.0.0.1:${port}`;
  for(let i=0;i<90;i++){
    try{ const r=await fetch(baseUrl); if(r.ok) return {child, baseUrl}; }catch{}
    await new Promise(r=>setTimeout(r,1000));
    if(child.exitCode!=null) throw new Error(`server died ${child.exitCode}`);
  }
  throw new Error("server not ready");
}
async function loadPlaywright(){
  for(const pkg of ["playwright","@playwright/test"]){ try{ const m=await import(pkg); if(m.chromium) return m; }catch{} }
  throw new Error("playwright missing");
}
import { createMeasurementInitScript } from "../../tests/performance/measurement.mjs";

const fixture = await writeProfileFixture("low", path.join(ROOT,"benchmarks/.generated/tactile-low-suite"));
console.log(`low fixture ${fixture.fingerprint.slice(0,12)} ${JSON.stringify(fixture.validation.counts)} path=${fixture.path}`);

const server = await startServer(4185);
const pw = await loadPlaywright();
const browser = await pw.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:1 });
await ctx.addInitScript({ content: createMeasurementInitScript() });
const page = await ctx.newPage();
await page.goto(`${server.baseUrl}/?perf=${Date.now()}`, { waitUntil:"domcontentloaded", timeout:120_000 });
console.log("page loaded");

console.log("importing low...");
await importFixture(page, fixture.path, "low");
console.log("import done, diagnosing DOM before scenarios...");
const diag = await page.evaluate(() => {
  const allCells = [...document.querySelectorAll('[data-object-id="low-root-sheet"]')].map(e=> e.getAttribute("data-cell-address"));
  const uniq = [...new Set(allCells)].sort();
  const m9 = document.querySelector('[data-object-id="low-root-sheet"][data-cell-address="M9"]');
  const b3 = document.querySelector('[data-object-id="low-root-sheet"][data-cell-address="B3"]');
  const c2 = document.querySelector('[data-object-id="low-root-sheet"][data-cell-address="C2"]');
  const a1 = document.querySelector('[data-object-id="low-root-sheet"][data-cell-address="A1"]');
  const virtual = [...document.querySelectorAll("[data-virtual-cell-address]")].map(e=> e.getAttribute("data-virtual-cell-address"));
  const scroller = document.querySelector("[data-sheet-scroll]");
  const scrollers = [...document.querySelectorAll("[data-sheet-scroll]")].map(s=> ({w:s.clientWidth,h:s.clientHeight, sw:s.scrollWidth, sh:s.scrollHeight, sl:s.scrollLeft, st:s.scrollTop}));
  return { countAll: document.querySelectorAll("[data-object-id]").length, countForRoot: allCells.length, uniqSample: uniq.slice(0,40), hasM9: !!m9, hasB3: !!b3, hasC2: !!c2, hasA1: !!a1, uniqHasB3: uniq.includes("B3"), uniqHasC2: uniq.includes("C2"), uniqHasM9: uniq.includes("M9"), scroller: scroller? {scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop, clientWidth: scroller.clientWidth, clientHeight: scroller.clientHeight, scrollWidth: scroller.scrollWidth, scrollHeight: scroller.scrollHeight } : null, allScrollers: scrollers };
});
console.log("DIAG", JSON.stringify(diag, null, 2));
await page.waitForTimeout(800);
const diag2 = await page.evaluate(() => {
  const allCells = [...document.querySelectorAll('[data-object-id="low-root-sheet"]')].map(e=> e.getAttribute("data-cell-address"));
  const uniq = [...new Set(allCells)].sort();
  return { count: allCells.length, hasB3: !!document.querySelector('[data-object-id="low-root-sheet"][data-cell-address="B3"]'), uniq: uniq.slice(0,20), hasM9: uniq.includes("M9") };
});
console.log("DIAG2 after 800ms", JSON.stringify(diag2, null, 2));
console.log("running 3 scenarios x1...");

// Temporarily patch x1 by calling insert once directly
import * as scen from "./scenarios.mjs";
for(const [name, fn] of [["formula-add", (p)=>scen.formulaAddAction(p,"low")],["add-row",(p)=>scen.addRowsAction(p,"low",1)],["add-column",(p)=>scen.addColumnsAction(p,"low",1)]]){
  console.log(`\n--- ${name} ---`);
  const t0=Date.now();
  try{
    const res = await fn(page);
    const dt = Date.now()-t0;
    console.log(`OK ${name} in ${dt}ms`, JSON.stringify(res).slice(0,500));
  }catch(e){
    const dt=Date.now()-t0;
    console.log(`FAIL ${name} after ${dt}ms: ${e.message}`);
    console.log(e.stack?.split("\n").slice(0,6).join("\n"));
  }
  await page.waitForTimeout(400);
}

await ctx.close(); await browser.close(); server.child.kill("SIGTERM");
console.log("done");
