/**
 * The arena task set — PRE-REGISTERED.
 *
 * Written and committed before either contender runs, because I helped build one
 * of them and would otherwise shade the set toward what it does well. Three
 * rules hold it honest:
 *
 *   1. Success is decided by a CHECKER over the final answer, never by the
 *      agent's own claim. Measured last week: an agent reported a fare it had
 *      not verified and steps it had not taken.
 *   2. Every task names the capability it probes, so a win is attributable.
 *   3. `veilExpected` records, in advance, how I expect Veil to do. Tasks marked
 *      "lose" are ones Veil is KNOWN to fail — cross-origin/iframe content and
 *      JS-built frameset menus. A suite that omits its own failures proves
 *      nothing, and pre-registering the expectation stops me reinterpreting a
 *      loss as a quirk afterwards.
 *
 * Browser tasks run against local fixtures so the result measures the tool and
 * not the weather. Search/read tasks necessarily use the live web — that tier is
 * the whole point of the full-suite comparison.
 */

export interface Task {
  id: string;
  /** What capability this isolates. */
  probes: string;
  prompt: string;
  /** Objective pass test over the agent's final answer. */
  check: (answer: string) => boolean;
  /** Honest prediction, recorded before the run. */
  veilExpected: "win" | "even" | "lose";
  /** Tool budget. Generous enough that a capable tool is not cut off. */
  maxSteps: number;
}

const has = (...res: RegExp[]) => (a: string) => res.every((r) => r.test(a));

/** The fixture host, as seen from inside the contender containers. */
export const FIXTURES = process.env.ARENA_FIXTURES ?? "http://fixtures:8080";

export const TASKS: Task[] = [
  // ── the ladder: answerable without a browser at all ──────────────────────
  {
    id: "fact",
    probes: "search tier — answerable from snippets, no browser needed",
    prompt:
      "What year was the Hubble Space Telescope launched? Answer with just the year and one sentence.",
    check: has(/\b1990\b/),
    veilExpected: "win",
    maxSteps: 12,
  },
  {
    id: "read",
    probes: "read tier — fetch + extract an article, no browser",
    prompt:
      "On the Wikipedia page https://en.wikipedia.org/wiki/HTTP , how many classes of HTTP status code are there, and what does the 5xx class mean? Answer briefly.",
    check: has(/\bfive\b|\b5\b/i, /server error/i),
    veilExpected: "win",
    maxSteps: 14,
  },

  // ── engine vs engine: a browser is genuinely required ─────────────────────
  {
    id: "form",
    probes: "act — fill three fields, submit, read the confirmation",
    prompt:
      `Go to ${FIXTURES}/form . Enter customer name "Ada", quantity 4, choose size Large, and place the order. ` +
      `Report the reference code shown on the confirmation page exactly.`,
    check: has(/ORD-34l/i),
    veilExpected: "even",
    maxSteps: 22,
  },
  {
    id: "spa",
    probes: "js-shell — content that exists only after JS runs",
    prompt:
      `Open ${FIXTURES}/spa and tell me the stock number and price of the Sprocket.`,
    check: has(/\b3\b/, /\b1250\b/),
    veilExpected: "even",
    maxSteps: 16,
  },
  {
    id: "submit",
    probes: "act — a search box with NO submit button (Enter is the only way)",
    prompt:
      `Go to ${FIXTURES}/search , search the staff directory for "engineering", and tell me Grace Hopper's desk and extension.`,
    check: has(/B-04/i, /4409/),
    veilExpected: "even",
    maxSteps: 20,
  },

  // ── tasks Veil is expected to LOSE. Included deliberately. ────────────────
  {
    id: "iframe",
    probes: "same-origin IFRAME content — Veil reads only the top frame's AX tree",
    prompt: `Open ${FIXTURES}/iframe and tell me the current meter reading.`,
    check: has(/\b6193\b/),
    veilExpected: "lose",
    maxSteps: 18,
  },
  {
    id: "frameset",
    probes: "frameset + JS-built menu with no hrefs — the router admin-UI shape",
    prompt:
      `Open ${FIXTURES}/frameset . Using the menu on the left, go to Billing and tell me the account balance.`,
    check: has(/\b8432\b/),
    veilExpected: "lose",
    maxSteps: 22,
  },

  // ── mixed: realistic, needs the ladder to choose correctly ───────────────
  {
    id: "mixed",
    probes: "full ladder — cheapest rung that answers, on the live web",
    prompt:
      "What port does PinchTab's local server listen on by default, and what is its default bind address? " +
      "Answer with the number and the address.",
    check: has(/\b9867\b/, /127\.0\.0\.1|localhost|loopback/i),
    veilExpected: "win",
    maxSteps: 14,
  },
];

export const TASK_IDS = TASKS.map((t) => t.id);
