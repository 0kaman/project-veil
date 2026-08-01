/**
 * The lean view — the only thing that crosses the wire.
 *
 * Measured (DECISIONS 2026-07-25): listing every interactive node costs
 * 184–9,122 tokens depending on the page. Leading with DOERS and reducing links
 * to a count puts every page type in a 58–426 token band, because links are
 * navigation and navigation is what veil_search/veil_read are for.
 *
 * The withheld count is always stated. A capped view that looks complete is the
 * failure this whole project exists to design out.
 */
import { routeOf, type BehaviorGraph, type BehaviorNode, type FrameFacts } from "./model.js";

/** At most this many frame URLs are named before the list is capped — and the
 * cap is always stated, never applied silently. */
const MAX_FRAMES_LISTED = 8;

/**
 * What to say about child documents.
 *
 * Two rules, each with a precedent already in this file:
 *
 *   - ALWAYS count them when any exist (the LINKS rule): content that exists and
 *     is not in the graph gets counted, never silently dropped. ~12 tokens, and
 *     it bounds the noise on an ad-laden page to one true line.
 *   - NAME them when the page's content plainly lives there — a `<frameset>`, or
 *     nothing actionable here (the DIALOG rule): two signals, wide measured
 *     separation. `/frameset` reports body `FRAMESET` + 2 frames; `/form` and
 *     `/search` report `BODY` + 0.
 *
 * Measured burn this exists to stop: on the arena's `frameset` task an agent
 * spent 25 tool calls and 53,471 prompt tokens, ended mid-sentence in all five
 * runs, and two runs were reduced to GUESSING frame names ("let me try common
 * frame names like `top`, `main`, `leftFr…"). Chrome had the real names the
 * whole time, 0.65ms away. Hence "do NOT guess" — the same shape as the
 * BACKDROP note in session.ts, which exists for the same reason.
 *
 * The recovery named here is the one MEASURED to work: veil_open the frame's URL
 * then veil_read the session id it returns ("Account balance is 8432 rupees").
 * `veil_read <frame url>` reads better and returns `empty · 0 words` on these
 * very pages — advice that cannot be followed is worse than no advice.
 */
function frameSection(f: FrameFacts, doerCount: number): string[] {
  const out: string[] = [];
  const missing = f.readable.length - f.perceived;

  out.push("");
  if (f.perceived > 0) {
    out.push(
      // Not "their actions are listed above": a perceived frame may legitimately
      // contain nothing actionable, and promising a list that isn't there is the
      // small end of the same lie.
      `FRAMES (${f.total}) — ${f.perceived} child document(s) are perceived; anything ` +
        `actionable in them is listed above, tagged @frame.`,
    );
  } else {
    out.push(
      `FRAMES (${f.total}) — ${f.total} child document(s) whose content is NOT in this graph.`,
    );
  }

  // WHY THIS GATE IS WHAT IT IS. The first cut required `missing > 0`, on the
  // reasoning that a frame we entered needs no introduction. Entering a frame
  // and finding a doer in it are different things: the arena frameset's menu is
  // `<li onclick>`, which stage 1 does not treat as a doer, so both frames were
  // perceived, `missing` was 0, and the whole section collapsed to one line
  // while the page's only controls sat one document down, unnamed. The notice
  // was switched off by the perception fix that shipped beside it.
  //
  // So the trigger is the agent's actual predicament — NOTHING was surfaced to
  // act on and there are child documents — plus the original case of a frame we
  // could not enter on a page that is otherwise usable.
  if (doerCount === 0 || (missing > 0 && (f.frameset || f.perceived > 0))) {
    out.push(
      missing > 0 && f.perceived > 0
        ? `${missing} of them could NOT be entered (a per-build frame cap, or a document ` +
            `that would not answer), so their content is missing from the list above. ` +
            `All ${f.readable.length} child documents:`
        : f.perceived > 0
          ? // Entered, and still nothing to act on. Do not let that read as "the
            // page is empty": prose has no doers, and a control Veil cannot
            // classify (an onclick on a plain <li>, say) has none either.
            `${f.perceived === 1 ? "It was" : `All ${f.perceived} were`} entered, and nothing ` +
            `in ${f.perceived === 1 ? "it" : "them"} is actionable THAT VEIL CAN PERCEIVE — ` +
            `which is not the same as empty. The text is already in this session, and a ` +
            `control Veil cannot classify would not have appeared above. ` +
            `${f.perceived === 1 ? "The document" : "The documents"}:`
          : f.frameset
            ? `FRAMESET: this page has no content of its own — all of it is in the ` +
              `${f.readable.length} document(s) below, so "ACTIONS (0)" above means nothing is ` +
              `actionable HERE, not that the page is empty.`
            : `The content you are looking for is in one of these:`,
    );
    for (const fr of f.readable.slice(0, MAX_FRAMES_LISTED)) {
      out.push(`  ${fr.name || "(unnamed)"} → ${fr.url}`);
    }
    if (f.readable.length > MAX_FRAMES_LISTED) {
      out.push(`  … and ${f.readable.length - MAX_FRAMES_LISTED} more (veil_query for none of it — this list is capped here, not filtered)`);
    }
    // Two different recoveries, because the cheap one only exists once a frame
    // has actually been entered — its text is already composed into this
    // session's serialization, so veil_read(session) costs nothing extra.
    out.push(
      f.perceived > 0
        ? `That list is complete — do NOT guess frame names. Read their text with ` +
            `veil_read on THIS session id first; veil_open a frame's URL only if you ` +
            `need to act inside it.`
        : `That list is complete — do NOT guess frame names. To perceive one: veil_open ` +
            `its URL, then veil_read with the session id it returns.`,
    );
  }

  if (f.unreachable.length > 0) {
    // No silent degradation, and no invented recovery: there genuinely is none.
    out.push(
      `${f.unreachable.length} of these are CROSS-SITE (${f.unreachable
        .slice(0, 4)
        .join(", ")}) — Chrome isolates them into another process and does not expose ` +
        `them, so their content is missing here and there is NO recovery for it.`,
    );
  }
  return out;
}

export interface ProjectOptions {
  /** Max doers to list before truncating. Nothing measured needed this — 52 was
   * the worst case — but a design tool or spreadsheet could, and a silent cap is
   * forbidden. */
  maxDoers?: number;
}

function stateSuffix(n: BehaviorNode): string {
  const entries = Object.entries(n.state);
  if (entries.length === 0) return "";
  return ` {${entries.map(([k, v]) => (v === true ? k : `${k}:${v}`)).join(", ")}}`;
}

function line(n: BehaviorNode): string {
  const name = n.name ? ` "${n.name}"` : "";
  const value = n.value ? ` =${JSON.stringify(n.value)}` : "";
  const fires = n.fires ? `  → ${n.fires}` : "";
  const delegated = !n.fires && n.events.some((e) => e.delegated) ? "  → (delegated handler)" : "";
  // Name the verb, not just the effect — there is no button to click here.
  const how = n.submitOnly ? `  (action:"submit")` : "";
  // An affordance belongs on the NODE. "this control is in a child document"
  // changes what an agent should expect a click to affect, and it is invisible
  // if it lives only in a summary line further down.
  const frame = n.frame ? `  @frame ${routeOf(n.frame.url)}` : "";
  return `  ${n.id} [${n.role}]${name}${value}${stateSuffix(n)}${fires}${how}${delegated}${frame}`;
}

export function projectLean(graph: BehaviorGraph, opts: ProjectOptions = {}): string {
  const maxDoers = opts.maxDoers ?? 60;
  const out: string[] = [];

  out.push(`route: ${graph.meta.route}`);
  if (graph.meta.title) out.push(`title: ${graph.meta.title}`);
  // A dialog makes the rest of the page inert, so the nodes it hides are
  // correctly absent — but silence about that reads as the page breaking. In
  // all six recorded fare runs the agent typed into Google Flights' origin,
  // watched `combobox-where-to` disappear behind "Enter your origin", and
  // treated a modal it had just opened as a fault.
  if (graph.meta.dialog) {
    out.push(
      `DIALOG OPEN: "${graph.meta.dialog}" — the rest of the page is inert until it ` +
        `is resolved, so only what is listed below can be acted on. Anything that ` +
        `vanished is behind it, not gone.`,
    );
  }

  const doers = graph.doers.map((id) => graph.nodes.get(id)!).filter(Boolean);
  const shown = doers.slice(0, maxDoers);
  const withheld = doers.length - shown.length;

  out.push("");
  out.push(
    withheld > 0
      ? `ACTIONS (${shown.length} of ${doers.length} — ${withheld} withheld, veil_query for the rest)`
      : `ACTIONS (${doers.length})`,
  );
  // "nothing on this page is actionable" is FALSE on a page whose content lives
  // one document down, and it is the exact line the arena agent read before
  // burning 53k tokens guessing frame names. Qualify it with the reason.
  // The qualifier is about the CLAIM, not about whether entry succeeded. Asking
  // "did a frame fail to open?" was the wrong question: on the arena frameset
  // both frames opened, so this printed the unqualified "nothing on this page is
  // actionable" directly above "2 child document(s) are perceived" — together
  // asserting that we looked inside and the page is genuinely empty, while the
  // menu's <li onclick> controls sat in one of them. Any child document at all
  // makes the unqualified sentence a claim we cannot support.
  const frames = graph.meta.frames;
  if (shown.length === 0) {
    out.push(
      frames && frames.total > 0
        ? "  (none HERE — this page's content is in child documents; see FRAMES below)"
        : "  (none — nothing on this page is actionable)",
    );
  }
  for (const n of shown) out.push(line(n));

  if (frames && frames.total > 0) out.push(...frameSection(frames, doers.length));

  // Links are counted, never listed. This is the measured win: wikipedia's 1,008
  // links would be 9,000 tokens; the count is 12.
  if (graph.links.length > 0) {
    out.push("");
    out.push(`LINKS (${graph.links.length}) — veil_query(role:"link", name:"…") to list`);
  }

  return out.join("\n");
}
