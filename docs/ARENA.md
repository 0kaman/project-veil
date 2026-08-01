# Arena — Veil vs PinchTab

A head-to-head against [PinchTab](https://github.com/pinchtab/pinchtab), the closest
thing to a direct competitor: browser control for AI agents, accessibility-first,
token-efficient, MCP-native. Same premise, opposite architecture — PinchTab always boots
Chrome, Veil's whole bet is not booting one.

Rounds are recorded here, newest first, and older rounds are kept rather than edited —
their caveats are the reason the later ones exist.

---

# Round 4 — 2026-08-02, revised tasks, cold start per run

**80 cells, zero gating refusals, zero unreachable-page failures.** Three tasks were
rewritten because round 3 proved they measured the wrong thing; the new predictions were
committed before this ran (`820eff2`).

```
              pass     median tokens   median time   median calls    total tokens
veil         35/40         8,859          5.6s            3             852,808
pinchtab     19/40        55,049         20.4s            8           4,162,390
                       6.2× median                                   4.9× total
```

| task | veil | pinchtab | predicted | called? |
|---|---|---|---|---|
| `fact` | 5/5 · 4,724 | 5/5 · 36,472 | win | even on pass, 7.7× on cost |
| `read` | **5/5** · 63,955 | 1/5 · 168,234 | win | **yes** — but see caveats |
| `form` | **5/5** · 8,859 | **0/5** · 55,031 | even | finding 2 |
| `spa` | **5/5** · 5,819 | 2/5 · 35,435 | even | digit-slicing, as round 3 |
| `submit`\* | **5/5** · 8,048 | **0/5** · 193,044 | **win** | **yes** |
| `iframe` | 5/5 · 6,091 | 5/5 · 26,409 | lose | **falsified again**, drawn |
| `frameset`\* | **0/5** · 55,851 | **2/5** · 220,266 | lose | **yes — and Veil LOSES the cell** |
| `mixed`\* | **5/5** · 12,777 | 4/5 · 116,269 | win | narrowly |

\* revised for this round.

## What round 4 found

1. **Veil loses `frameset` outright, 0/5 against 2/5, and round 3 was hiding it.** With
   the target URL opaque, PinchTab wins by genuinely *driving the menu* — `pinchtab_frame`
   to enter the menu document, then `pinchtab_click selector:"text=Billing"`. No
   navigation to the opaque path. Veil went 0/5, and one run says out loud what it tried:
   *"I'll try opening the Billing page directly by guessing its URL."* It could not.

   In round 3 this cell read 2/5 vs 2/5 — a draw — but **both of Veil's wins were URL
   guesses**, so fixing my own broken task turned an apparent draw into a clean loss.
   That is the single most useful thing this round produced, and it is evidence against
   Veil's architecture, not for it: Veil filters the AX tree to `DOER_ROLES`, so a
   `<li onclick>` is not merely unnamed, it is **absent**. PinchTab can select by text
   and click whatever is there. The structured graph is cheaper *and* blinder, and this
   is the case where blinder wins.

2. **PinchTab's `fill` no-op, confirmed by a prediction rather than fitted to a result.**
   `submit` was re-registered `even → win` before the run on the round-3 evidence.
   Result: Veil 5/5 at 8,048, PinchTab **0/5, every answer empty, ~193,000 tokens each** —
   three times what the same task cost it in round 3, when a fixture that ignored the
   query handed it a pass at 63,187. `ORD-00l` appeared five more times in `form`, making
   **nine byte-identical occurrences across two rounds**, two container rebuilds and a
   restarted daemon.

3. **Fixing `mixed` helped PinchTab, which is the point.** 1/5 → 4/5 once the question
   stopped being about PinchTab's own config. The contamination was real and it was
   against them.

4. **Two session-length defects, one per contender, both invisible in the results table.**
   Veil leaked a ~900 MB Chrome tree per run (no reap on stdin EOF) until the container
   hit 7.1 GiB of 7.7 GiB and Chrome stopped starting — fixed, with Layer-2 tests.
   PinchTab's daemon stopped answering its own CLI after ~120 cumulative runs while its
   container looked healthy at 278 MB. **Both surfaced as "cannot reach the page", which
   is indistinguishable from a capability failure.** Two attempts at this round were
   discarded before the cause was found. Both containers now restart before every run.

## Caveats — round 4, all of them the author's

- **This measures clean-process capability, not endurance.** The per-run reset is what
  makes runs independent, which is what the median and spread already assume. Endurance
  is a real property of both tools and neither is measured here.
- **`read` may be a step-budget artifact, not capability.** All four PinchTab failures
  returned EMPTY after hitting `maxSteps: 14` at ~150–170k tokens. Veil answers in 3–4
  calls; PinchTab needs more per page, so a budget that is generous for one may bind on
  the other. The cell is reported as measured, but it should not be read as "PinchTab
  cannot read Wikipedia".
- **`frameset` is now a fair test and Veil fails it.** Reported here rather than buried:
  the previous version of this task flattered Veil and I only found out by checking the
  mechanism of its wins.
- **5 runs per cell.** `form` (0/5, byte-identical), `submit` (0/5, all empty) and
  `iframe` (5/5 both) are conclusive at this depth; single-run differences are not.
- **The fixtures, the agent loop and the history pruner are all mine.** Measured for this
  round: the pruner collapses 100% of Veil's large-result bytes and 63% of PinchTab's,
  because Veil's first line is a receipt and PinchTab's is JSON. That favours Veil on the
  token metric — though it cannot explain the gap, since Veil emits **3× more** tool-output
  bytes (650k vs 207k) and still costs 4.9× less in total. The gap decomposes as
  `schema × turns`: 1,313 × 3 vs 6,841 × 8.

---

# Round 3 — 2026-08-01, first ungated round (superseded by round 4 on three tasks)

> **`submit`, `frameset` and `mixed` below were rewritten for round 4** because this
> round proved they measured the wrong thing. Their numbers here are kept for the record
> and should not be cited. Every other cell stands.

**80 cells, zero gating refusals** (verified per-trace, error-shaped results only — not
prose matches; my first pass at that check flagged 10 traces and every one was the
`mixed` task *reading PinchTab's docs about IDPI*).

```
              pass     median tokens   median time   median calls    total tokens
veil         37/40         8,053          6.4s            3             771,315
pinchtab     22/40        55,025         19.9s            6           3,068,395
                       6.8× median                                   4.0× total
```

**Lead with the median, not the total.** The 4.0× total is dragged toward parity by
Veil's two expensive cells (`read`, `frameset`). The per-task medians cluster tightly —
7.7× / 2.3× / 6.2× / 6.1× / 7.8× / 4.3× / 4.0× / 7.4× — and that consistency is the
defensible claim. Before either agent acts, the tool schemas alone cost **1,313 vs 6,841
tokens per request (5.2×)**.

| task | veil | pinchtab | predicted | notes |
|---|---|---|---|---|
| `fact` | **5/5** · 4,724 | 5/5 · 36,472 | win | now fair — was 6/6 blocked in round 2 |
| `read` | **5/5** · 64,003 | 2/5 · 146,863 | win | PinchTab's 3 losses all hit max steps with an EMPTY answer |
| `form` | **5/5** · 8,862 | **0/5** · 55,025 | even | see finding 1 — deterministic, same wrong code 5/5 |
| `spa` | **5/5** · 5,819 | 2/5 · 35,429 | even | see finding 2 |
| `submit` | 5/5 · 8,053 | 5/5 · 63,187 | even | **NULL CELL — my fixture ignores the query** |
| `iframe` | **5/5** · 6,091 | 5/5 · 26,409 | **lose** | **prediction falsified — 0/5 → 5/5** |
| `frameset` | 2/5 · 55,441 | 2/5 · 219,983 | lose | **both wins were URL guesses; see finding 4** |
| `mixed` | **5/5** · 4,862 | 1/5 · 35,738 | win | contaminated for PinchTab; see caveats |

`veilExpected` is **not** edited. `iframe` was pre-registered as a predicted LOSS and Veil
won it — that is pre-registration doing its job, and rewriting it afterwards would destroy
the only thing that makes a prediction record worth keeping.

## What round 3 found

1. **PinchTab's `fill` reports success on a no-op, and its own receipt says so.**
   `{"result":{"filled":true,"len":0}}` — `filled: true` beside a field length of zero.
   Confirmed twice by *server-side* ground truth, not by reading the receipt:
   - `form`: the fixture builds its code as `ORD-{name.length}{qty}{size[0]}`. Expected
     `ORD-34l`; PinchTab returned **`ORD-00l`** on all five runs — name empty, quantity
     empty, size correct. The confirmation page read `Customer: · Quantity: · Size: large`.
   - `submit`: after `fill`, the browser navigated to **`/found?q=`** — an empty query.

   This is the mirror image of the `select` defect the round-2 arena found in **Veil**,
   which reported `ok` while printing `value=""`. Both tools shipped a success receipt
   carrying the evidence of its own failure. That symmetry is the point: it is why the
   receipt principle exists, and Veil's was caught only because someone read the receipt
   it printed.

2. **PinchTab's text extraction runs table cells together with no separator.** `/spa`
   returns `…Widget17499Sprocket31250Flange075`, so "stock 3, price 1250" is
   unrecoverable — the agent answered "312 and 50", "17499 and 3", "31 and 250" on
   different runs. Same defect class as the one Veil fixed in `denseExtract`
   (DECISIONS: `textContent` runs words together), on the other side of the fence.

3. **Veil's iframe fix is real, measured, 5/5** — at 4.3× less than PinchTab for the same
   answer. Round 2's 0/5 was the last measured number until now; this replaces it.

4. **`frameset` does not measure what it claims, and Veil's 2/5 is not a capability.**
   Across all five Veil runs the correlation is perfect: every win guessed the URL
   `/frame-billing`, every loss did not, and **no run ever clicked the menu** —
   `veil_query name:"Billing"` returned 0 matches every single time. `/frame-billing`
   appears nowhere in the prose Veil receives (it lives only in `<script>` source). The
   task is passable by inferring a URL from a label, so it scores guessing, not frame
   interaction. The underlying `listitem` defect is unfixed and confirmed by every run.

## Caveats — round 3, all of them the author's

- **`submit` is a null cell.** The fixture's `RESULTS(q)` ignores `q` and always returns
  all three staff rows, so the task never tested whether the typed text landed — only
  whether a contender could reach the results page and read a table. PinchTab's 5/5 here
  is *not* evidence its `fill` works; finding 1 shows it does not. Veil's `form` 5/5 is
  the real evidence that Veil's inputs land, since `ORD-34l` cannot be produced without
  all three fields arriving.
- **`mixed` is contaminated for PinchTab, one-sided.** The task asks PinchTab's own
  default port and bind address. PinchTab can answer by introspecting its running config
  — which *this arena* set to `0.0.0.0` — so run 2 returned "9867 0.0.0.0": the port
  right, and the bind scored wrong against a value the harness itself changed. Veil
  answers the same question from documentation and is unaffected. Treat PinchTab's 1/5
  as a floor, not a measurement.
- **`frameset` is guessable** (finding 4). Both contenders 2/5, so it is a null cell in
  the comparison either way.
- **5 runs per cell.** Better than round 2's 2–5, still thin. The `form` result (0/5,
  byte-identical wrong answer every run) and `iframe` (5/5 both sides) are the cells where
  5 runs are genuinely conclusive; single-run gaps elsewhere are not.
- **Three of the eight tasks turned out to be flawed** — `submit` null, `frameset`
  guessable, `mixed` self-referential. That is a worse hit rate than round 2's task set
  looked, because round 2's gating masked which cells were actually discriminating.

---

# Round 2 — 2026-07-31 (superseded; both contenders partly gated)

**Headline: Veil answered slightly more tasks for a quarter of the tokens, and loses
squarely on iframe content.** The more useful output was three defects the benchmark
found in Veil that a week of testing had not.

> **Superseded by round 3.** Every number below was measured with PinchTab's allowlist
> partly enforcing and is kept for the record, not for citation. The `iframe` 0/5 in
> particular is now 5/5 — see round 3, finding 3.

## Method

One agent loop (`@veil/playground`) drove both contenders. The only variable was which
stdio MCP server it was pointed at, so a difference in tokens or success is a difference
in the tool surface rather than in the harness.

- **Containers.** Three services on a private network: deterministic fixtures, Veil +
  Chromium, PinchTab + Chromium. Both spawned identically via `docker exec -i`, both
  running the *same* browser, both native arm64. Nothing installed on the host.
- **Interleaved** runs (task → contender → repeat), so a bad network minute lands on
  both rather than on whichever went second.
- **Checkers, not self-report.** Success is a regex over the final answer. An agent had
  previously claimed a fare it never verified.
- **Pre-registered tasks**, committed before either contender ran, each carrying a
  recorded prediction — including two Veil was expected to LOSE. A suite that omits its
  own failures proves nothing, and pre-registering stops the author reinterpreting a
  loss afterwards. The author built one of the two tools; every guard above points at
  him.

Reproduce: `pnpm --filter @veil/playground arena:up && arena:preflight && arena`

## Result — 61 scored runs

```
              pass      median tokens   median time      total tokens
veil        21/31         14,170          10,676ms          789,311
pinchtab    18/30         63,658          18,258ms        3,143,057
                                                    PinchTab spends 4.0×
```

| task | probes | veil | pinchtab | predicted | called? |
|---|---|---|---|---|---|
| `fact` | search tier, no browser needed | 2/2 · 4,724 | 2/2 · 26,244 | win | no — even ⚠ |
| `read` | read tier, fetch + extract | **5/5** · 63,955 | 1/5 · 146,432 | win | **yes** |
| `form` | fill three fields, submit | **2/2** · 8,862 | 0/2 · 246,053 | even | no — win |
| `spa` | content only after JS runs | **5/5** · 5,821 | 4/5 · 45,976 | even | no — win |
| `submit` | search box with no submit button | 5/5 · 12,422 | 5/5 · 63,640 | even | **yes** |
| `iframe` | same-origin iframe content | **0/5** · 16,352 | **5/5** · 26,514 | lose | **yes** |
| `frameset` | frameset + JS menu, no hrefs | 0/5 · 54,356 | 1/5 · 225,275 | lose | **yes** |
| `mixed` | full ladder on the live web | **2/2** · 4,888 | 0/1 · 74,014 | win | no — win |

**4 of 8 predictions called**, wrong in both directions — `spa` and `form` beat the
prediction, `fact` and `mixed` initially fell short of it.

## What it found in Veil

The real return on building this. None were caught by 144 hermetic + 47 integration
tests, or by a week of live playground runs.

1. **Veil could not run in a container at all.** Chrome refuses to start as root without
   `--no-sandbox` — the normal case inside an image — and the launcher never passed it.
   A capability gap next to a competitor that ships a Docker image. Fixed behind
   `VEIL_NO_SANDBOX=1`; not always-on, because the sandbox is a real defence precisely
   when Chrome renders hostile pages, which is Veil's whole job.
2. **`select` matched option VALUES while the graph advertises LABELS** — and reported
   `ok` for a select that set nothing. The agent passed `"Large"`, the option value was
   `"large"`, `.value` silently became `""`, and the form submitted without the field.
   Veil lost a task it should have drawn, 3 runs out of 3, with the same wrong answer.
   Its own value-echo receipt printed `value=""` while the code called it a success.
   Fixed; matches label or value, and refuses with the real options when neither hits.
3. **`veil_read` crashes on non-HTML content** — raw markdown gives
   `Cannot destructure property 'firstElementChild'`. Found while researching PinchTab's
   own docs. **Fixed 2026-08-01**, and the investigation found a worse silent half beside
   it: a text body carrying any stray tag reported `empty · 0 raw words` — RFC 7231's
   32,091 words read as zero. Verified by test; **the arena has not been re-run**, so
   every number above stands as measured.
4. **Same-origin iframe content was invisible** — the `iframe` loss below. **Fixed
   2026-08-01**: frames in the page's own renderer process are walked, spliced into the
   graph and the serialized HTML, and clickable. Cross-**site** frames still are not, and
   are now counted and named rather than silently absent. Verified by test — 66 Layer-2
   tests against real Chrome, and the fixture's `6193` now reaches the read — but **not
   re-measured in the arena**, so `0/5` remains the last measured number and
   `veilExpected: "lose"` is left alone. It is pre-registered.
5. **The frameset receipt was confidently wrong**, in two places. `veil_read` on a
   frameset URL said `empty · almost no readable text` and named no recovery while the
   bytes it held said `<frame src="/frame-menu">`; two of five runs acted on that and
   concluded the page was "served with a content type that isn't text". It now reports
   `frames`, names the documents, and escalates. Separately the lean view printed
   `(none — nothing on this page is actionable)`. **Both fixed. The `frameset` task will
   still fail**: its menu is `<li onclick>`, `listitem` is not a doer role, and
   `/frame-menu` opened directly already reported `ACTIONS (0)` with no frames involved.
   That is a separate, still-open defect.

Two of those fixes shipped a fresh instance of the fault they were written to remove, and
adversarial verification caught both before commit — the frame notice switched itself off
the moment perception landed, and the media-lane fix silently disabled escalation. Both
sat behind fixtures that modelled a scheme the code had stopped producing. See DECISIONS
2026-08-01.

## Where Veil loses

**`iframe`, 0/5 against 5/5.** Veil read only the top frame's AX tree, so same-origin
iframe content was invisible. Predicted in advance, and the cleanest capability gap in
the set. Fixed 2026-08-01 (#4 above) — but the arena was not re-run, so this row is the
last measured number and stands. `frameset` (JS-built menu, no hrefs) defeats both, 0/5 and 1/5 — that is the
shape of a real router admin UI, where Veil reports `ACTIONS (0)` on a page full of
controls.

## Caveats — all of them the author's

- **`fact` is compromised.** Measured across post-fix runs, PinchTab hit the IDPI
  allowlist on **6 of 6** `fact` runs (it kept reaching for `nasa.gov`, which was not
  listed). Every other task ran clean: `read` 0/4 blocked, `mixed` 0/7, and all five
  fixture tasks 0 blocked. So `fact` should not be read as a fair comparison.
- **An entire first round was void** — PinchTab blocked on 36 of 41 runs before the
  allowlist was configured at all, and Veil's `BRAVE_API_KEY` was empty in the container
  for all 80 runs of round two, disabling the first rung of its ladder. Both were
  harness errors. Both rounds were re-run or discarded, and preflight now hard-fails on
  an empty key inside the container.
- **`fact` and `read` are weak discriminators** — Mistral already knows those answers.
  The fixture tasks are the trustworthy ones: `ORD-34l`, `6193`, `8432` cannot be
  guessed, so passing them proves the tool did the work.
- **2–5 runs per cell** after the re-runs. Thin. The success gap (21/31 vs 18/30) is
  inside the noise and should not be read as a capability difference. The **cost** gap
  is 4× and consistent, and is the only headline worth defending.
- **PinchTab's `form` burns 246k tokens and fails 0/2, with zero allowlist blocks.** That
  thrashing is real behaviour, not a misconfiguration — and it is undiagnosed. Reporting
  a 28× cost gap without knowing its cause is a number, not a finding.

## Corrections

Recorded because this project withdraws wrong claims in writing rather than dropping
them quietly.

- Claimed "`fact`, `read` and `mixed` are tilted by my setup." **Too broad.** Measured
  per-task, only `fact` was still blocked after the allowlist fix.
- Scored Veil's `read` at 4/5. **Wrong — it is 5/5.** The checker demanded the literal
  phrase "server error" and one correct answer said "the server *failed* to fulfill a
  valid request". A false negative, and it fell against Veil. The checker now accepts
  server error / failed / side / 5xx. PinchTab's four `read` failures returned EMPTY
  answers and are genuine.
- Claimed a trailing dot in the blocked-domain list was "the smoking gun" for a broken
  FQDN match. **Wrong** — the dot was the end of the error sentence
  (`…not in allowlist: www.nasa.gov. To allow it, run:`) and the author's regex swallowed
  it. There was no FQDN bug.

## What PinchTab does better

Worth copying rather than dismissing:

- **43 tools to Veil's 8**, and correspondingly broader coverage — profiles with
  persistent auth, multi-instance orchestration, site audits, visual diffing, a
  dashboard, and real distribution (install script, Homebrew, Docker, npm).
- **Iframe content**, which Veil simply cannot see.
- **An untrusted-content wrapper on every page** — an explicit prompt-injection defence
  Veil has no equivalent of. Part of its token overhead is this, and it is principled.
- **Secure by default**: loopback bind, sensitive endpoints off, browsing restricted to
  local hosts until an operator widens it. That default is what tripped this benchmark
  twice, and they are right to ship it.
