/**
 * Direct-API replay vs simulated interaction — reproducible benchmark.
 *
 *   pnpm --filter @veil/core build   # dist must exist
 *   node packages/core/bench/replay-benchmark.mjs            # instant API
 *   API_DELAY=200 node packages/core/bench/replay-benchmark.mjs  # 200ms API
 *
 * Serves the commerce fixture + an echoing /api endpoint (optional artificial
 * latency), teaches the add-to-cart request once, then times N simulated clicks
 * vs N direct replays (each with an edited field).
 */
import { Veil } from "../dist/index.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../integration/fixtures/commerce.html");
const API_DELAY = Number(process.env.API_DELAY || 0);
const REPS = Number(process.env.REPS || 12);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/api/")) {
    let b = ""; for await (const c of req) b += c;
    if (API_DELAY) await new Promise((r) => setTimeout(r, API_DELAY));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, received: b }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(await readFile(FIXTURE, "utf8"));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const veil = new Veil();
const page = await veil.open(base + "/commerce");
await page.getGraph();
const cart = [...(await page.getGraph()).nodes.values()].find((n) => /add to cart/i.test(n.name));
await page.interact(cart.id, { action: "click" }); // teach the request

const sim = [], dir = [];
for (let i = 0; i < REPS; i++) { const t = Date.now(); await page.interact(cart.id, { action: "click" }); sim.push(Date.now() - t); }
for (let i = 0; i < REPS; i++) { const t = Date.now(); await page.replay(cart.id, { body: { qty: i } }); dir.push(Date.now() - t); }

const sm = median(sim), dm = median(dir);
console.log(`\nAPI_DELAY=${API_DELAY}ms  reps=${REPS}  (median)`);
console.log(`  simulated interaction : ${sm} ms/action`);
console.log(`  direct-API replay     : ${dm} ms/action`);
console.log(`  delta                 : ${sm - dm} ms/action saved  (${(sm / dm).toFixed(1)}x)`);
console.log(`  batch of 50 (est)     : simulated ${(sm * 50 / 1000).toFixed(1)}s  vs  direct ${(dm * 50 / 1000).toFixed(1)}s`);

page.close(); await veil.close(); server.close();
process.exit(0);
