# Veil — Architecture

> **STATUS: building.** Design agreed 2026-07-15; v1's source was deleted on the
> `veil-reboot` branch and is preserved in git at `9e9f3e0`.
>
> **Slice 1 is built.** `@veil/read` (16 tests), `@veil/search` (12 tests, zero
> deps), `@veil/mcp` (6 tests, real transport), `@veil/playground` (2026-07-21) —
> Mistral drives the real stdio server, Claude-Code-style. End to end, live: a
> research task ran search → read → grounded answer in **5.7s / 7,554 tokens**,
> vs v1's 104s / 43,736 tokens on the same shape of task. The escalation metric
> (`pnpm play:analyse`) is built too. `@veil/core` has landed its FIRST slice —
> `Renderer.render(url)`, the browser as a renderer for the read tier: it turns a
> js-shell into real HTML (Reddit: fetch 6 words → render 1,722), WIRED into
> read's escalation (`via: render`). **Act path slice 1 (2026-07-25): the behavior
> graph** — AX tree → stable ids → event binding → doers-first projection.
> Measured live: github/login 8 doers in **189 tokens** (graph built in 13ms),
> wikipedia 23 doers + 1,043 links in **318 tokens**. **Slice 2: sessions** —
> memory-budgeted `SessionPool` (LRU eviction, not rejection) + `veil_open` /
> `veil_query` / `veil_sessions` / `veil_close` over MCP. **Slice 3: settle +
> `veil_do` + network capture** — actionable-surface settle, actionability checks
> that refuse with a reason, a diff instead of a re-dump, and interactions that
> teach the replay cache. **Slice 4: `veil_replay` + the config gate** —
> refresh-at-fire-time (not a TTL), `replay: off|safe|all` defaulting to `safe`,
> enforced at tool registration *and* again at fire time. Measured on a localhost
> fixture, one act+replay per fresh session, over two runs: median click
> **235–330ms → replay 4–6ms (~55–59×)** — a range, because one run is not a
> number. Not v1's 121×: different code, trivial server. Reproduce it with
> `pnpm --filter @veil/core bench:replay`.
> Replay also reports the desync it causes on single-use-token pages, and refuses
> to re-spend a token the server has confirmed is burned — on server evidence
> only, never inferred from a success, or it breaks the reusable-token schemes
> Django and Rails use (DECISIONS 2026-07-25 + its same-day amendment). **Eight tools
> live — the act path is complete.**
>
> The rule: this file describes what the code **actually does**, not what we
> hope. Drift between doc and code is a bug. Every number is measured — from v1,
> from design-time probes, or now from the built code.

## What Veil is

An **AI-first browser**. Not a browser with an AI bolted on — a machine that
perceives the web *for* an agent, with no human looking and no pixels rendered.

That distinction is the whole product. Dia, Comet, Atlas and Edge are Chromium
forks with an LLM beside the viewport: a human is still the user, the AI is a
passenger, and **every page must render because someone is watching**. They are
AI-*assisted*. Veil has no viewport, so it can decline to boot a browser at all —
a move they are structurally incapable of making.

## The one idea

**A browser is a fallback, not a foundation.**

Booting Chrome costs **969 MB, 8 processes and 2,116ms** before a single byte is
read, and caps concurrency at ~10 sessions. You need it for exactly one thing:
**when the bytes you want don't exist until JavaScript runs, or when the server
won't talk to anything that isn't a browser.** Everything else — fetching,
parsing, extracting — is cheaper without it, by a factor of ~32.

So every task starts as HTTP. The engine is summoned, never assumed.

## The ladder

Each rung is tried before the one below it. Costs are measured, not estimated.

| rung | how | cost | when |
|---|---|---|---|
| **SEARCH** | Brave API | ~200ms · ~900 tok | always first |
| **READ** | fetch → parse → extract | ~630ms · ~3k tok/page | a snippet isn't enough |
| **ACT** | Chrome + CDP + AX tree | ~2–4s · 969MB | you must click, type, or learn behaviour |
| **REPLAY** | captured request template | **4–6ms** (measured; 235–330ms for the click it replaces) | you've acted here once before |

`veil_read` also takes an **open session id**, not just a URL or a handle. After
`veil_do` drives a form to a results page, the answer is prose that exists only in
that tab — re-fetching the URL returns the empty form. That tier reports
`via: session`, and is deliberately never classified `js-shell`: the JS has already
run, so there is nothing above it to escalate to.

Search snippets are 40–68 words each; ten results is ~583 tokens of real prose
and **often answers the question outright**. v1's research session took 104.3s
and 43,736 tokens to answer worse.

## The three surfaces

### 1. `@veil/search` — Brave

Links + snippets. **Not content.** Brave's raw JSON is 26KB (~6,709 tokens) for
10 results; the useful projection (title, url, description, age) is ~900. Ship
the projection.

Free tier is **1 query/second, 2,000/month**. Searches cannot be parallelised —
cache aggressively; the same query is stable for hours. `extra_snippets` is a
paid feature and is **silently ignored** on free (HTTP 200, zero returned).

### 2. `@veil/read` — fetch + extract, no browser

```
fetch 490ms → linkedom 48ms → readability 89ms  = 627ms   (en.wikipedia.org/wiki/HTTP)
```

Returns the actual prose. 7,867 words, ~10k tokens, 91% of the HTML discarded as
nav/ads/boilerplate. The same page through the engine took **20,871ms** and
returned 800 nodes with **zero paragraphs**.

**Fallback extractor — Readability alone loses 10%.** Measured on 60 real pages:
Readability returned near-zero words on pages whose HTML *did* contain the text
(geeksforgeeks: 1,334 raw words → 0 kept). So: if Readability's output is thin
but the raw stripped text is high (≥~600 words), fall back to a denser extraction
rather than declaring failure. The receipt must separate "no content here" from
"extraction failed on content that's present" — the no-silent-degradation rule,
turned on our own extractor. Fixing this moves read-wins 57% → ~67%.

**Escalates to the engine on two triggers, never on a guess:**
1. **JS shell** — the content isn't in the HTML
2. **Doorman** — the server refuses non-browsers (Cloudflare, CAPTCHA)

**Candidate middle rung (unproven): a Chrome-*fingerprinted* fetch.** The doorman
17% is TLS-fingerprint-gated — curl and node-fetch both get 403 identically — and
headless Chrome's JA3 is identical to real Chrome's. So the gate is the
*fingerprint*, not the *engine*. A fetch carrying a real Chrome TLS/HTTP2
fingerprint might reclaim some doorman cases at ~700ms instead of a 969MB browser.
**Hypothesis — needs a real test against the observed 403 set before it earns a
rung.** If it works, doorman splits into reclaimable-cheaply and blocked-both-ways.

The test *is* the fetch. Word count separates cleanly: real articles are 2,253
and 7,867 words; a JS stub is 0, an app is 10, a marketing page is 97–485.
(Discard ratio does **not** separate — a real article discards 98%, a marketing
page 94.9%. It measures boilerplate, not success.)

**Budget: 4,000 words**, env-tunable. Chosen so typical pages arrive whole and
only long-form is cut. Beyond it, return an outline and a handle:

```
via: fetch · 627ms · 7,867 words · returned 4,000 · handle r1
title:   HTTP
outline: Overview · History · Message format · Status codes · Encryption
more:    veil_read("r1", query: "status codes")
```

The outline costs ~80 tokens and tells the model exactly what it's missing.

### 3. `@veil/core` — the engine

Unchanged in spirit; it is the good part. Raw CDP over WebSocket. The
accessibility tree as skeleton. **buildGraph is 211ms** — it was never the slow
part. `github.com/login` → 30 nodes, 1,013 tokens, with `POST /session` attached.

The graph stays **pure behaviour**. Prose comes only from `veil_read`. One
artifact, one job.

Stages 2 and 3 are the moat and nobody else has them:
- **Stage 2** — `DOMDebugger.getEventListeners` **returns `[]`** on GitHub's Sign
  in button. React delegates to the root; the markup tells you nothing. The Fiber
  walk and `enrichStructuralEvents` are what climb that wall.
- **Stage 3** — network correlation via async initiator stacks. This is what
  observed `/_next/data/…` (Next.js), PostHog's `/e/`, prebid's `auctionEnd` —
  runtime truth no document discloses.

## The tool surface

**Six verbs. The surface is the router** — no classifier, no intent model. The
LLM picks, which is the one thing LLMs are reliably good at.

```
veil_search(query)                 Brave → projected results     ~200ms
veil_read(url|handle, query?)      text, fetch-first             ~630ms
veil_open(url)                     engine session + summary       ~2–4s
veil_query(session, filter)        pull nodes from the cache      ~0
veil_do(session, node, action)     interact — and teach replay   ~150ms
veil_replay(session, node, edits)  fire the captured request     ~1–2ms
```

Descriptions are signposts, not documentation. `veil_read` says *"use this
first"*; `veil_open` says *"boots a browser — only when you need to act"*.

v1 shipped 8 tools and the model **never once** called `veil_query` — because
`veil_open` had already handed it everything. Fix the payload and the verb earns
its slot.

## The receipt — no silent degradation

**Every response declares what it did and what it doesn't have.**

```
via: fetch  · 627ms · 7,867 words · returned 4,000 · handle r1
via: engine · 4,120ms · js-shell · 800 of 1,828 nodes · 1,028 trimmed
via: fetch  · 272ms · 0 words · NO ARTICLE — likely JS-gated, try veil_open
via: —      · BLOCKED both ways · fetch got a CAPTCHA, engine was fingerprinted
```

This is the most important rule in the document, because **every failure in v1
was silence, not slowness**:

| the component knew | what it said |
|---|---|
| settle hit the cap, `pending:1` | nothing — `awaitQuiescence` discarded the verdict |
| prune trimmed 1,028 nodes | nothing — `nodesTrimmed` never reached the text |
| Stage 1 dropped every paragraph | nothing |
| the graph held no tech-stack evidence | *"per job postings"* |

A tool that fails is fine. A tool that fails quietly makes the model lie.

## Handle, not payload

The model's context is the scarce resource — v1's final call was **58,201 tokens
and took 73.8 seconds**. Everything returns a reference and a summary; the data
stays host-side and is pulled on demand.

It applies on **all three surfaces**, which is how you know it's the real
principle:

| surface | payload | handle |
|---|---|---|
| search | 6,709 tok (raw Brave JSON) | ~900 tok |
| read | 10k tok (whole article) | 4k + outline |
| open | 18k tok (whole graph) | ~200 tok + summary |

v1 shipped 43,736 tokens across 7 pages and used **zero** of them.

## The two flywheels

Both say the same thing: **pay the browser once, then never again for that site.**

```
veil_auth ──► one shared cookie jar ──► every later fetch is authenticated & cheap
veil_do   ──► request template      ──► every later call is replay: 1–2ms (121×)
```

One jar, shared by fetch and engine. Log in once with the browser; the cheap path
inherits the session. Click once with the browser; replay owns the endpoint. The
engine stops being infrastructure and becomes an **apprenticeship**.

## Politeness

```
global concurrent fetches   10     per-host   2  (+~300ms spacing)
timeout                     10s    retry      1× on 429/503, then report
User-Agent                  real Chrome, matching the real build
```

Ten results are usually ten domains, so per-host rarely binds — it's the brake
for when a task hammers one site.

**The tension, named:** politeness says identify as a bot; access says look like
Chrome. You cannot do both. Veil fetches pages a user explicitly asked for —
browser-equivalent, not crawling — so it sends a real Chrome UA and behaves well
(limits, backoff, honours 429). Strict `robots.txt` belongs to the crawler.

## Testing & the playground — two different jobs

They get conflated. They pull opposite ways, and both are load-bearing.

| | **playground** | **tests** |
|---|---|---|
| driver | you + an LLM, live | CI, nobody watching |
| finds | unknown-unknowns | known regressions |
| output | "huh, that's wrong" | pass / fail |
| cadence | exploration | every commit |

### The playground — `@veil/playground`

The receipt principle made **executable**: it is how a human watches the system
declare what it dropped. In v1 its episodic log is what caught the 12s cap that
hid for months — it is not garnish, it is the enforcement mechanism for the one
rule the whole design rests on. So it is built **alongside the first tool, not
after the sixth** — instrument before you change, the hardest-won lesson of v1.

Two modes:
- **raw** — `veil_read(url)` → see the receipt, no LLM. For checking one result.
- **goal-driven** — you give a goal, an LLM (Mistral) picks tools over the real
  MCP server, step-gated, every hop traced. For watching it reason.

It drives the **real** MCP server over stdio, never an in-process shortcut —
same reason as v1: an in-process path hides the protocol-level bugs the harness
exists to find.

**The metric that matters most: escalation rate — split by query class.** The
architecture bets most tasks stop at search/read and never boot Chrome. The
playground measures, continuously, what fraction reach the engine. The 2026-07-19
probe proved the **aggregate lies**: 30% escalation overall, but research 25% vs
commercial 60%. Reporting one number would have hidden the finding that the thesis
holds strongly for Veil's actual use case (research) and weakly for commerce. So
the metric is always reported per query class. Every episode also records tokens,
per-rung latency, and what each rung reported it was missing.

### The tests — the base is wide this time

v2 is far more testable than v1, because most of it doesn't need Chrome:

- **Layer 1 — hermetic, no Chrome.** The read path is a pure function,
  `HTML → extract`: capture real pages as fixtures once, assert extraction (and
  its **receipt** — word count, escalation trigger) against them. Golden files.
  Search is mocked (it must be — 66 real queries/day). This layer is the bulk.
- **Layer 2 — real Chrome, thin.** Only the engine path: `veil_open/do/replay`
  against local fixtures, plus the two escalation triggers (a JS-shell fixture,
  a doorman fixture). Auto-skips without Chrome.

Assert on the **receipt**, not just the payload — `{via, words, dropped}` — so a
test fails when the system stops telling the truth, not only when the data
changes.

## Known gaps

- **The doorman beats headless too.** Cloudflare fingerprints headless Chrome.
  When both rungs fail, Veil says so and stops. Stealth is not a workstream until
  it has to be — and note v1's disguise was actively broken: the UA claimed
  Chrome 131 on a 150 binary, and `--disable-gpu` removed WebGL entirely, which
  no real Mac Chrome does.
- **The settle cap still fires on the DOM half.** The network half is fixed
  (long-lived connections no longer pin it). `domQuiet` remains unreachable on
  animated pages — 12s per action on marketing sites. "Wait for quiet" is the
  wrong model, not a wrong constant.
- **Cross-origin iframes (OOPIF)** are not captured.
- **The crawler is parked** — see DECISIONS.

## Package layout

```
@veil/core        the engine. CDP + AX + the 5 stages. ZERO runtime deps.
@veil/read        fetch + linkedom + readability.        deps live HERE, not in core.
@veil/search      Brave client.                        thin.
@veil/mcp         the six verbs. the prime interface.
@veil/playground  Ink REPL + episodic trace. how you find out it's lying.
```

The zero-dep rule survives by **not applying** to `@veil/read` rather than by
being broken. Core stays small and auditable — it's the part holding your cookies.
