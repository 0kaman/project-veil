/**
 * Debug channel — silent by default, stderr when VEIL_DEBUG is set.
 *
 * The codebase deliberately degrades instead of crashing (a single flaky CDP
 * call must not kill a graph build), but degradation used to be INVISIBLE:
 * empty catch blocks meant a React page could silently declass to vanilla
 * grouping with no signal. Every intentional swallow now reports here.
 */
const enabled = !!process.env.VEIL_DEBUG;

export function debugLog(...args: unknown[]): void {
  if (!enabled) return;
  const parts = args.map((a) =>
    a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a),
  );
  process.stderr.write(`[veil] ${parts.join(" ")}\n`);
}
