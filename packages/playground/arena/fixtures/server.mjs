/**
 * Arena fixtures — deterministic pages both contenders drive.
 *
 * Real sites make a bad benchmark: they change under you, rate-limit, and
 * fingerprint. Every browser-required task therefore runs against THESE pages,
 * served to both contenders from the same container, so a difference in the
 * result is a difference in the tool rather than in the weather.
 *
 * Each page targets one capability, and two of them target things Veil is known
 * to be BAD at. A suite that excludes its own failures proves nothing.
 */
import { createServer } from "node:http";

const page = (title, body) => `<!doctype html><html><head><title>${title}</title>
<meta name="viewport" content="width=device-width"></head><body>${body}</body></html>`;

/** 1. A plain form. Baseline: can it fill fields and submit? */
const FORM = page(
  "Order form",
  `<h1>Place an order</h1>
   <form action="/ordered" method="GET">
     <label for="cust">Customer name</label><input id="cust" name="cust" aria-label="Customer name">
     <label for="qty">Quantity</label><input id="qty" name="qty" aria-label="Quantity">
     <select id="size" name="size" aria-label="Size">
       <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
     </select>
     <button type="submit" aria-label="Place order">Place order</button>
   </form>`,
);

/** 2. Content that exists only after JS runs — the js-shell case. */
const SPA = page(
  "Catalogue",
  `<div id="root">Loading…</div>
   <script>
     setTimeout(function(){
       document.getElementById('root').innerHTML =
         '<h1>Catalogue</h1><table><tr><th>Item</th><th>Stock</th><th>Price</th></tr>' +
         '<tr><td>Widget</td><td>17</td><td>499</td></tr>' +
         '<tr><td>Sprocket</td><td>3</td><td>1250</td></tr>' +
         '<tr><td>Flange</td><td>0</td><td>75</td></tr></table>';
     }, 600);
   </script>`,
);

/** 3. A search box with NO submit button — Enter is the only way in. */
const SEARCH = page(
  "Directory",
  `<h1>Staff directory</h1>
   <form action="/found" method="GET"><input name="q" aria-label="Search staff"></form>`,
);

/** 4. Results reachable only by driving the form, and expressed as a TABLE —
 * the shape that defeated prose extraction on a real booking site.
 *
 * REVISED 2026-08-01, and the revision is the whole point. The first cut
 * IGNORED `q` and returned all three rows for any query, including an empty
 * one. That made the task a NULL CELL: it never tested whether the text an
 * agent typed actually landed, only whether it could reach a results page and
 * read a table. Round 3 measured a contender whose `fill` is a silent no-op
 * (`{"filled":true,"len":0}`) passing this 5/5 while navigating to `/found?q=`
 * — the empty query proving nothing was typed.
 *
 * Now the query FILTERS. An empty or non-matching `q` returns no rows, so the
 * answer is reachable only if "engineering" genuinely arrived in the field.
 * This makes the task strictly harder for both contenders.
 */
// TWO engineers on purpose. Filtering to a single row would have removed the
// other half of what this page probes — reading the RIGHT row out of a table,
// the shape that defeated prose extraction on a real booking site. The agent
// must now both get its text into the field and pick Grace Hopper out of two.
const STAFF = [
  { name: "Ada Lovelace", desk: "D-12", ext: "4471", dept: "mathematics" },
  { name: "Grace Hopper", desk: "B-04", ext: "4409", dept: "engineering" },
  { name: "Katherine Johnson", desk: "C-07", ext: "4488", dept: "engineering" },
  { name: "Alan Turing", desk: "A-19", ext: "4132", dept: "cryptography" },
];

const RESULTS = (q) => {
  const needle = String(q ?? "").trim().toLowerCase();
  const hits = needle ? STAFF.filter((s) => s.dept.includes(needle) || s.name.toLowerCase().includes(needle)) : [];
  if (hits.length === 0) {
    // Say WHY there is nothing, so a contender that typed nothing can tell the
    // difference between "no such department" and "my input never arrived".
    return page(
      "Results",
      `<h1>Results for "${needle}"</h1>
       <p>No staff matched${needle ? "" : " — no search term was submitted"}. Search by department.</p>`,
    );
  }
  return page(
    "Results",
    `<h1>Results for "${needle}"</h1>
     <table><tr><th>Name</th><th>Desk</th><th>Ext</th><th>Dept</th></tr>
     ${hits.map((s) => `<tr><td>${s.name}</td><td>${s.desk}</td><td>${s.ext}</td><td>${s.dept}</td></tr>`).join("")}
     </table>`,
  );
};

/** 5. VEIL IS KNOWN BAD HERE: a frameset with a JS-built menu and no hrefs.
 * Your router's admin UI is exactly this, and Veil reported ACTIONS (0). */
const FRAMESET = `<!doctype html><html><head><title>Console</title></head>
<frameset cols="200,*"><frame name="menu" src="/frame-menu"><frame name="body" src="/frame-body"></frameset></html>`;

/**
 * REVISED 2026-08-01: the billing document now lives at an OPAQUE path.
 *
 * It used to be `/frame-billing`, and round 3 showed the task was scoring the
 * wrong thing. Across five Veil runs the correlation was perfect: every win
 * GUESSED that URL from the visible label "Billing", every loss did not, and
 * no run ever clicked the menu — `veil_query name:"Billing"` returned 0
 * matches every time. The task measured whether a model infers a URL from a
 * label, not whether a tool can drive a JS-built frameset menu.
 *
 * `/f/9d41b7c2` cannot be derived from "Billing", so the only route to the
 * answer is actually dispatching that `<li onclick>`. Reading it out of this
 * script's own source would also be legitimate — that is real perception, not
 * a guess — but neither contender's text extraction returns script bodies.
 *
 * This makes the task strictly harder, and Veil is expected to LOSE it 0/5:
 * `listitem` is not a doer role, and stage 1 filters on ARIA role before
 * stage 2 can look for handlers.
 */
const BILLING_PATH = "/f/9d41b7c2";

const FRAME_MENU = page(
  "Menu",
  `<ul id="m"></ul>
   <script>
     var items=[['Overview','/frame-body'],['Billing','${BILLING_PATH}']];
     var ul=document.getElementById('m');
     items.forEach(function(it){
       var li=document.createElement('li'); li.textContent=it[0];
       li.style.cursor='pointer';
       li.onclick=function(){ parent.frames['body'].location=it[1]; };
       ul.appendChild(li);
     });
   </script>`,
);
const FRAME_BODY = page("Overview", `<h1>Overview</h1><p>Nothing to see here.</p>`);
const FRAME_BILLING = page(
  "Billing",
  `<h1>Billing</h1><p>Account balance is 8432 rupees.</p>`,
);

/** 6. VEIL IS KNOWN BAD HERE: the answer lives inside a same-origin IFRAME.
 * Veil reads only the top frame's AX tree. */
const IFRAME_HOST = page(
  "Dashboard",
  `<h1>Dashboard</h1><p>Reading below.</p><iframe src="/iframe-inner" width="500" height="200"></iframe>`,
);
const IFRAME_INNER = page("Meter", `<h2>Meter</h2><p>Current reading is 6193 units.</p>`);

const routes = {
  "/form": FORM,
  "/spa": SPA,
  "/search": SEARCH,
  "/frameset": FRAMESET,
  "/frame-menu": FRAME_MENU,
  "/frame-body": FRAME_BODY,
  [BILLING_PATH]: FRAME_BILLING,
  "/iframe": IFRAME_HOST,
  "/iframe-inner": IFRAME_INNER,
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;

  if (p === "/ordered") {
    const o = Object.fromEntries(url.searchParams);
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(
      page(
        "Order placed",
        `<h1>Order placed</h1><p>Reference <b>ORD-${(o.cust || "").length}${o.qty || 0}${(o.size || "x")[0]}</b></p>
         <p>Customer: ${o.cust ?? ""} · Quantity: ${o.qty ?? ""} · Size: ${o.size ?? ""}</p>`,
      ),
    );
  }
  if (p === "/found") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(RESULTS(url.searchParams.get("q") ?? ""));
  }
  if (p === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  const body = routes[p];
  if (!body) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end(page("Not found", "<h1>404</h1>"));
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(body);
});

const PORT = Number(process.env.PORT ?? 8080);
server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`arena fixtures on :${PORT}\n`);
});
