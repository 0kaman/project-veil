# Arena — Veil vs PinchTab, 2026-07-31

A head-to-head against [PinchTab](https://github.com/pinchtab/pinchtab), the closest
thing to a direct competitor: browser control for AI agents, accessibility-first,
token-efficient, MCP-native. Same premise, opposite architecture — PinchTab always boots
Chrome, Veil's whole bet is not booting one.

**Headline: Veil answered slightly more tasks for a quarter of the tokens, and loses
squarely on iframe content.** The more useful output was three defects the benchmark
found in Veil that a week of testing had not.

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
veil        20/31         14,170          10,676ms          789,311
pinchtab    18/30         63,658          18,258ms        3,143,057
                                                    PinchTab spends 4.0×
```

| task | probes | veil | pinchtab | predicted | called? |
|---|---|---|---|---|---|
| `fact` | search tier, no browser needed | 2/2 · 4,724 | 2/2 · 26,244 | win | no — even ⚠ |
| `read` | read tier, fetch + extract | **4/5** · 63,955 | 1/5 · 146,432 | win | **yes** |
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
   own docs. **Still open.**

## Where Veil loses

**`iframe`, 0/5 against 5/5.** Veil reads only the top frame's AX tree, so same-origin
iframe content is invisible. Predicted in advance, and the cleanest capability gap in
the set. `frameset` (JS-built menu, no hrefs) defeats both, 0/5 and 1/5 — that is the
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
- **2–5 runs per cell** after the re-runs. Thin. The success gap (20/31 vs 18/30) is
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
