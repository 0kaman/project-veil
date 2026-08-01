/**
 * Watch the arena, live, from another terminal.
 *
 *   pnpm --filter @veil/playground arena:watch
 *
 * Reads `traces/arena/live.json` (written atomically by the runner) and redraws
 * the shared dashboard once a second. It holds no state of its own and never
 * talks to the runner, so starting it late, killing it, or running three of
 * them changes nothing about the benchmark.
 */
import { resolve } from "node:path";
import { readLive, render } from "./live.js";

const DIR = resolve(import.meta.dirname, "../../../traces/arena");
const CLEAR = "\x1b[2J\x1b[H";

let missing = 0;

function tick(): void {
  const s = readLive(DIR);
  if (!s) {
    missing++;
    process.stdout.write(
      CLEAR +
        `\n  waiting for a run to start…\n  (${resolve(DIR, "live.json")})\n` +
        (missing > 10 ? "\n  nothing yet — is the arena running?\n" : "\n"),
    );
    return;
  }
  missing = 0;
  const stale = Date.now() - s.updatedAt;
  process.stdout.write(
    CLEAR +
      render(s) +
      (!s.finished && stale > 120_000
        ? `  ⚠ no update for ${Math.round(stale / 1000)}s — the current cell may be stuck\n`
        : ""),
  );
}

tick();
const timer = setInterval(tick, 1000);
process.on("SIGINT", () => {
  clearInterval(timer);
  process.stdout.write("\n");
  process.exit(0);
});
