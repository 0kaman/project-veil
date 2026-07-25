// Replay vs the click it replaces. Run: node packages/core/bench/replay-benchmark.mjs
// (needs `pnpm build` first). Local fixture — a trivial server, so this is a
// FLOOR on the dispatch+settle+rebuild a click pays, not a real-world figure.
// The number quoted in ARCHITECTURE.md comes from here.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { SessionPool } from "../dist/index.js";

let currentToken = "";
const consumed = new Set();
const posts = [];            // every POST the server actually saw, in order
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "POST" && url.startsWith("/api/cart")) {
    let b = ""; req.on("data", c => b += c);
    req.on("end", () => {
      let tok = "", qty; try { const j = JSON.parse(b); tok = j.csrf_token ?? ""; qty = j.qty; } catch {}
      const bad = !tok || tok !== currentToken || consumed.has(tok);
      posts.push({ tok: tok.slice(0,6), qty, verdict: bad ? 403 : 200,
                   why: !tok ? "none" : consumed.has(tok) ? "spent" : tok !== currentToken ? "stale" : "ok" });
      if (bad) { res.writeHead(403, {"content-type":"application/json"});
                 return res.end(JSON.stringify({ok:false})); }
      consumed.add(tok);
      currentToken = randomBytes(8).toString("hex");
      res.writeHead(200, {"content-type":"application/json"});
      res.end(JSON.stringify({ok:true, nextToken: currentToken}));
    });
    return;
  }
  if (url.startsWith("/favicon") || /\.(ico|png|css|js|map)$/.test(url)) { res.writeHead(404); return res.end(); }
  currentToken = randomBytes(8).toString("hex");
  res.writeHead(200, {"content-type":"text/html"});
  res.end(`<!doctype html><html><head><title>Shop</title>
    <meta name="csrf-token" content="${currentToken}"></head><body>
    <input type="hidden" name="csrf_token" value="${currentToken}">
    <button id="add" aria-label="Add to cart">Add to cart</button>
    <script>document.getElementById('add').addEventListener('click',function(){
      fetch('/api/cart',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({sku:'A1',qty:1,csrf_token:document.querySelector('meta[name=csrf-token]').content})})
      .then(r=>r.json()).then(j=>{ if(j.nextToken){
        document.querySelector('meta[name=csrf-token]').content=j.nextToken;
        document.querySelector('input[name=csrf_token]').value=j.nextToken; }});
    });</script></body></html>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const clicks = [], reps = [];
for (let i = 0; i < 5; i++) {                       // FRESH session each time:
  const pool = new SessionPool({ capMs: 4000, config: { replay: "all" } });
  const open = await pool.open(`${base}/shop`);      // one honest act+replay pair
  const a = await pool.act(open.sessionId, "button-add-to-cart", { kind: "click" });
  const r = await pool.replay(open.sessionId, "button-add-to-cart");
  clicks.push(a.ms); reps.push(r.ms);
  if (r.response?.status !== 200) console.log("  !! replay not 200:", r.response?.status, r.refusal);
  await pool.shutdown();
}
const med = a => a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
console.log("\n  click  ms:", clicks.join(", "), "→ median", med(clicks));
console.log("  replay ms:", reps.join(", "), "→ median", med(reps));
console.log(`  → ${(med(clicks)/med(reps)).toFixed(0)}x  (localhost fixture, one act+replay per fresh session)`);
server.close();
